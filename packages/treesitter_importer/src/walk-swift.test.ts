import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkSwiftFile } from "./walk-swift";

async function ir(src: string) {
	const tree = await parseSource("swift", src);
	return walkSwiftFile(tree, "test.swift");
}

describe("swift importer", () => {
	test("struct with properties", async () => {
		const r = await ir(`
            struct Telemetry {
                var uptimeMs: Int
                let status: String
            }
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["uptimeMs", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
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
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({ kind: "array", item: { kind: "primitive", name: "i64" } });
			expect(s.fields[1]!.type).toEqual({ kind: "optional", inner: { kind: "string" } });
			expect(s.fields[2]!.type).toEqual({ kind: "optional", inner: { kind: "primitive", name: "bool" } });
		}
	});

	test("enum extraction", async () => {
		const r = await ir(`enum Status { case Idle; case Active }`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map(v => v.name)).toEqual(["Idle", "Active"]);
		}
	});

	test("typealias", async () => {
		const r = await ir(`typealias DeviceId = UInt32`);
		const a = r.items[0]!;
		expect(a.kind).toBe("alias");
		if (a.kind === "alias") {
			expect(a.name).toBe("DeviceId");
			expect(a.type).toEqual({ kind: "primitive", name: "u32" });
		}
	});
});
