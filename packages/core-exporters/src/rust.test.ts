/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations, SchemaAnalyzer } from "schema-pop";
import { rust } from "./rust";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

describe("rust exporter — generateMigration", () => {
	test("identical plans → no migration emitted", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v2",
		);
		const out = rust({ dest: "out.rs" }).generateMigration!(v1, v2);
		expect(out).toBe("");
	});

	test("ArkType default → emits literal in From impl", () => {
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
		const out = rust({ dest: "out.rs" }).generateMigration!(v1, v2);
		expect(out).toContain("impl From<v1::B> for v2::B");
		expect(out).toContain("fn from(v1: v1::B) -> Self");
		expect(out).toContain("x: v1.x,");
		expect(out).toContain("firmware: 7,");
	});

	test("Renamed field → reads old name", () => {
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
		const out = rust({ dest: "out.rs" }).generateMigration!(v1, v2);
		expect(out).toContain("voltage: v1.voltage_mv,");
	});

	test("Widening primitive → emits cast", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u8" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u16" } }),
			"v2",
		);
		const out = rust({ dest: "out.rs" }).generateMigration!(v1, v2);
		expect(out).toContain("x: v1.x as u16,");
	});

	test("Narrowing → comment hint, NO impl emitted", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u16" } }),
			"v2",
		);
		const out = rust({ dest: "out.rs" }).generateMigration!(v1, v2);
		expect(out).toContain("// schema-pop: write");
		expect(out).toContain("impl From<v1::B> for v2::B");
		// must NOT actually emit the impl block
		expect(out).not.toContain("fn from(v1:");
		expect(out).toContain("narrowing");
	});

	test("New field without default → Default::default()", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", flag: "bool" } }),
			"v2",
		);
		const out = rust({ dest: "out.rs" }).generateMigration!(v1, v2);
		expect(out).toContain("flag: Default::default(),");
	});
});
