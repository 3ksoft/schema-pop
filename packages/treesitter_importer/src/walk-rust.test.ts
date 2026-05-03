/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { parseRust } from "./parser";
import { walkRustFile } from "./walk-rust";
import { emitArktypeScope } from "./emit";

async function ir(src: string) {
	const tree = await parseRust(src);
	return walkRustFile(tree, "<test>");
}

describe("rust importer — IR extraction", () => {
	test("plain repr(C) struct → primitive fields", async () => {
		const r = await ir(`
            #[repr(C)]
            pub struct Battery {
                pub voltage_mv: u32,
                pub current_ma: i32,
                pub flags: u8,
            }
        `);
		expect(r.items).toHaveLength(1);
		const it = r.items[0]!;
		expect(it.kind).toBe("struct");
		if (it.kind !== "struct") return;
		expect(it.name).toBe("Battery");
		expect(it.repr).toEqual(["C"]);
		expect(it.fields.map((f) => f.name)).toEqual([
			"voltage_mv",
			"current_ma",
			"flags",
		]);
		expect(it.fields.map((f) => f.type)).toEqual([
			{ kind: "primitive", name: "u32" },
			{ kind: "primitive", name: "i32" },
			{ kind: "primitive", name: "u8" },
		]);
	});

	test("fixed-size array field", async () => {
		const r = await ir(`
            pub struct Serial {
                pub bytes: [u8; 16],
            }
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.fields[0]!.type).toEqual({
			kind: "array",
			item: { kind: "primitive", name: "u8" },
			exactLength: 16,
		});
	});

	test("Option<T> and Vec<T>", async () => {
		const r = await ir(`
            pub struct Bundle {
                pub maybe: Option<u32>,
                pub samples: Vec<i16>,
            }
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.fields[0]!.type).toEqual({
			kind: "optional",
			inner: { kind: "primitive", name: "u32" },
		});
		expect(it.fields[1]!.type).toEqual({
			kind: "array",
			item: { kind: "primitive", name: "i16" },
		});
	});

	test("enum with all-unit variants → repr captured", async () => {
		const r = await ir(`
            #[repr(u8)]
            pub enum Status {
                Idle,
                Active,
                Suspended,
            }
        `);
		const it = r.items[0]!;
		expect(it.kind).toBe("enum");
		if (it.kind !== "enum") return;
		expect(it.repr).toEqual(["u8"]);
		expect(it.variants.map((v) => ({ kind: v.kind, name: v.name }))).toEqual([
			{ kind: "unit", name: "Idle" },
			{ kind: "unit", name: "Active" },
			{ kind: "unit", name: "Suspended" },
		]);
	});

	test("type alias", async () => {
		const r = await ir(`pub type DeviceId = u32;`);
		const it = r.items[0]!;
		expect(it.kind).toBe("alias");
		if (it.kind !== "alias") return;
		expect(it.name).toBe("DeviceId");
		expect(it.type).toEqual({ kind: "primitive", name: "u32" });
	});

	test("doc comments hoisted onto items + fields", async () => {
		const r = await ir(`
            /// Battery info packet.
            pub struct Battery {
                /// Voltage in millivolts.
                pub voltage_mv: u32,
            }
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.description).toContain("Battery info packet");
		expect(it.fields[0]!.description).toContain("Voltage in millivolts");
	});

	test("generic struct → skipped with reason", async () => {
		const r = await ir(`pub struct Wrapper<T> { pub inner: T }`);
		expect(r.items).toHaveLength(0);
		expect(r.skipped).toHaveLength(1);
		expect(r.skipped[0]!.name).toBe("Wrapper");
		expect(r.skipped[0]!.reason).toContain("generic");
	});

	test("references between types preserved as ref kind", async () => {
		const r = await ir(`
            pub struct Inner { pub v: u32 }
            pub struct Outer { pub inner: Inner }
        `);
		const outer = r.items.find(
			(i) => i.kind === "struct" && i.name === "Outer",
		);
		if (!outer || outer.kind !== "struct") throw new Error();
		expect(outer.fields[0]!.type).toEqual({ kind: "ref", name: "Inner" });
	});
});

describe("rust importer — emit arktype scope", () => {
	test("end-to-end emit produces parseable arktype scope", async () => {
		const r = await ir(`
            #[repr(C)]
            pub struct Battery {
                pub voltage_mv: u32,
                pub flags: u8,
            }
            #[repr(u8)]
            pub enum Status { Idle, Active }
            pub type Id = u32;
        `);
		const out = emitArktypeScope(r);
		expect(out).toMatch(/import \{ scope,\s+binary \} from "schema-pop"/);
		expect(out).toContain("Battery: {");
		expect(out).toContain('voltage_mv: "u32"');
		expect(out).toContain('flags: "u8"');
		expect(out).toContain("Status: \"'Idle' | 'Active'\"");
		expect(out).toContain('Id: "u32"');
	});

	test("Option<T> emits as optional key", async () => {
		const r = await ir(`pub struct B { pub x: Option<u32> }`);
		const out = emitArktypeScope(r);
		expect(out).toContain('"x?": "u32"');
	});

	test("fixed-size array uses arktype `[] == N` syntax", async () => {
		const r = await ir(`pub struct S { pub bytes: [u8; 16] }`);
		const out = emitArktypeScope(r);
		expect(out).toContain('bytes: "u8[] == 16"');
	});

	test("skipped items appear as comment block", async () => {
		const r = await ir(`pub struct Wrapper<T> { pub inner: T }`);
		const out = emitArktypeScope(r);
		expect(out).toContain("Skipped");
		expect(out).toContain("Wrapper");
	});
});
