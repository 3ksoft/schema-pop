import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "php");
}

describe("php importer — walker", () => {
	test("class with typed properties → struct", async () => {
		const r = await ir(`<?php
            class Telemetry {
                public int $uptime_ms;
                public string $status;
            }
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

	test("optional field — `?T`", async () => {
		const r = await ir(`<?php class I { public ?string $note; }`);
		const s = r.items["I"]!;
		if (s.type === "object") {
			const note = s.fields["note"]!;
			expect((note as any).required).toBe(false);
			expect(note.type).toBe("string");
		}
	});

	test("enum declaration → enum", async () => {
		const r = await ir(
			`<?php enum Severity { case Info; case Warn; case Error; }`,
		);
		const e = r.items["Severity"]!;
		expect(e.type).toBe("enum");
		if (e.type === "enum") {
			expect(e.options).toEqual(["Info", "Warn", "Error"]);
		}
	});
});
