import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "dart");
}

describe("dart importer", () => {
	test("class with fields", async () => {
		const r = await ir(`
            class Telemetry {
                int uptimeMs;
                String status;
                int _privateVar;
            }
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptimeMs", "status"]);
			expect(s.fields["uptimeMs"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
		}
	});

	test("optionals and lists", async () => {
		const r = await ir(`
            class Config {
                List<int> items;
                String? note;
            }
        `);
		const s = r.items["Config"]!;
		if (s.type === "object") {
			expect(s.fields["items"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i64" },
			});
			expect((s.fields["note"] as any).required).toBe(false);
			expect(s.fields["note"]).toMatchObject({
				type: "string",
			});
		}
	});

	test("enum extraction", async () => {
		const r = await ir(`enum Status { idle, active }`);
		const e = r.items["Status"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["idle", "active"]);
		}
	});
});
