/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations, SchemaAnalyzer } from "schema-pop";
import { ts } from "./ts";
import { rust } from "./rust";
import { c } from "./c";
import { cpp } from "./cpp";
import { zig } from "./zig";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

const v1 = analyze(
	scope({
		...binary.import(),
		Battery: { voltage_mv: "u32", current: "i32" },
	}),
	"v1",
);
const v2 = analyze(
	scope({
		...binary.import(),
		...migrations.import(),
		Battery: {
			voltage: "Renamed<u32, 'voltage_mv'>",
			current: "i32",
			firmware: "u16 = 1",
		},
	}),
	"v2",
);
const v3 = analyze(
	scope({
		...binary.import(),
		Battery: {
			voltage: "u16", // narrowing
			current: "i32",
			firmware: "u16 = 1",
		},
	}),
	"v3",
);

describe("migrations e2e — same diff drives every language", () => {
	test("v1 → v2 (rename + default) is auto in every target", () => {
		const targets = {
			ts: ts({ dest: "x.ts" }),
			rust: rust({ dest: "x.rs" }),
			c: c({ dest: "x.h" }),
			cpp: cpp({ dest: "x.cpp" }),
			zig: zig({ dest: "x.zig" }),
		};
		for (const [name, t] of Object.entries(targets)) {
			const out = t.generateMigration!(v1, v2);
			expect(out).not.toBe("");
			// Status line should say auto
			expect(out).toContain("status: auto");
			// No throw stubs / user-supplied hints
			expect(out).not.toContain("schema-pop: write");
			expect(out).not.toContain("schema-pop: implement");
			expect(out).not.toContain("requires a user-supplied impl");
		}
	});

	test("v2 → v3 (narrowing) is user-supplied in every target", () => {
		const targets = {
			ts: ts({ dest: "x.ts" }),
			rust: rust({ dest: "x.rs" }),
			c: c({ dest: "x.h" }),
			cpp: cpp({ dest: "x.cpp" }),
			zig: zig({ dest: "x.zig" }),
		};
		for (const [name, t] of Object.entries(targets)) {
			const out = t.generateMigration!(v2, v3);
			expect(out).not.toBe("");
			// Either a stub (TS) or a hint comment (Rust/C/C++/Zig)
			const isStubbed =
				out.includes("requires a user-supplied impl") ||
				out.includes("schema-pop: write") ||
				out.includes("schema-pop: implement");
			expect(isStubbed).toBe(true);
		}
	});
});
