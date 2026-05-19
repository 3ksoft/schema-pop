/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary } from "@schema-pop/schema";
import { rust } from "@schema-pop/exporter";
import { analyze } from "./utils";

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

describe("rust exporter — SharedString / SharedVec impls", () => {
	test("file header includes alloc-gated From impls", () => {
		const exp = rust({ dest: "out.rs" });
		const header = exp.getFileHeader!();
		expect(header).toContain(
			"impl<T: Default + Copy, const N: usize> From<&[T]>",
		);
		expect(header).toContain('#[cfg(feature = "alloc")]');
		expect(header).toContain("From<alloc::string::String>");
		expect(header).toContain("From<&alloc::string::String>");
		expect(header).toContain("From<alloc::vec::Vec<T>>");
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
