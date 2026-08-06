import { describe, expect, test } from "bun:test";
import { parseSource } from "@schema-pop/parser";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "scala");
}

describe("scala importer", () => {
	test("case class maps to struct", async () => {
		const r = await ir(`
            case class Telemetry(uptimeMs: Int, status: String)
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
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

	test("class body vals", async () => {
		const r = await ir(`
            class Config {
                val items: Array[Int] = Array()
                var note: Option[String] = None
            }
        `);
		const s = r.items["Config"]!;
		if (s.type === "object") {
			expect(s.fields["items"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i32" },
			});
			expect(s.fields["note"]).toMatchObject({
				type: "string",
			});
			expect((s.fields["note"] as any).required).toBe(false);
		}
	});
});
