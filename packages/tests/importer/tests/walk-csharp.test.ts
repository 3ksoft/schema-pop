import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "c_sharp");
}

describe("c# importer", () => {
	test("class with public properties and fields", async () => {
		const r = await ir(`
            public class Telemetry {
                public int Uptime { get; set; }
                public string Status;
                private int hidden;
            }
        `);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["Uptime", "Status"]);
			expect(s.fields["Uptime"]).toMatchObject({
				type: "number",
				binaryType: "i32",
			});
			expect(s.fields["Status"]).toMatchObject({ type: "string" });
		}
	});

	test("record structural typing", async () => {
		const r = await ir(`public record Telemetry(int Uptime, string Status);`);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["Uptime", "Status"]);
		}
	});

	test("enum extraction", async () => {
		const r = await ir(`public enum Status { Idle, Active }`);
		const e = r.items["Status"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Idle", "Active"]);
		}
	});

	test("arrays and lists", async () => {
		const r = await ir(`
            public class Data {
                public int[] Numbers { get; set; }
                public List<string> Labels;
            }
        `);
		const s = r.items["Data"]!;
		if (s.type === "object") {
			expect(s.fields["Numbers"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i32" },
			});
			expect(s.fields["Labels"]).toMatchObject({
				type: "array",
				item: { type: "string" },
			});
		}
	});
});
