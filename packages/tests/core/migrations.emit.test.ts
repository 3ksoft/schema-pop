/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import {
	defineMigration,
	diffPlans,
	emitTsMigration,
	fromModule,
	type MigrationHooks,
	resolveMigration,
	SchemaAnalyzer,
	type TsMigrationConfig,
} from "../../core/src";
import { binary, type LayoutPlan, Renamed } from "../../schema/src";

function analyze(s: any): LayoutPlan {
	return new SchemaAnalyzer().analyze(fromModule(s.export()), {
		version: "1.0.0",
	}).plan;
}

const CFG: TsMigrationConfig = {
	v1TypesImport: "./v1/schema",
	v2TypesImport: "./v2/schema",
	v1CodecImport: "./v1/codec",
	v2CodecImport: "./v2/codec",
	hooksImport: "./migrations.hooks",
};

function emit(
	v1: any,
	v2: any,
	hooks?: MigrationHooks,
	cfg: Partial<TsMigrationConfig> = {},
) {
	const plan = resolveMigration(diffPlans(analyze(v1), analyze(v2)), hooks);
	return emitTsMigration(plan, { ...CFG, ...cfg });
}

// A generated migration file must at least parse as valid TS.
function assertTranspiles(code: string) {
	const t = new Bun.Transpiler({ loader: "ts" });
	expect(() => t.transformSync(code)).not.toThrow();
}

describe("emitTsMigration", () => {
	test("rename + default + widen → transform body + byte wrapper", () => {
		const v1 = scope({
			...binary.import(),
			Battery: { voltage_mv: "u32", current: "u8" },
		});
		const v2 = scope({
			...binary.import(),
			Renamed,
			Battery: {
				voltage: "Renamed<u32, 'voltage_mv'>",
				current: "u16", // widened
				firmware: "u16 = 1", // new w/ default
			},
		});
		const code = emit(v1, v2);
		expect(code).toContain(
			"export function transformBattery(v1: V1.Battery): V2.Battery",
		);
		expect(code).toContain("voltage: v1.voltage_mv");
		expect(code).toContain("current: v1.current");
		expect(code).toContain("firmware: 1");
		// byte wrapper for a fixed-size struct
		expect(code).toContain(
			"export function migrateBattery(v1Bytes: Uint8Array): Uint8Array",
		);
		expect(code).toContain("__v1codec.deserializeBattery");
		expect(code).toContain("__v2codec.serializeBattery");
		expect(code).toContain("new Uint8Array(__v2codec.SIZEOF_Battery)");
		assertTranspiles(code);
	});

	test("per-field hook → indexes the hooks registry", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } }); // narrowed
		const hooks: MigrationHooks = {
			B: defineMigration<{ x: number }, { x: number }>({
				x: (v1) => v1.x & 0xffff,
			}),
		};
		const code = emit(v1, v2, hooks);
		expect(code).toContain("import { migrationHooks }");
		expect(code).toContain("(migrationHooks.B as any).x(v1)");
		assertTranspiles(code);
	});

	test("whole-type hook → delegates the whole transform", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		const hooks: MigrationHooks = {
			B: defineMigration<{ x: number }, { x: number }>((v1) => ({
				x: v1.x & 0xffff,
			})),
		};
		const code = emit(v1, v2, hooks);
		expect(code).toContain("return (migrationHooks.B as (v1: any) => any)(v1)");
		assertTranspiles(code);
	});

	test("nested changed struct → parent calls child transform", () => {
		const v1 = scope({
			...binary.import(),
			Inner: { a: "u8" },
			Outer: { inner: "Inner", tag: "u8" },
		});
		const v2 = scope({
			...binary.import(),
			Inner: { a: "u16" },
			Outer: { inner: "Inner", tag: "u8" },
		});
		const code = emit(v1, v2);
		expect(code).toContain("inner: transformInner(v1.inner as any)");
		expect(code).toContain("tag: v1.tag");
		assertTranspiles(code);
	});

	test("variable-size type → transform only, byte wrapper skipped with note", () => {
		const v1 = scope({ ...binary.import(), Msg: { body: "string", n: "u8" } });
		const v2 = scope({ ...binary.import(), Msg: { body: "string", n: "u16" } }); // widen
		const code = emit(v1, v2);
		expect(code).toContain("export function transformMsg");
		expect(code).toContain("skipped byte wrapper");
		expect(code).not.toContain("export function migrateMsg(");
		assertTranspiles(code);
	});

	test("emitByteWrappers:false → no migrate fns, no codec imports", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u8" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		const code = emit(v1, v2, undefined, { emitByteWrappers: false });
		expect(code).toContain("export function transformB");
		expect(code).not.toContain("export function migrateB");
		expect(code).not.toContain("__v1codec");
		assertTranspiles(code);
	});

	test("hooked plan without hooksImport → generation error", () => {
		const v1 = scope({ ...binary.import(), B: { x: "u32" } });
		const v2 = scope({ ...binary.import(), B: { x: "u16" } });
		const hooks: MigrationHooks = {
			B: defineMigration<{ x: number }, { x: number }>({ x: (v1) => v1.x }),
		};
		const plan = resolveMigration(diffPlans(analyze(v1), analyze(v2)), hooks);
		expect(() =>
			emitTsMigration(plan, { ...CFG, hooksImport: undefined }),
		).toThrow("config.hooksImport is required");
	});

	test("quotes non-identifier field and hook keys", () => {
		const plan = {
			from: { types: [] },
			to: { types: [] },
			types: [
				{
					kind: "fields",
					name: "Old-Type",
					toName: "New-Type",
					ops: [
						{ kind: "copy", to: "foo-bar", from: "old-name" },
						{ kind: "hookField", to: "hook-field" },
					],
				},
			],
			hookedTypes: ["New-Type"],
		} as any;
		const code = emitTsMigration(plan, { ...CFG, emitByteWrappers: false });
		expect(code).toContain('"foo-bar": v1["old-name"]');
		expect(code).toContain(
			'(migrationHooks["New-Type"] as any)["hook-field"](v1)',
		);
		assertTranspiles(code);
	});

	test("emits BigInt and special-number defaults as TypeScript literals", () => {
		const plan = {
			from: { types: [] },
			to: { types: [] },
			hookedTypes: [],
			types: [
				{
					kind: "fields",
					name: "B",
					toName: "B",
					ops: [
						{ kind: "defaultLiteral", to: "big", value: 1n },
						{ kind: "defaultLiteral", to: "nan", value: Number.NaN },
						{
							kind: "defaultLiteral",
							to: "inf",
							value: Number.POSITIVE_INFINITY,
						},
					],
				},
			],
		} as any;
		const code = emitTsMigration(plan, { ...CFG, emitByteWrappers: false });
		expect(code).toContain("big: 1n");
		expect(code).toContain("nan: Number.NaN");
		expect(code).toContain("inf: Number.POSITIVE_INFINITY");
		assertTranspiles(code);
	});
});
