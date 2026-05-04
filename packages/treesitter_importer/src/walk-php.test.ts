import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkPhpFile } from "./walk-php";

async function ir(src: string) {
	const tree = await parseSource("php", src);
	return walkPhpFile(tree, "test.php");
}

describe("php importer — walker", () => {
	test("class with typed properties → struct", async () => {
		const r = await ir(`<?php
            class Telemetry {
                public int $uptime_ms;
                public string $status;
            }
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

	test("optional field — `?T`", async () => {
		const r = await ir(`<?php class I { public ?string $note; }`);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			const note = s.fields.find((f) => f.name === "note")!;
			expect(note.type.kind).toBe("optional");
			if (note.type.kind === "optional") {
				expect(note.type.inner).toEqual({ kind: "string" });
			}
		}
	});

	test("enum declaration → enum", async () => {
		const r = await ir(
			`<?php enum Severity { case Info; case Warn; case Error; }`,
		);
		const e = r.items[0]!;
		expect(e.kind).toBe("enum");
		if (e.kind === "enum") {
			expect(e.variants.map((v) => v.name)).toEqual(["Info", "Warn", "Error"]);
		}
	});
});
