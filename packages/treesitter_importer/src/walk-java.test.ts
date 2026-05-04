import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkJavaFile } from "./walk-java";

async function ir(src: string) {
	const tree = await parseSource("java", src);
	return walkJavaFile(tree, "test.java");
}

describe("java importer — walker", () => {
	test("class with fields → struct", async () => {
		const r = await ir(`
            public class Telemetry {
                public int uptime_ms;
                public String status;
            }
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["uptime_ms", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i32" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("record → struct", async () => {
		const r = await ir(
			`public record Telemetry(int uptime_ms, String status) {}`,
		);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["uptime_ms", "status"]);
		}
	});

	test("enum declaration → enum", async () => {
		const r = await ir(`public enum Severity { Info, Warn, Error }`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual(["Info", "Warn", "Error"]);
		}
	});

	test("List<String> generic resolves to array", async () => {
		const r = await ir(`class I { public List<String> xs; }`);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({
				kind: "array",
				item: { kind: "string" },
			});
		}
	});
});
