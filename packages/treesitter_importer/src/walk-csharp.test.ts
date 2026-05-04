import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkCSharpFile } from "./walk-csharp";

async function ir(src: string) {
	const tree = await parseSource("c_sharp", src);
	return walkCSharpFile(tree, "test.cs");
}

describe("c# importer", () => {
	test("class with public properties and fields", async () => {
		const r = await ir(`
            public class Telemetry {
                public int Uptime { get; set; }
                public string Status;
                private int hidden;
            }
        `);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["Uptime", "Status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i32" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("record structural typing", async () => {
		const r = await ir(`public record Telemetry(int Uptime, string Status);`);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map(f => f.name)).toEqual(["Uptime", "Status"]);
		}
	});

	test("enum extraction", async () => {
		const r = await ir(`public enum Status { Idle, Active }`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map(v => v.name)).toEqual(["Idle", "Active"]);
		}
	});

	test("arrays and lists", async () => {
		const r = await ir(`
            public class Data {
                public int[] Numbers { get; set; }
                public List<string> Labels;
            }
        `);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({ kind: "array", item: { kind: "primitive", name: "i32" } });
			expect(s.fields[1]!.type).toEqual({ kind: "array", item: { kind: "string" } });
		}
	});
});
