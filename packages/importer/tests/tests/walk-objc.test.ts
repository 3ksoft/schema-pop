import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "objc");
}

describe("objc importer", () => {
	test("interface with properties", async () => {
		const r = await ir(`
            @interface Telemetry : NSObject
            @property (nonatomic, assign) NSInteger uptime_ms;
            @property (nonatomic, strong) NSString *status;
            @property (assign) BOOL isActive;
            @end
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual([
				"uptime_ms",
				"status",
				"isActive",
			]);
			expect(s.fields["uptime_ms"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
			expect(s.fields["isActive"]).toMatchObject({
				type: "boolean",
				binaryType: "boolean",
			});
		}
	});

	test("handles c struct fallback", async () => {
		const r = await ir(`
            struct RawFrame {
                int length;
                float scale;
            };
        `);
		const s = r.items["RawFrame"]!;
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["length", "scale"]);
			expect(s.fields["length"]).toMatchObject({
				type: "number",
				binaryType: "i32",
			});
		}
	});

	test("handles simple enum", async () => {
		const r = await ir(`
            enum Status {
                StatusIdle,
                StatusActive
            };
        `);
		const e = r.items["Status"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["StatusIdle", "StatusActive"]);
		}
	});

	test("extracts doc comments", async () => {
		const r = await ir(`
            /// Device model
            @interface Device : NSObject
            /** Unique identifier */
            @property (nonatomic) NSInteger deviceId;
            @end
        `);
		const s = r.items["Device"]!;
		expect(s.description).toBe("Device model");
		if (s.type === "object") {
			expect(s.fields["deviceId"]!.description).toBe("Unique identifier");
		}
	});
});
