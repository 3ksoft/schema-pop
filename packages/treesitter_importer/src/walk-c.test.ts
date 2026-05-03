/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkCFile } from "./walk-c";
import { emitArktypeScope } from "./emit";

async function ir(src: string) {
	const tree = await parseSource("c", src);
	return walkCFile(tree, "<test>");
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
		expect(r.items).toHaveLength(1);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.name).toBe("Battery");
		expect(it.fields.map((f) => f.name)).toEqual([
			"voltage_mv",
			"current_ma",
			"flags",
		]);
		expect(it.fields.map((f) => (f.type as any).name)).toEqual([
			"u32",
			"i32",
			"u8",
		]);
	});

	test("named struct (without typedef)", async () => {
		const r = await ir(`
            struct RawFrame {
                uint16_t length;
                uint8_t channel;
            };
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.name).toBe("RawFrame");
		expect(it.fields).toHaveLength(2);
	});

	test("typedef enum", async () => {
		const r = await ir(`
            typedef enum {
                DS_IDLE,
                DS_ACTIVE,
                DS_ERROR
            } DeviceStatus;
        `);
		const it = r.items[0]!;
		if (it.kind !== "enum") throw new Error();
		expect(it.name).toBe("DeviceStatus");
		expect(it.variants.map((v) => v.name)).toEqual([
			"DS_IDLE",
			"DS_ACTIVE",
			"DS_ERROR",
		]);
	});

	test("typedef alias to stdint primitive", async () => {
		const r = await ir(`typedef uint32_t DeviceId;`);
		const it = r.items[0]!;
		if (it.kind !== "alias") throw new Error();
		expect(it.name).toBe("DeviceId");
		expect(it.type).toEqual({ kind: "primitive", name: "u32" });
	});

	test("fixed array field", async () => {
		const r = await ir(`
            typedef struct {
                uint8_t bytes[16];
            } Serial;
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.fields[0]!.type).toEqual({
			kind: "array",
			item: { kind: "primitive", name: "u8" },
			exactLength: 16,
		});
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
		const outer = r.items.find(
			(i) => i.kind === "struct" && i.name === "Outer",
		);
		if (!outer || outer.kind !== "struct") throw new Error();
		expect(outer.fields[0]!.type).toEqual({ kind: "ref", name: "Inner" });
	});

	test("plain unambiguous primitives (float / double / bool / char)", async () => {
		const r = await ir(`
            typedef struct {
                float a;
                double b;
                _Bool c;
                char d;
            } Mix;
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.fields.map((f) => (f.type as any).name)).toEqual([
			"f32",
			"f64",
			"bool",
			"u8",
		]);
	});

	test("function pointer / pointer / bitfield are skipped", async () => {
		const r = await ir(`
            typedef struct {
                int valid : 1;
                void (*callback)(int);
                int *next;
            } Quirky;
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.fields).toHaveLength(0);
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
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.description).toContain("Battery payload");
		expect(it.fields[0]!.description).toContain("Voltage");
	});

	test("end-to-end emit", async () => {
		const r = await ir(`
            typedef struct {
                uint32_t voltage_mv;
                uint8_t flags;
            } Battery;
        `);
		const out = emitArktypeScope(r);
		expect(out).toContain("Battery: {");
		expect(out).toContain('voltage_mv: "u32"');
		expect(out).toContain('flags: "u8"');
	});
});
