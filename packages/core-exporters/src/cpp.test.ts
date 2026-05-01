/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations, SchemaAnalyzer } from "schema-pop";
import { cpp } from "./cpp";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

describe("cpp exporter — generateMigration", () => {
	test("ArkType default → emits literal", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", firmware: "u16 = 7" } }),
			"v2",
		);
		const out = cpp({ dest: "out.cpp" }).generateMigration!(v1, v2);
		expect(out).toContain("void migrate_B_v1_to_v2(const v1::B *src, v2::B *dst)");
		expect(out).toContain("dst->firmware = 7;");
	});

	test("Renamed field → reads old name via src->", () => {
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
		const out = cpp({ dest: "out.cpp" }).generateMigration!(v1, v2);
		// cpp default field naming is camelCase, so voltage_mv → voltageMv
		expect(out).toContain("dst->voltage = src->voltageMv;");
	});

	test("Narrowing → declaration only, no body", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "v2");
		const out = cpp({ dest: "out.cpp" }).generateMigration!(v1, v2);
		expect(out).toContain("// schema-pop: implement");
		expect(out).toContain("void migrate_B_v1_to_v2");
		expect(out).not.toContain("dst->x =");
	});
});
