import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return importSource(src, "c");
}

describe("c importer — IR extraction", () => {
	test("typedef struct with stdint primitives", async () => {
		const r = await ir(`
            typedef struct {
                uint32_t voltage_mv;
                int32_t current_ma;
                uint8_t flags;
            } Battery;
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const it = r.items["Battery"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect(Object.keys(it.fields)).toEqual([
			"voltage_mv",
			"current_ma",
			"flags",
		]);
		expect((it.fields["voltage_mv"] as any).binaryType).toBe("u32");
		expect((it.fields["current_ma"] as any).binaryType).toBe("i32");
		expect((it.fields["flags"] as any).binaryType).toBe("u8");
	});

	test("named struct (without typedef)", async () => {
		const r = await ir(`
            struct RawFrame {
                uint16_t length;
                uint8_t channel;
            };
        `);
		const it = r.items["RawFrame"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect(Object.keys(it.fields)).toHaveLength(2);
	});

	test("typedef enum", async () => {
		const r = await ir(`
            typedef enum {
                DS_IDLE,
                DS_ACTIVE,
                DS_ERROR
            } DeviceStatus;
        `);
		const it = r.items["DeviceStatus"]!;
		expect(it.type).toBe("enum");
		if (it.type !== "enum") throw new Error();
		expect(it.options).toEqual(["DS_IDLE", "DS_ACTIVE", "DS_ERROR"]);
	});

	test("typedef alias to stdint primitive", async () => {
		const r = await ir(`typedef uint32_t DeviceId;`);
		const it = r.items["DeviceId"]!;
		expect(it.type).toBe("number");
		if (it.type !== "number") throw new Error();
		expect(it.binaryType).toBe("u32");
	});

	test("fixed array field", async () => {
		const r = await ir(`
            typedef struct {
                uint8_t bytes[16];
            } Serial;
        `);
		const it = r.items["Serial"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		const arr = it.fields["bytes"] as any;
		expect(arr.type).toBe("array");
		expect(arr.item).toMatchObject({ type: "number", binaryType: "u8" });
		expect(arr.exactLength).toBe(16);
	});

	test("references between user types", async () => {
		const r = await ir(`
            typedef struct {
                uint32_t x;
            } Inner;
            typedef struct {
                Inner inner;
            } Outer;
        `);
		const outer = r.items["Outer"];
		expect(outer).toBeDefined();
		if (outer?.type !== "object") throw new Error();
		expect(outer.fields["inner"]).toMatchObject({
			type: "link",
			target: "Inner",
		});
	});

	test("plain unambiguous primitives (float / double / boolean / char)", async () => {
		const r = await ir(`
            typedef struct {
                float a;
                double b;
                _Bool c;
                char d;
            } Mix;
        `);
		const it = r.items["Mix"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect((it.fields["a"] as any).binaryType).toBe("f32");
		expect((it.fields["b"] as any).binaryType).toBe("f64");
		expect((it.fields["c"] as any).binaryType).toBe("boolean");
		expect((it.fields["d"] as any).binaryType).toBe("u8");
	});

	test("function pointer / pointer / bitfield are skipped", async () => {
		const r = await ir(`
            typedef struct {
                int valid : 1;
                void (*callback)(int);
                int *next;
            } Quirky;
        `);
		const it = r.items["Quirky"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect(Object.keys(it.fields)).toHaveLength(0);
		expect(r.skipped.length).toBeGreaterThan(0);
	});

	test("doc comments hoisted", async () => {
		const r = await ir(`
            /** Battery payload. */
            typedef struct {
                /** Voltage. */
                uint32_t voltage_mv;
            } Battery;
        `);
		const it = r.items["Battery"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect(it.description).toContain("Battery payload");
		expect(it.fields["voltage_mv"]!.description).toContain("Voltage");
	});
});
