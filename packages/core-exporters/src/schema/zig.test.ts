/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations, SchemaAnalyzer } from "schema-pop";
import { zig } from "./zig";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

describe("zig exporter — generateMigration", () => {
	test("ArkType default → emits literal", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", firmware: "u16 = 11" } }),
			"v2",
		);
		const out = zig({ dest: "out.zig" }).generateMigration!(v1, v2);
		expect(out).toContain("pub fn migrate_B_v1_to_v2(src: v1.B) v2.B");
		expect(out).toContain(".firmware = 11,");
	});

	test("Renamed field reads from old name", () => {
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
		const out = zig({ dest: "out.zig" }).generateMigration!(v1, v2);
		expect(out).toContain(".voltage = src.voltage_mv,");
	});

	test("Narrowing → extern fn declaration only", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "v2");
		const out = zig({ dest: "out.zig" }).generateMigration!(v1, v2);
		expect(out).toContain("// schema-pop: implement");
		expect(out).toContain("pub extern fn migrate_B_v1_to_v2");
		expect(out).not.toContain(".x =");
	});
});
