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
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v2",
		);
		const exp = ts({ dest: "out.ts" });
		const code = exp.generateMigration!(v1, v2);
		expect(code).toBe("");
	});

	test("ArkType default → emits literal in body", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
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
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u16" } }),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("status: user-supplied");
		expect(code).toContain("throw new Error");
		expect(code).toContain("requires a user-supplied impl");
		expect(code).toContain("narrowing");
	});

	test("Widening → simple passthrough", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u8" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u16" } }),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("status: auto");
		expect(code).toContain("x: v1.x");
		expect(code).not.toContain("throw");
	});

	test("New field without default → language-default emitted", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", flag: "bool" } }),
			"v2",
		);
		const code = ts({ dest: "out.ts" }).generateMigration!(v1, v2);
		expect(code).toContain("flag: false");
	});
});
