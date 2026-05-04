import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkDartFile } from "./walk-dart";

async function ir(src: string) {
	const tree = await parseSource("dart", src);
	return walkDartFile(tree, "test.dart");
}

describe("dart importer", () => {
	test("class with fields", async () => {
		const r = await ir(`
            class Telemetry {
                int uptimeMs;
                String status;
                int _privateVar;
            }
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["uptimeMs", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("optionals and lists", async () => {
		const r = await ir(`
            class Config {
                List<int> items;
                String? note;
            }
        `);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({
				kind: "array",
				item: { kind: "primitive", name: "i64" },
			});
			expect(s.fields[1]!.type).toEqual({
				kind: "optional",
				inner: { kind: "string" },
			});
		}
	});

	test("enum extraction", async () => {
		const r = await ir(`enum Status { idle, active }`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual(["idle", "active"]);
		}
	});
});
