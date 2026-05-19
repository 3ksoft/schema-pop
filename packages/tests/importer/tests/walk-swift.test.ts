import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "swift");
}

describe("swift importer", () => {
	test("struct with properties", async () => {
		const r = await ir(`
            struct Telemetry {
                var uptimeMs: Int
                let status: String
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

	test("optional and arrays", async () => {
		const r = await ir(`
            class Config {
                var items: [Int]
                var note: String?
                var fallback: Optional<Bool>
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
			expect((s.fields["fallback"] as any).required).toBe(false);
			expect(s.fields["fallback"]).toMatchObject({
				type: "boolean",
				binaryType: "bool",
			});
		}
	});

	test("enum extraction", async () => {
		const r = await ir(`enum Status { case Idle; case Active }`);
		const e = r.items["Status"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Idle", "Active"]);
		}
	});

	test("typealias", async () => {
		const r = await ir(`typealias DeviceId = UInt32`);
		const a = r.items["DeviceId"]!;
		expect(a.type).toBe("number");
		if (a.type === "number") {
			expect(a.binaryType).toBe("u32");
		}
	});
});
