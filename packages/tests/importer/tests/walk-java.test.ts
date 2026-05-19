import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return importSource(src, "java");
}

describe("java importer — walker", () => {
	test("class with fields → struct", async () => {
		const r = await ir(`
            public class Telemetry {
                public int uptime_ms;
                public String status;
            }
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptime_ms", "status"]);
			expect(s.fields["uptime_ms"]).toMatchObject({
				type: "number",
				binaryType: "i32",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
		}
	});

	test("record → struct", async () => {
		const r = await ir(
			`public record Telemetry(int uptime_ms, String status) {}`,
		);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptime_ms", "status"]);
		}
	});

	test("enum declaration → enum", async () => {
		const r = await ir(`public enum Severity { Info, Warn, Error }`);
		const e = r.items["Severity"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Info", "Warn", "Error"]);
		}
	});

	test("List<String> generic resolves to array", async () => {
		const r = await ir(`class I { public List<String> xs; }`);
		const s = r.items["I"]!;
		if (s.type === "object") {
			expect(s.fields["xs"]).toMatchObject({
				type: "array",
				item: { type: "string" },
			});
		}
	});
});
