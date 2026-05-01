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

describe("rust exporter — enum emission", () => {
	test("plain enum emits #[repr(uN)] enum (not type alias + consts)", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				MacroLoopMode: "'HoldToLoop' | 'Loop' | 'Once'",
			}),
			"v1",
		);
		const out = rust({ dest: "out.rs" }).generate(plan) as string;
		expect(out).toContain("#[repr(u8)]");
		expect(out).toContain("pub enum MacroLoopMode {");
		expect(out).toContain("HoldToLoop = 0,");
		expect(out).toContain("Loop = 1,");
		expect(out).toContain("Once = 2,");
		// Old shape gone:
		expect(out).not.toContain("pub type MacroLoopMode = u8");
		expect(out).not.toContain("pub const MACRO_LOOP_MODE");
	});
});

describe("rust exporter — versionNamespace", () => {
	test("default: wrap in `pub mod <version>`", () => {
		const exp = rust({ dest: "out.rs" });
		const wrapped = exp.wrapVersion!("1.0", "pub struct Foo;\n");
		expect(wrapped).toContain("pub mod v1_0 {");
		expect(wrapped).toContain("use super::*;");
		expect(wrapped).toContain("pub struct Foo;");
	});

	test("`false`: no wrap, types emit at top level", () => {
		const exp = rust({ dest: "out.rs", versionNamespace: false });
		const wrapped = exp.wrapVersion!("1.0", "pub struct Foo;\n");
		expect(wrapped).toBe("pub struct Foo;\n");
		expect(wrapped).not.toContain("pub mod");
	});

	test("string: use given name verbatim", () => {
		const exp = rust({ dest: "out.rs", versionNamespace: "ws" });
		const wrapped = exp.wrapVersion!("1.0", "pub struct Foo;\n");
		expect(wrapped).toContain("pub mod ws {");
		expect(wrapped).not.toContain("pub mod v1_0");
	});
});
