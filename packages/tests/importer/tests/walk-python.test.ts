import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return importSource(src, "python");
}

describe("python importer — walker", () => {
	test("class with PEP 526 typed fields -> struct", async () => {
		const r = await ir(`
class Telemetry:
    uptime_ms: int
    status: str
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptime_ms", "status"]);
			expect(s.fields["uptime_ms"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
		}
	});

	test("class with typed assignment -> struct", async () => {
		const r = await ir(`
class Telemetry:
    uptime_ms: int = 0
    status: str = "ok"
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptime_ms", "status"]);
			expect(s.fields["uptime_ms"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
		}
	});

	test("optional and list", async () => {
		const r = await ir(`
class Data:
    tags: list[int]
    note: Optional[str]
    other: int | None
        `);
		const s = r.items["Data"]!;
		if (s.type === "object") {
			expect(s.fields["tags"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i64" },
			});
			expect(s.fields["note"]).toMatchObject({
				type: "string",
			});
			expect((s.fields["note"] as any).required).toBe(false);
			expect(s.fields["other"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect((s.fields["other"] as any).required).toBe(false);
		}
	});

	test("enum declaration", async () => {
		const r = await ir(`
class Status(Enum):
    Idle = 1
    Active = 2
        `);
		const e = r.items["Status"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Idle", "Active"]);
		}
	});

	test("docstrings", async () => {
		const r = await ir(`
class Device:
    """Represents a connected device."""
    id: int
    """Unique ID."""
        `);
		const s = r.items["Device"]!;
		expect(s.description).toBe("Represents a connected device.");
		if (s.type === "object") {
			expect(s.fields["id"]!.description).toBe("Unique ID.");
		}
	});
});
