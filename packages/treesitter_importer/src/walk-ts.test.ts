import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkTsFile } from "./walk-ts";

async function ir(src: string) {
	const tree = await parseSource("typescript", src);
	return walkTsFile(tree, "test.ts");
}

describe("typescript importer — walker", () => {
	test("interface → struct", async () => {
		const r = await ir(`
            interface Telemetry {
                uptime_ms: number;
                status: string;
                tags: number[];
            }
        `);
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual([
				"uptime_ms",
				"status",
				"tags",
			]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "f64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
			expect(s.fields[2]!.type).toEqual({
				kind: "array",
				item: { kind: "primitive", name: "f64" },
			});
		}
	});

	test("optional field — `name?: T`", async () => {
		const r = await ir(`interface I { x: number; note?: string; }`);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			const note = s.fields.find((f) => f.name === "note")!;
			expect(note.type.kind).toBe("optional");
			if (note.type.kind === "optional") {
				expect(note.type.inner).toEqual({ kind: "string" });
			}
		}
	});

	test("string-literal union → unit enum (any width)", async () => {
		const r = await ir(`type Mode = 'Idle' | 'Active' | 'Error' | 'Offline';`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual([
				"Idle",
				"Active",
				"Error",
				"Offline",
			]);
		}
	});

	test("enum declaration → unit enum", async () => {
		const r = await ir(`enum Severity { Info, Warn, Error }`);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual(["Info", "Warn", "Error"]);
		}
	});

	test("type alias of object → struct", async () => {
		const r = await ir(`type Reading = { sensor_id: number; value: number };`);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["sensor_id", "value"]);
		}
	});

	test("doc comments preserved on struct + fields", async () => {
		const r = await ir(`
            /** Telemetry packet. */
            interface Telemetry {
                /** Monotonic clock. */
                uptime_ms: number;
                status: string;
            }
        `);
		const s = r.items[0]!;
		expect(s.description).toContain("Telemetry packet");
		if (s.kind === "struct") {
			expect(s.fields[0]!.description).toContain("Monotonic clock");
		}
	});

	test("union of refs (not literals) → unknown alias for now", async () => {
		const r = await ir(`type Either = Foo | Bar;`);
		const a = r.items[0]!;
		expect(a.kind).toBe("alias");
		if (a.kind === "alias") {
			expect(a.type.kind).toBe("unknown");
		}
	});

	test("Array<T> generic resolves to vec", async () => {
		const r = await ir(`interface I { xs: Array<number>; }`);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields[0]!.type).toEqual({
				kind: "array",
				item: { kind: "primitive", name: "f64" },
			});
		}
	});

	test("export keyword doesn't change resolution", async () => {
		const r = await ir(`export interface I { x: number }`);
		expect(r.items).toHaveLength(1);
		expect(r.items[0]!.kind).toBe("struct");
	});
});
