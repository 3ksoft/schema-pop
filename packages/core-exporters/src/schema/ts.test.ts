/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations, SchemaAnalyzer } from "schema-pop";
import { ts } from "./ts";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

describe("ts exporter — generateMigration", () => {
	test("identical plans → no migration emitted", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v2");
		const exp = ts({ dest: "out.ts" });
		const code = exp.generateMigration!(v1, v2);
		expect(code).toBe("");
	});

	test("ArkType default → emits literal in body", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({
				...binary.import(),
				B: { x: "u32", firmware: "u16 = 7" },
			}),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("function migrate_B_v1_to_v2");
		expect(code).toContain("x: v1.x");
		expect(code).toContain("firmware: 7");
		expect(code).toContain("status: auto");
	});

	test("Renamed field → emits read from old name", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { voltage_mv: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				...migrations.import(),
				B: { voltage: "Renamed<u32, 'voltage_mv'>" },
			}),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("voltage: v1.voltage_mv");
	});

	test("Narrowing → throw stub with reason", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "v2");
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("status: user-supplied");
		expect(code).toContain("throw new Error");
		expect(code).toContain("requires a user-supplied impl");
		expect(code).toContain("narrowing");
	});

	test("Widening → simple passthrough", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u8" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "v2");
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("status: auto");
		expect(code).toContain("x: v1.x");
		expect(code).not.toContain("throw");
	});

	test("New field without default → language-default emitted", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", flag: "bool" } }),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("flag: false");
	});
});

describe("ts exporter — per-variant Renamed (enum)", () => {
	test("emits switch-case mapping for renamed enum variant", () => {
		const v1 = analyze(
			scope({
				...binary.import(),
				Status: "'Idle' | 'Active' | 'Suspended'",
			}),
			"v1",
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				...migrations.import(),
				Status: "'Idle' | 'Active' | Renamed<'Sleep', 'Suspended'>",
			}),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("function migrate_Status_v1_to_v2");
		expect(code).toContain("switch (v1) {");
		expect(code).toContain('case "Suspended": return "Sleep";');
		expect(code).toContain("default: return v1 as unknown as");
	});
});

describe("ts exporter — dispatcher (no migrationsModule)", () => {
	test("dispatcher emitted in footer with overloads + impl", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", firmware: "u16 = 1" } }),
			"v2",
		);
		const exp = ts({ dest: "out.ts" });
		exp.generateMigration!(v1, v2);
		const footer = exp.getFileFooter!();
		expect(footer).toContain('export function migrate(typeName: "B"');
		expect(footer).toContain('from: "v1"');
		expect(footer).toContain('to: "v2"');
		expect(footer).toContain("value: v1.B): v2.B");
		expect(footer).toContain(
			"export function migrate(typeName: string, from: string, to: string, value: unknown): unknown",
		);
		expect(footer).toContain("migrations_v1_to_v2.migrate_B_v1_to_v2");
		expect(footer).toContain(
			"throw new Error(`schema-pop: no migration registered",
		);
	});

	test("no migrations → no footer emitted", () => {
		const exp = ts({ dest: "out.ts" });
		expect(exp.getFileFooter!()).toBe("");
	});
});

describe("ts exporter — user mapper integration", () => {
	test("with migrationsModule: header imports user module", () => {
		const exp = ts({
			dest: "out.ts",
			migrationsModule: "./user-migrations",
		});
		const header = exp.getFileHeader!();
		expect(header).toContain(
			'import * as __popUserMigrations from "./user-migrations"',
		);
	});

	test("auto field falls back to user mapper if present", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", firmware: "u16 = 1" } }),
			"v2",
		);
		const code = ts({
			dest: "out.ts",
			migrationsModule: "./user-migrations",
		}).generateMigration!(v1, v2);
		expect(code).toContain(
			"const u = ((__popUserMigrations as any).migrate_B_v1_to_v2 ?? {})",
		);
		// auto-derivable: user mapper is preferred but auto-expr is the fallback
		expect(code).toContain("u.x ? u.x(v1) : (v1.x)");
		expect(code).toContain("u.firmware ? u.firmware(v1) : (1)");
	});

	test("user-supplied required field: no auto fallback, throws if user impl missing", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "v2");
		const code = ts({
			dest: "out.ts",
			migrationsModule: "./user-migrations",
		}).generateMigration!(v1, v2);
		// With module configured: function body still proceeds (no top-level throw)
		// but the narrowing field lacks an auto fallback — the user mapper must
		// supply it, otherwise that single field throws.
		expect(code).toContain("u.x ? u.x(v1) :");
		expect(code).toContain("schema-pop: field 'x': narrowing");
		expect(code).not.toContain("requires a user-supplied impl"); // function-level throw is gone
	});

	test("withIndex: emits getIndex hook that re-exports each contributing schema", () => {
		const exp = ts({ dest: "out.ts", withIndex: true });
		expect(typeof exp.getIndex).toBe("function");
		const idx = exp.getIndex!([
			{ dest: "foo.ts", schemaName: "foo" },
			{ dest: "bar.ts", schemaName: "bar" },
		]);
		expect(idx["index.ts"]).toBe(
			'export * from "./foo";\nexport * from "./bar";\n',
		);
	});

	test("withIndex unset: getIndex hook is absent so builder skips barrel emit", () => {
		const exp = ts({ dest: "out.ts" });
		expect(exp.getIndex).toBeUndefined();
	});

	test("renamed alias type: dispatcher registers both old and new names", () => {
		const v1 = analyze(scope({ ...binary.import(), DeviceStatus: "u8" }), "v1");
		const v2 = analyze(
			scope({
				...binary.import(),
				...migrations.import(),
				// alias-level rename + widen to keep it auto-classified as
				// renamed (otherwise `unchanged` produces no fn)
				RuntimeStatus: "Renamed<u16, 'DeviceStatus'>",
			}),
			"v2",
		);
		const exp = ts({ dest: "out.ts" });
		exp.generateMigration!(v1, v2);
		const footer = exp.getFileFooter!();
		// dispatcher should register both names → same fn
		expect(footer).toContain('typeName === "DeviceStatus"');
		expect(footer).toContain('typeName === "RuntimeStatus"');
	});
});
