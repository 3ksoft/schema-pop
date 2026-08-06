import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "kotlin");
}

describe("kotlin importer", () => {
	test("data class with primary constructor properties", async () => {
		const r = await ir(`
            data class Telemetry(
                val uptimeMs: Int,
                var status: String
            )
        `);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptimeMs", "status"]);
			expect(s.fields["uptimeMs"]).toMatchObject({
				type: "number",
				binaryType: "i32",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
		}
	});

	test("class with body properties and optional types", async () => {
		const r = await ir(`
            class Config {
                val id: Long? = null
                var isActive: Boolean = false
            }
        `);
		const s = r.items["Config"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["id", "isActive"]);
			expect((s.fields["id"] as any).required).toBe(false);
			expect(s.fields["id"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect(s.fields["isActive"]).toMatchObject({
				type: "boolean",
				binaryType: "boolean",
			});
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
		const s = r.items["Matrix"]!;
		if (s.type === "object") {
			expect(s.fields["tags"]).toMatchObject({
				type: "array",
				item: { type: "string" },
			});
			expect(s.fields["bytes"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i8" },
			});
			expect(s.fields["counts"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i32" },
			});
		}
	});

	test("enum class", async () => {
		const r = await ir(`enum class Status { Idle, Active }`);
		const e = r.items["Status"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Idle", "Active"]);
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
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Visible"]!;
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["publicValue"]);
		}
	});
});
