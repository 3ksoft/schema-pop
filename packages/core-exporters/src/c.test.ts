/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations, SchemaAnalyzer } from "schema-pop";
import { c } from "./c";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

describe("c exporter — generateMigration", () => {
	test("uses prefixed type names + ArkType default literal", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", firmware: "u16 = 9" } }),
			"v2",
		);
		const out = c({ dest: "out.h" }).generateMigration!(v1, v2);
		expect(out).toContain(
			"void migrate_B_v1_to_v2(const v1_B *src, v2_B *dst)",
		);
		expect(out).toContain("dst->firmware = 9;");
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
		const out = c({ dest: "out.h" }).generateMigration!(v1, v2);
		expect(out).toContain("dst->voltage = src->voltage_mv;");
	});

	test("Narrowing → only declaration, no body", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "v2");
		const out = c({ dest: "out.h" }).generateMigration!(v1, v2);
		expect(out).toContain("/* schema-pop: implement");
		expect(out).not.toContain("dst->x =");
	});
});
