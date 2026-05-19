import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "typescript");
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
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptime_ms", "status", "tags"]);
			expect(s.fields["uptime_ms"]).toMatchObject({
				type: "number",
				binaryType: "f64",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
			expect(s.fields["tags"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "f64" },
			});
		}
	});

	test("optional field — `name?: T`", async () => {
		const r = await ir(`interface I { x: number; note?: string; }`);
		const s = r.items["I"]!;
		if (s.type === "object") {
			const note = s.fields["note"]!;
			expect((note as any).required).toBe(false);
			expect(note.type).toBe("string");
		}
	});

	test("string-literal union → unit enum (any width)", async () => {
		const r = await ir(`type Mode = 'Idle' | 'Active' | 'Error' | 'Offline';`);
		const e = r.items["Mode"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Idle", "Active", "Error", "Offline"]);
		}
	});

	test("enum declaration → unit enum", async () => {
		const r = await ir(`enum Severity { Info, Warn, Error }`);
		const e = r.items["Severity"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Info", "Warn", "Error"]);
		}
	});

	test("type alias of object → struct", async () => {
		const r = await ir(`type Reading = { sensor_id: number; value: number };`);
		const s = r.items["Reading"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["sensor_id", "value"]);
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
		const s = r.items["Telemetry"]!;
		expect(s.description).toContain("Telemetry packet");
		if (s.type === "object") {
			expect(s.fields["uptime_ms"]!.description).toContain("Monotonic clock");
		}
	});

	test("union of refs (not literals) → unknown alias for now", async () => {
		const r = await ir(`type Either = Foo | Bar;`);
		const a = r.items["Either"]!;
		expect(a.type).toBe("any");
	});

	test("Array<T> generic resolves to vec", async () => {
		const r = await ir(`interface I { xs: Array<number>; }`);
		const s = r.items["I"]!;
		if (s.type === "object") {
			expect(s.fields["xs"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "f64" },
			});
		}
	});

	test("export keyword doesn't change resolution", async () => {
		const r = await ir(`export interface I { x: number }`);
		expect(Object.keys(r.items)).toHaveLength(1);
		expect(r.items["I"]!.type).toBe("object");
	});
});
