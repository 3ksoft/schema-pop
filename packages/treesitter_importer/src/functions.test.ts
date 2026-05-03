/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkRustFile } from "./walk-rust";
import { walkCFile } from "./walk-c";
import { walkCppFile } from "./walk-cpp";
import { emitArktypeScope } from "./emit";

async function rustIR(src: string) {
	const t = await parseSource("rust", src);
	return walkRustFile(t, "<test>");
}
async function cIR(src: string) {
	const t = await parseSource("c", src);
	return walkCFile(t, "<test>");
}
async function cppIR(src: string) {
	const t = await parseSource("cpp", src);
	return walkCppFile(t, "<test>");
}

describe("function extraction — Rust", () => {
	test("free fn with primitive args + return", async () => {
		const r = await rustIR(`
            pub fn add(a: u32, b: u32) -> u32 { a + b }
        `);
		const fns = r.items.filter((i) => i.kind === "function");
		expect(fns).toHaveLength(1);
		const fn = fns[0]!;
		if (fn.kind !== "function") throw new Error();
		expect(fn.name).toBe("add");
		expect(fn.args.map((a) => a.name)).toEqual(["a", "b"]);
		expect(fn.args.map((a) => (a.type as any).name)).toEqual(["u32", "u32"]);
		expect((fn.returnType as any).name).toBe("u32");
		expect(fn.abi).toBeUndefined();
	});

	test("extern \"C\" function picks up abi", async () => {
		const r = await rustIR(`pub extern "C" fn cb(x: i32) {}`);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.abi).toBe("C");
		expect(fn.returnType).toEqual({ kind: "unsupported", raw: "()" });
	});

	test("foreign mod block applies abi to all signatures", async () => {
		const r = await rustIR(`
            extern "C" {
                pub fn libc_sleep(secs: u32) -> i32;
                pub fn libc_exit(code: i32);
            }
        `);
		const fns = r.items.filter((i) => i.kind === "function");
		expect(fns).toHaveLength(2);
		for (const fn of fns) {
			if (fn.kind !== "function") continue;
			expect(fn.abi).toBe("C");
		}
	});

	test("generic fn → skipped", async () => {
		const r = await rustIR(`pub fn id<T>(x: T) -> T { x }`);
		expect(r.items.filter((i) => i.kind === "function")).toHaveLength(0);
		expect(r.skipped[0]?.reason).toContain("generic");
	});

	test("doc-comment hoisted onto fn", async () => {
		const r = await rustIR(`
            /// Compute checksum.
            pub fn checksum(data: u32) -> u32 { 0 }
        `);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.description).toContain("Compute checksum");
	});
});

describe("function extraction — C", () => {
	test("prototype with primitives + void return", async () => {
		const r = await cIR(`void device_reset(uint32_t id);`);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.name).toBe("device_reset");
		expect(fn.args[0]).toEqual({
			name: "id",
			type: { kind: "primitive", name: "u32" },
		});
		expect(fn.returnType).toEqual({ kind: "unsupported", raw: "void" });
	});

	test("zero args (void) — empty args array", async () => {
		const r = await cIR(`uint32_t get_tick(void);`);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.args).toEqual([]);
		expect((fn.returnType as any).name).toBe("u32");
	});

	test("multiple args + reference return", async () => {
		const r = await cIR(`
            typedef struct { uint8_t x; } Battery;
            Battery* battery_get(uint32_t id, uint8_t flags);
        `);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.name).toBe("battery_get");
		expect(fn.args).toHaveLength(2);
		expect(fn.args[0]?.name).toBe("id");
		expect(fn.args[1]?.name).toBe("flags");
	});

	test("doc-comment hoisted (Doxygen /** ... */)", async () => {
		const r = await cIR(`
            /** Compute CRC. */
            uint32_t crc32(const uint8_t* data, uint32_t len);
        `);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.description).toContain("Compute CRC");
	});
});

describe("function extraction — C++", () => {
	test("free function in namespace", async () => {
		const r = await cppIR(`
            namespace okon {
                uint32_t do_thing(uint8_t x);
            }
        `);
		const fn = r.items.find((i) => i.kind === "function");
		if (!fn || fn.kind !== "function") throw new Error();
		expect(fn.name).toBe("do_thing");
		expect((fn.returnType as any).name).toBe("u32");
	});

	test("template function → silently skipped", async () => {
		const r = await cppIR(`
            template <typename T>
            T identity(T x) { return x; }
            uint32_t plain(uint8_t x);
        `);
		const fns = r.items.filter((i) => i.kind === "function");
		expect(fns.map((f) => f.name)).toEqual(["plain"]);
	});
});

describe("emit — functions block", () => {
	test("emits FunctionPlan[] export with primitives + ref types", async () => {
		const r = await cIR(`
            typedef struct { uint8_t x; } Battery;
            uint32_t battery_read(uint32_t id, Battery* out);
        `);
		const out = emitArktypeScope(r);
		expect(out).toContain('import type { FunctionPlan }');
		expect(out).toContain("export const functions: FunctionPlan[]");
		expect(out).toContain('name: "battery_read"');
		expect(out).toContain('symbol: "battery_read"');
		expect(out).toContain('kind: "primitive", name: "u32"');
		expect(out).toContain('kind: "reference", name: "Battery"');
	});

	test("no functions → no functions block + no FunctionPlan import", async () => {
		const r = await cIR(`typedef struct { uint8_t x; } Battery;`);
		const out = emitArktypeScope(r);
		expect(out).not.toContain("export const functions");
		expect(out).not.toContain("FunctionPlan");
	});

	test("Rust extern C → abi field set", async () => {
		const r = await rustIR(`pub extern "C" fn reset(id: u32) {}`);
		const out = emitArktypeScope(r);
		expect(out).toContain('abi: "C"');
	});

	test("void / () return → unit Field", async () => {
		const r1 = await cIR(`void reset(uint32_t id);`);
		expect(emitArktypeScope(r1)).toContain('returnType: { kind: "unit" }');
		const r2 = await rustIR(`pub fn reset(id: u32) {}`);
		expect(emitArktypeScope(r2)).toContain('returnType: { kind: "unit" }');
	});
});
