import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkPythonFile } from "./walk-python";

async function ir(src: string) {
	const tree = await parseSource("python", src);
	return walkPythonFile(tree, "test.py");
}

describe("python importer — walker", () => {
	test("class with PEP 526 typed fields -> struct", async () => {
		const r = await ir(`
class Telemetry:
    uptime_ms: int
    status: str
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["uptime_ms", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
		}
	});

	test("class with typed assignment -> struct", async () => {
		const r = await ir(`
class Telemetry:
    uptime_ms: int = 0
    status: str = "ok"
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["uptime_ms", "status"]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
		}
	});

	test("optional and list", async () => {
		const r = await ir(`
class Data:
    tags: list[int]
    note: Optional[str]
    other: int | None
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
			expect(s.fields[2]!.type).toEqual({
				kind: "optional",
				inner: { kind: "primitive", name: "i64" },
			});
		}
	});

	test("enum declaration", async () => {
		const r = await ir(`
class Status(Enum):
    Idle = 1
    Active = 2
        `);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual(["Idle", "Active"]);
		}
	});

	test("docstrings", async () => {
		const r = await ir(`
class Device:
    """Represents a connected device."""
    id: int
    """Unique ID."""
        `);
		const s = r.items[0]!;
		expect(s.description).toBe("Represents a connected device.");
		if (s.kind === "struct") {
			expect(s.fields[0]!.description).toBe("Unique ID.");
		}
	});
});
