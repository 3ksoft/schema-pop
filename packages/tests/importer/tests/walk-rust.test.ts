import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return importSource(src, "rust");
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
		const it = r.items["Battery"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") return;
		expect(Object.keys(it.fields)).toEqual([
			"voltage_mv",
			"current_ma",
			"flags",
		]);
		expect((it.fields["voltage_mv"] as any).binaryType).toBe("u32");
		expect((it.fields["current_ma"] as any).binaryType).toBe("i32");
		expect((it.fields["flags"] as any).binaryType).toBe("u8");
	});

	test("fixed-size array field", async () => {
		const r = await ir(`
            pub struct Serial {
                pub bytes: [u8; 16],
            }
        `);
		const it = r.items["Serial"]!;
		if (it.type !== "object") throw new Error();
		expect(it.fields["bytes"]).toMatchObject({
			type: "array",
			item: { type: "number", binaryType: "u8" },
			minLength: 16,
		});
	});

	test("Option<T> and Vec<T>", async () => {
		const r = await ir(`
            pub struct Bundle {
                pub maybe: Option<u32>,
                pub samples: Vec<i16>,
            }
        `);
		const it = r.items["Bundle"]!;
		if (it.type !== "object") throw new Error();
		expect(it.fields["maybe"]).toMatchObject({
			type: "number",
			binaryType: "u32",
			required: false,
		});
		expect(it.fields["samples"]).toMatchObject({
			type: "array",
			item: { type: "number", binaryType: "i16" },
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
		const it = r.items["Status"]!;
		expect(it.type).toBe("enum");
		if (it.type !== "enum") return;
		expect(it.options).toEqual(["Idle", "Active", "Suspended"]);
	});

	test("type alias", async () => {
		const r = await ir(`pub type DeviceId = u32;`);
		const it = r.items["DeviceId"]!;
		expect(it.type).toBe("number");
		if (it.type !== "number") return;
		expect(it.binaryType).toBe("u32");
	});

	test("doc comments hoisted onto items + fields", async () => {
		const r = await ir(`
            /// Battery info packet.
            pub struct Battery {
                /// Voltage in millivolts.
                pub voltage_mv: u32,
            }
        `);
		const it = r.items["Battery"]!;
		if (it.type !== "object") throw new Error();
		expect(it.description).toContain("Battery info packet");
		expect(it.fields["voltage_mv"]!.description).toContain(
			"Voltage in millivolts",
		);
	});

	test("generic struct → skipped with reason", async () => {
		const r = await ir(`pub struct Wrapper<T> { pub inner: T }`);
		expect(Object.keys(r.items)).toHaveLength(0);
		expect(r.skipped).toHaveLength(1);
		expect(r.skipped[0]!.name).toBe("Wrapper");
		expect(r.skipped[0]!.reason).toContain("generic");
	});

	test("references between types preserved as link type", async () => {
		const r = await ir(`
            pub struct Inner { pub v: u32 }
            pub struct Outer { pub inner: Inner }
        `);
		const outer = r.items["Outer"];
		if (!outer || outer.type !== "object") throw new Error();
		expect(outer.fields["inner"]).toMatchObject({
			type: "link",
			target: "Inner",
		});
	});
});
