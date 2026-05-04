import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkGoFile } from "./walk-go";

async function ir(src: string) {
	const tree = await parseSource("go", src);
	return walkGoFile(tree, "test.go");
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
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["Uptime", "Status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("alias type", async () => {
		const r = await ir(`type DeviceId uint32`);
		const a = r.items[0]!;
		expect(a.kind).toBe("alias");
		if (a.kind === "alias") {
			expect(a.name).toBe("DeviceId");
			expect(a.type).toEqual({ kind: "primitive", name: "u32" });
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
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({
				kind: "array",
				item: { kind: "primitive", name: "i64" }
			});
			expect(s.fields[1]!.type).toEqual({
				kind: "array",
				item: { kind: "primitive", name: "u8" },
				exactLength: 16
			});
			expect(s.fields[2]!.type).toEqual({
				kind: "optional",
				inner: { kind: "ref", name: "Config" }
			});
		}
	});
});
