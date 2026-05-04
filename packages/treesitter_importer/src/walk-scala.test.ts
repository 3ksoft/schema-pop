import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkScalaFile } from "./walk-scala";

async function ir(src: string) {
	const tree = await parseSource("scala", src);
	return walkScalaFile(tree, "test.scala");
}

describe("scala importer", () => {
	test("case class maps to struct", async () => {
		const r = await ir(`
            case class Telemetry(uptimeMs: Int, status: String)
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["uptimeMs", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i32" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("class body vals", async () => {
		const r = await ir(`
            class Config {
                val items: Array[Int] = Array()
                var note: Option[String] = None
            }
        `);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({ kind: "array", item: { kind: "primitive", name: "i32" } });
			expect(s.fields[1]!.type).toEqual({ kind: "optional", inner: { kind: "string" } });
		}
	});
});
