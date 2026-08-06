/// <reference types="@types/bun" />
import { describe, it, expect } from "bun:test";
import { type } from "arktype";
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import { binary } from "@schema-pop/schema";

function analyze(s: any) {
	return new SchemaAnalyzer().analyze(fromModule(s), {
		wordSize: "64",
		layout: "aligned",
		mode: "binary",
		version: "1.0.0",
		endian: "le",
	}).plan;
}

describe("fromModule — bitwise types", () => {
	it("extracts bitwise fields with bitSize", () => {
		const s = type.module({ ...binary.import(), Flags: { a: "u1", b: "u3", c: "u4" } });
		const schema = fromModule(s).schema;
		const flags = schema.types["Flags"] as any;
		expect(flags.fields.a.bitSize).not.toBeNull()
		expect(flags.fields.b.bitSize).not.toBeNull()
		expect(flags.fields.c.bitSize).not.toBeNull()
	});

	it("layout produces correct bitOffset and bitSize per field", () => {
		const s = type.module({ ...binary.import(), Flags: { a: "u1", b: "u3", c: "u4" } });
		const plan = analyze(s);
		const flags = plan.types.find((t) => t.name === "Flags");
		expect(flags?.kind).toBe("struct");
		if (flags?.kind !== "struct") return;

		const a = flags.fields.find((f) => f.name === "a");
		expect(a?.bitOffset).toBe(0);
		expect(a?.bitSize).toBe(1);

		const b = flags.fields.find((f) => f.name === "b");
		expect(b?.bitOffset).toBe(1);
		expect(b?.bitSize).toBe(3);

		const c = flags.fields.find((f) => f.name === "c");
		expect(c?.bitOffset).toBe(4);
		expect(c?.bitSize).toBe(4);
	});

	it("all bitfields in one byte have the same byte offset", () => {
		const s = type.module({ ...binary.import(), Flags: { a: "u1", b: "u3", c: "u4" } });
		const plan = analyze(s);
		const flags = plan.types.find((t) => t.name === "Flags");
		if (flags?.kind !== "struct") return;
		for (const f of flags.fields) {
			expect(f.offset).toBe(0);
		}
		expect(flags.size).toBe(1);
	});

	it("fields overflowing one byte go to the next byte", () => {
		// u5 + u5 = 10 bits → needs 2 bytes
		const s = type.module({ ...binary.import(), Wide: { x: "u5", y: "u5" } });
		const plan = analyze(s);
		const wide = plan.types.find((t) => t.name === "Wide");
		if (wide?.kind !== "struct") return;

		const x = wide.fields.find((f) => f.name === "x");
		const y = wide.fields.find((f) => f.name === "y");
		expect(x?.offset).toBe(0);
		expect(x?.bitOffset).toBe(0);
		expect(y?.offset).toBe(1);
		expect(y?.bitOffset).toBe(0);
		expect(wide.size).toBe(2);
	});
});
