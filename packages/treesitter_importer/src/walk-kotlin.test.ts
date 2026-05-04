import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkKotlinFile } from "./walk-kotlin";

async function ir(src: string) {
	const tree = await parseSource("kotlin", src);
	return walkKotlinFile(tree, "test.kt");
}

describe("kotlin importer", () => {
	test("data class with primary constructor properties", async () => {
		const r = await ir(`
            data class Telemetry(
                val uptimeMs: Int,
                var status: String
            )
        `);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["uptimeMs", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i32" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("class with body properties and optional types", async () => {
		const r = await ir(`
            class Config {
                val id: Long? = null
                var isActive: Boolean = false
            }
        `);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["id", "isActive"]);
			expect(s.fields[0]!.type).toEqual({ kind: "optional", inner: { kind: "primitive", name: "i64" } });
			expect(s.fields[1]!.type).toEqual({ kind: "primitive", name: "bool" });
		}
	});

	test("arrays and lists", async () => {
		const r = await ir(`
            class Matrix(
                val tags: List<String>,
                val bytes: ByteArray,
                val counts: IntArray
            )
        `);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({ kind: "array", item: { kind: "string" } });
			expect(s.fields[1]!.type).toEqual({ kind: "array", item: { kind: "primitive", name: "i8" } });
			expect(s.fields[2]!.type).toEqual({ kind: "array", item: { kind: "primitive", name: "i32" } });
		}
	});

	test("enum class", async () => {
		const r = await ir(`enum class Status { Idle, Active }`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map(v => v.name)).toEqual(["Idle", "Active"]);
		}
	});

	test("skips private classes and properties", async () => {
		const r = await ir(`
            private class Hidden {}
            class Visible {
                private val secret: Int = 1
                val publicValue: Int = 2
            }
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["publicValue"]);
		}
	});
});
