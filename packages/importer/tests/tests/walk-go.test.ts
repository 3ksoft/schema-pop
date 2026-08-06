import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return importSource(src, "go");
}

describe("go importer", () => {
	test("struct with exported fields", async () => {
		const r = await ir(`
            type Telemetry struct {
                Uptime int
                Status string
                hidden int
            }
        `);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["Uptime", "Status"]);
			expect(s.fields["Uptime"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect(s.fields["Status"]).toMatchObject({ type: "string" });
		}
	});

	test("alias type", async () => {
		const r = await ir(`type DeviceId uint32`);
		const a = r.items["DeviceId"]!;
		expect(a.type).toBe("number");
		if (a.type === "number") {
			expect(a.binaryType).toBe("u32");
		}
	});

	test("slices and pointers", async () => {
		const r = await ir(`
            type Config struct {
                Items []int
                Matrix [16]byte
                Ref *Config
            }
        `);
		const s = r.items["Config"]!;
		if (s.type === "object") {
			expect(s.fields["Items"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i64" },
			});
			expect(s.fields["Matrix"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "u8" },
				minLength: 16,
			});
			expect(s.fields["Ref"]).toMatchObject({
				type: "link",
				target: "Config",
			});
			expect((s.fields["Ref"] as any).required).toBe(false);
		}
	});
});
