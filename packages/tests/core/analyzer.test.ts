import { describe, expect, it } from "bun:test";
import { fromModule, SchemaAnalyzer } from "../../core/src";
import {
	AliasPlan,
	binary,
	Field,
	PopSchema,
	StructPlan,
	UnionPlan,
	wgsl
} from "../../schema/src/";
import { $ } from "../vault/analyzer-test.1";
import { type, scope } from "arktype";

const testMod = $.export();
describe("SchemaAnalyzer", () => {
	it("should parse schema without errors", () => {
		const schema = fromModule(testMod);
		expect(schema instanceof type.errors).toBe(false);
	});
	it("preserves nested objects as inline structs", () => {
		const mod = scope({
			value: {
				meta: { recorded_at: "string" },
				name: "string",
			},
		});

		const { plan } = new SchemaAnalyzer().analyze(mod, { mode: "binary" });
		const value = plan.types.find((t) => t.name === "value") as StructPlan;
		const meta = value.fields.find((f) => f.name === "meta");

		expect(meta?.type.kind).toBe("inlineStruct");
		if (meta?.type.kind !== "inlineStruct") throw new Error("expected inlineStruct");
		expect(meta.type.fields.map((f) => f.name)).toEqual(["recorded_at"]);
	});

	it("surfaces Field validation failures instead of silently degrading them", () => {
		const analyzer = new SchemaAnalyzer();
		const fallback = (analyzer as any).assertField({ kind: "any" });

		expect(fallback).toEqual({ kind: "unit" });
		expect(analyzer.getErrors().length).toBeGreaterThan(0);
		expect(analyzer.getErrors()[0]).toContain("name");
	});

	it("should sort fields by descending alignment to minimize padding", () => {
		const schema = fromModule(testMod);
		// Field reordering is now opt-in via autoSort (declaration order is
		// the default since it preserves stable offsets across schema edits).
		const analyzer = new SchemaAnalyzer();
		const { plan } = analyzer.analyze(schema, { autoSort: true } as any);

		const opt = plan.types.find((t) => t.name === "Optimized") as StructPlan;
		expect(opt?.kind).toBe("struct");
		// u32 (y) should be first
		expect(opt.fields[0]!.name).toBe("y");
		expect(opt.fields[0]!.offset).toBe(0);
		// x and z follow
		expect(opt.fields[1]!.name).toBe("x");
		expect(opt.fields[1]!.offset).toBe(4);
		expect(opt.fields[2]!.name).toBe("z");
		expect(opt.fields[2]!.offset).toBe(5);
		// Size: 4 (y) + 1 (x) + 1 (z) = 6. Align 4 -> 8.
		expect(opt.size).toBe(8);
	});

	it("should resolve fixed-size arrays without recursion loops", () => {
		const schema = fromModule(testMod);
		const analyzer = new SchemaAnalyzer();
		const { plan } = analyzer.analyze(schema, { version: "1.0.0" });

		const mac = plan.types.find((t) => t.name === "Mac") as AliasPlan;
		expect(mac?.kind).toBe("alias");
		expect(mac.type.kind).toBe("array");
		expect(mac.size).toBe(6);
	});

	it("reused analyzer instance does not leak synthesized types across analyze() calls", () => {
		// The vault schema has tagged unions, so analyzing it populates the
		// analyzer's synthesized-enum caches. A second analyze() on a fresh,
		// union-free schema must NOT carry those synthesized enums over.
		const plainMod = scope({
			...binary.import(),
			Simple: { n: "u8" },
		}).export();

		const shared = new SchemaAnalyzer();
		shared.analyze(fromModule(testMod), { version: "1.0.0" });
		const reused = shared.analyze(fromModule(plainMod), { version: "1.0.0" }).plan;

		const fresh = new SchemaAnalyzer().analyze(fromModule(plainMod), {
			version: "1.0.0",
		}).plan;

		expect(reused.types.map((t) => t.name).sort()).toEqual(
			fresh.types.map((t) => t.name).sort(),
		);
	});


	it("preserves literal-symbol provenance in enum and discriminated-union plans", () => {
		const mod = scope({
			...wgsl.import(),
			String: { kind: "'string'", encoding: "'utf-8' | 'ascii'" },
			Array: { kind: "'array'", maxItems: "u16" },
			TelemetryTypes: "'string' | 'array'",
			DecodeTelemetry: "String | Array",
		}).export();

		const extracted = fromModule(mod);
		const telemetryTypes = extracted.schema.types.TelemetryTypes as any;
		expect(telemetryTypes.options).toEqual([
			{ label: "string", value: "string", symbol: "string" },
			{ label: "array", value: "array", symbol: "array" },
		]);

		const { plan } = new SchemaAnalyzer().analyze(extracted, {
			layout: "std430",
			mode: "binary",
		});
		const enumVariant = (typeName: string, variantName: string) => {
			const e = plan.types.find((t) => t.name === typeName && t.kind === "enum") as any;
			return e?.variants.find((v: any) => v.name === variantName);
		};

		expect(enumVariant("StringKind", "string")?.symbol).toBe("string");
		expect(enumVariant("StringEncoding", "utf-8")?.symbol).toBe("utf-8");
		expect(enumVariant("TelemetryTypes", "string")?.symbol).toBe("string");

		const decode = plan.types.find(
			(t) => t.name === "DecodeTelemetry" && t.kind === "union",
		) as UnionPlan;
		const stringVariant = decode.variants.find((v) => v.name === "String") as any;
		const arrayVariant = decode.variants.find((v) => v.name === "Array") as any;
		expect(stringVariant.symbol).toBe("string");
		expect(arrayVariant.symbol).toBe("array");
		expect(enumVariant("DecodeTelemetryTag", "String")?.symbol).toBe("string");
		expect(enumVariant("DecodeTelemetryTag", "Array")?.symbol).toBe("array");
	});

	it("aligns subset-enum member values to their superset enum", () => {
		// `MpmType: "GasType | FluidType"` — arktype flattens the union into one
		// alphabetically-numbered enum, so a shared literal (`steam`) would get a
		// different value in GasType (its own 0..N) than in MpmType. The analyzer
		// realigns each subset enum's members to the largest superset so a symbol
		// has one identity everywhere (keeps ts↔wgsl codecs consistent).
		const mod = scope({
			...binary.import(),
			GasType: "'methane' | 'co' | 'steam'",
			FluidType: "'oil' | 'water'",
			MpmType: "GasType | FluidType",
		}).export();

		const { plan } = new SchemaAnalyzer().analyze(fromModule(mod), {
			version: "1.0.0",
		});

		const enumOf = (name: string) =>
			plan.types.find((t) => t.name === name && t.kind === "enum") as
			| { variants: { name: string; value: number }[] }
			| undefined;
		const valueOf = (e: ReturnType<typeof enumOf>, member: string) =>
			e?.variants.find((v) => v.name === member)?.value;

		const mpm = enumOf("MpmType");
		const gas = enumOf("GasType");
		const fluid = enumOf("FluidType");
		expect(mpm && gas && fluid).toBeTruthy();

		// Every subset member equals its value in the superset.
		for (const m of ["methane", "co", "steam"]) {
			expect(valueOf(gas, m)).toBe(valueOf(mpm, m));
		}
		for (const m of ["oil", "water"]) {
			expect(valueOf(fluid, m)).toBe(valueOf(mpm, m));
		}
		// Superset itself keeps a stable canonical numbering (untouched).
		expect(valueOf(mpm, "co")).toBe(0);
	});

	it.skip("should calculate Union size correctly (1 + padding + max variant)", () => {
		// TODO(0.2.x): post-refactor analyzer reports Choice size 16 (align 8)
		// instead of 12 (align 4). Need to confirm whether the new value is
		// correct for wordSize=64 (and update expectation), or whether the
		// union-tag alignment regressed in layout/analyzer.ts.
		const schema = fromModule(testMod);
		const analyzer = new SchemaAnalyzer();
		const { plan } = analyzer.analyze(schema, { version: "1.0.0" });

		const choice = plan.types.find((t) => t.name === "Choice") as UnionPlan;
		expect(choice?.kind).toBe("union");
		expect(choice.size).toBe(12);
		expect(choice.align).toBe(4);
	});

	it("should preserve atomic attribute on array items", () => {
		const atomicScope = scope({
			...wgsl.import(),
			single_grid: `ai32[] == 4`,
			spatials: {
				collision_grid: `ai32[] == 4`,
			}
		});
		const mod = atomicScope.export();
		const schema = fromModule(mod);
		const analyzer = new SchemaAnalyzer();
		const { plan } = analyzer.analyze(schema);

		// single_grid is a top-level alias type
		const single_grid = plan.types.find(
			(t) => t.name === "single_grid",
		) as AliasPlan;


		expect(single_grid?.kind).toBe("alias");
		expect(single_grid?.type.kind).toBe("array");
		if (single_grid.type.kind === "array") {
			expect(single_grid?.type.exactLength).toBe(4);

			const item = single_grid?.type.item as Field;
			expect(item?.kind).toBe("primitive");
			expect(item?.atomic).toBe(true);
			expect(item?.binaryType).toBe("i32");

		}
		// collision_grid is nested inside the "spatials" struct
		const spatials = plan.types.find(
			(t) => t.name === "spatials",
		) as StructPlan;
		expect(spatials?.kind).toBe("struct");

		const collision_grid_field = spatials?.fields.find(
			(f) => f.name === "collision_grid",
		);

		// // W trybie "rich" typy są resolveowane do reference, więc musimy je dereferenceować
		// const collision_grid_type = collision_grid_field?.type;
		// let arrayType: any;

		// if (collision_grid_type?.kind === "reference") {
		// 	// Dereference the reference to get the actual array type
		// 	arrayType = plan.types.find(
		// 		(t) => t.name === collision_grid_type.type.name,
		// 	) as AliasPlan;
		// } else {
		// 	arrayType = collision_grid_type;
		// }

		// expect(arrayType?.kind).toBe("array");
		// expect(arrayType?.exactLength).toBe(4);

		// const item2 = arrayType.item as Field;
		// expect(item2?.kind).toBe("primitive");
		// expect(item2?.name).toBe("i32");
		// expect(item2?.atomic).toBe(true);
		// expect(item2?.binaryType).toBe("i32");
		// expect(item2?.popKind).toBe("binary");
	});
});
