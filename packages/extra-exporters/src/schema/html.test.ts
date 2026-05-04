/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations as migScope, SchemaAnalyzer } from "schema-pop";
import { html } from "./html";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

function extractDiff(emitted: string): {
	from: string;
	to: string;
	changes: Array<{ type: string; status: string; note: string }>;
} {
	const m = emitted.match(/diffs\.push\((.+?)\);<\/script>/s);
	if (!m) throw new Error("no diff payload found");
	return JSON.parse(m[1]!);
}

describe("html exporter — renamed status", () => {
	test("type-level Renamed → status 'renamed' with old name in note", () => {
		const v1 = analyze(scope({ ...binary.import(), DeviceStatus: "u8" }), "v1");
		const v2 = analyze(
			scope({
				...binary.import(),
				...migScope.import(),
				RuntimeStatus: "Renamed<u8, 'DeviceStatus'>",
			}),
			"v2",
		);
		const out = html().generateMigration!(v1, v2);
		const diff = extractDiff(out);
		const rs = diff.changes.find((c) => c.type === "RuntimeStatus");
		expect(rs).toBeDefined();
		expect(rs!.status).toBe("renamed");
		expect(rs!.note).toContain('renamed from "DeviceStatus"');
		// no spurious 'removed' for the old name
		expect(diff.changes.find((c) => c.type === "DeviceStatus")).toBeUndefined();
	});

	test("field rename → status modified + 'renamed:' in note", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { voltage_mv: "u32" } }),
			"v1",
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				...migScope.import(),
				B: { voltage: "Renamed<u32, 'voltage_mv'>" },
			}),
			"v2",
		);
		const out = html().generateMigration!(v1, v2);
		const diff = extractDiff(out);
		const b = diff.changes.find((c) => c.type === "B");
		expect(b).toBeDefined();
		// Field rename keeps the type name stable, so type status is `unchanged`
		// (wire-compatible). The rename note documents the field-level swap.
		expect(b!.note).toContain("voltage_mv→voltage");
		// And the note must NOT spuriously say "+1 field, -1 field"
		expect(b!.note).not.toContain("+1 field");
		expect(b!.note).not.toContain("-1 field");
	});

	test("enum variant rename → 'renamed:' note", () => {
		const v1 = analyze(
			scope({ ...binary.import(), Status: "'Idle' | 'Active' | 'Suspended'" }),
			"v1",
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				...migScope.import(),
				Status: "'Idle' | 'Active' | Renamed<'Sleep', 'Suspended'>",
			}),
			"v2",
		);
		const out = html().generateMigration!(v1, v2);
		const diff = extractDiff(out);
		const s = diff.changes.find((c) => c.type === "Status");
		expect(s).toBeDefined();
		expect(s!.note).toContain("Suspended→Sleep");
		expect(s!.note).not.toContain("+1 variant");
	});
});
