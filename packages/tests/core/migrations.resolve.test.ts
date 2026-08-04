/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import {
	defineMigration,
	diffPlans,
	fromModule,
	MigrationError,
	type MigrationHooks,
	resolveMigration,
	SchemaAnalyzer,
	type TypeMigration,
} from "../../core/src";
import { binary, type LayoutPlan, Renamed } from "../../schema/src";

function analyze(s: any): LayoutPlan {
	return new SchemaAnalyzer().analyze(fromModule(s.export()), {
		version: "1.0.0",
	}).plan;
}

function resolve(v1: any, v2: any, hooks?: MigrationHooks) {
	return resolveMigration(diffPlans(analyze(v1), analyze(v2)), hooks);
}

function typeMig(plan: { types: TypeMigration[] }, toName: string) {
	return plan.types.find(
		(t) =>
			("toName" in t && t.toName === toName) ||
			("name" in t && t.name === toName),
	);
}

describe("resolveMigration", () => {
	test("identical plans → identity, no hooks", () => {
		const s = scope({ ...binary.import(), B: { x: "u32", y: "u8" } });
		const plan = resolve(s, s);
		const b = typeMig(plan, "B");
		expect(b?.kind).toBe("identity");
		expect(plan.hookedTypes).toEqual([]);
	});

	test("field added with ArkType default → defaultLiteral op", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({
			...binary.import(),
			B: { x: "u32", firmware: "u16 = 5" },
		});
		const plan = resolve(v1, v2);
		const b = typeMig(plan, "B");
		if (b?.kind !== "fields") throw new Error("expected fields");
		const fw = b.ops.find((o) => o.to === "firmware");
		expect(fw).toEqual({ kind: "defaultLiteral", to: "firmware", value: 5 });
		const x = b.ops.find((o) => o.to === "x");
		expect(x).toEqual({ kind: "copy", to: "x", from: "x" });
	});

	test("field added primitive without default → defaultZero op", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u32", y: "u8" } });
		const plan = resolve(v1, v2);
		const b = typeMig(plan, "B");
		if (b?.kind !== "fields") throw new Error("expected fields");
		const y = b.ops.find((o) => o.to === "y");
		expect(y?.kind).toBe("defaultZero");
	});

	test("field renamed (auto) → copy from oldName", () => {
		const v1 = scope({ ...binary.import(), B: { voltage_mv: "u32" } });
		const v2 = scope({
			...binary.import(),
			Renamed,
			B: { voltage: "Renamed<u32, 'voltage_mv'>" },
		});
		const plan = resolve(v1, v2);
		const b = typeMig(plan, "B");
		if (b?.kind !== "fields") throw new Error("expected fields");
		expect(b.ops).toContainEqual({
			kind: "copy",
			to: "voltage",
			from: "voltage_mv",
		});
	});

	test("field widened → copy; removed field dropped", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u8", legacy: "u16" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		const plan = resolve(v1, v2);
		const b = typeMig(plan, "B");
		if (b?.kind !== "fields") throw new Error("expected fields");
		expect(b.ops).toContainEqual({ kind: "copy", to: "x", from: "x" });
		// `legacy` is removed → it never appears as an op.
		expect(b.ops.some((o) => o.to === "legacy")).toBe(false);
	});

	test("type-narrowed without hook → hard error (punch-list)", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		let err: MigrationError | undefined;
		try {
			resolve(v1, v2);
		} catch (e) {
			err = e as MigrationError;
		}
		expect(err).toBeInstanceOf(MigrationError);
		expect(err!.gaps).toHaveLength(1);
		expect(err!.gaps[0]!.type).toBe("B");
	});

	test("type-narrowed WITH per-field hook → hookField op, no throw", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		const hooks: MigrationHooks = {
			B: defineMigration<{ x: number }, { x: number }>({
				x: (v1) => Math.min(v1.x, 65535),
			}),
		};
		const plan = resolve(v1, v2, hooks);
		const b = typeMig(plan, "B");
		if (b?.kind !== "fields") throw new Error("expected fields");
		expect(b.ops).toContainEqual({ kind: "hookField", to: "x" });
		expect(plan.hookedTypes).toContain("B");
	});

	test("whole-type hook → wholeHook migration", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		const hooks: MigrationHooks = {
			B: defineMigration<{ x: number }, { x: number }>((v1) => ({
				x: Math.min(v1.x, 65535),
			})),
		};
		const plan = resolve(v1, v2, hooks);
		const b = typeMig(plan, "B");
		expect(b?.kind).toBe("wholeHook");
		expect(plan.hookedTypes).toContain("B");
	});

	test("nested struct composition → parent copyTransformed on changed child", () => {
		const v1 = scope({
			...binary.import(),
			Inner: { a: "u8" },
			Outer: { inner: "Inner", tag: "u8" },
		});
		const v2 = scope({
			...binary.import(),
			Inner: { a: "u16" }, // widened → Inner is dirty
			Outer: { inner: "Inner", tag: "u8" }, // own-unchanged, but references dirty Inner
		});
		const plan = resolve(v1, v2);

		const inner = typeMig(plan, "Inner");
		expect(inner?.kind).toBe("fields");

		const outer = typeMig(plan, "Outer");
		if (outer?.kind !== "fields")
			throw new Error("expected Outer fields (dirty by reference)");
		expect(outer.ops).toContainEqual({
			kind: "copyTransformed",
			to: "inner",
			from: "inner",
			refType: "Inner",
		});
		// scalar `tag` still a plain copy
		expect(outer.ops).toContainEqual({ kind: "copy", to: "tag", from: "tag" });
	});

	test("multiple gaps aggregate into one punch-list", () => {
		const v1 = scope({
			...binary.import(),
			B: { x: "u32", y: "u32" },
		});
		const v2 = scope({
			...binary.import(),
			B: { x: "u16", y: "f32" }, // narrowed + cross-family change
		});
		let err: MigrationError | undefined;
		try {
			resolve(v1, v2);
		} catch (e) {
			err = e as MigrationError;
		}
		expect(err).toBeInstanceOf(MigrationError);
		expect(err!.gaps.length).toBeGreaterThanOrEqual(2);
	});

	test("reorder cannot hide a narrowing on the same field", () => {
		const v1 = scope({ ...binary.import(), B: { a: "u32", b: "u32" } });
		const v2 = scope({ ...binary.import(), B: { b: "u32", a: "u8" } });
		expect(() => resolve(v1, v2)).toThrow(MigrationError);
	});

	test("non-struct to struct requires a whole-type hook", () => {
		const from = analyze(scope({ ...binary.import(), S: "u32" }));
		const to = analyze(scope({ ...binary.import(), S: { x: "u32" } }));
		expect(() => resolveMigration(diffPlans(from, to))).toThrow(MigrationError);
	});

	test("exact-length array without default requires a field hook", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u8" } });
		const v2 = scope({
			...binary.import(),
			B: { x: "u8", samples: "u32[] == 4" },
		});
		expect(() => resolve(v1, v2)).toThrow(MigrationError);
	});
});
