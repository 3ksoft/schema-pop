import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "arktype";
import { SchemaAnalyzer, fromModule } from "@schema-pop/core";
import {
	LAYOUT_JSON_SCHEMA_VERSION,
	readLayoutPlan,
	writeLayoutPlan,
	binary,
} from "@schema-pop/schema";

describe("layout-io — write/read round-trip", () => {
	test("write then read reproduces the plan exactly", async () => {
		const plan = new SchemaAnalyzer().analyze(
			fromModule(
				type.module({
					...binary.import(),
					S: { a: "u8", b: "u32", c: "i16" },
				}),
			),
			{ version: "1.0.0", endian: "le" },
		);

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-pop-io-"));
		const dest = path.join(dir, "out.layout.json");
		try {
			await writeLayoutPlan(plan, dest);
			const round = await readLayoutPlan(dest);
			expect(round).toEqual(plan);

			// Envelope shape on disk.
			const raw = await fs.readFile(dest, "utf8");
			const parsed = JSON.parse(raw);
			expect(parsed.$schemaVersion).toBe(LAYOUT_JSON_SCHEMA_VERSION);
			expect(parsed.plan).toBeDefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("readLayoutPlan rejects mismatched schemaVersion", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-pop-io-"));
		const dest = path.join(dir, "out.layout.json");
		try {
			await fs.writeFile(
				dest,
				JSON.stringify({ $schemaVersion: "999", plan: {} }),
			);
			await expect(readLayoutPlan(dest)).rejects.toThrow(/schemaVersion/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("readLayoutPlan rejects non-envelope JSON", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-pop-io-"));
		const dest = path.join(dir, "out.layout.json");
		try {
			await fs.writeFile(dest, JSON.stringify({ types: [] }));
			await expect(readLayoutPlan(dest)).rejects.toThrow(/valid layout JSON/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
