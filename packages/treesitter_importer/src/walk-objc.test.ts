import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkObjcFile } from "./walk-objc";

async function ir(src: string) {
	const tree = await parseSource("objc", src);
	return walkObjcFile(tree, "test.m");
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
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual([
				"uptime_ms",
				"status",
				"isActive",
			]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
			expect(s.fields[2]!.type).toEqual({ kind: "primitive", name: "bool" });
		}
	});

	test("handles c struct fallback", async () => {
		const r = await ir(`
            struct RawFrame {
                int length;
                float scale;
            };
        `);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["length", "scale"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i32" });
		}
	});

	test("handles simple enum", async () => {
		const r = await ir(`
            enum Status {
                StatusIdle,
                StatusActive
            };
        `);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual([
				"StatusIdle",
				"StatusActive",
			]);
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
		const s = r.items[0]!;
		expect(s.description).toBe("Device model");
		if (s.kind === "struct") {
			expect(s.fields[0]!.description).toBe("Unique identifier");
		}
	});
});
