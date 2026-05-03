/// <reference types="@types/bun" />
/**
 * Byte-equal LayoutPlan baseline. Every fixture is run through the
 * current `SchemaAnalyzer` pipeline and the resulting plan is
 * snapshotted as JSON under `./__baseline__/`.
 *
 * Purpose: lock the analyzer's output before splitting it into
 * `arktypeScopeToIR` + `computeLayoutPlan` so the refactor can be
 * validated as invariant. Set `BASELINE_UPDATE=1` to regenerate the
 * snapshots after an intentional behavioural change.
 *
 * Coverage spans every kind the LayoutPlan models today: primitives
 * (incl. bigint), enums (string-literal unions), aliases, struct
 * references, optional fields, fixed + bounded arrays, tagged unions,
 * inline structs (via spread `"..."`), bit-packed sub-byte fields, and
 * rich-mode shapes (string with maxLength, map, any).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { scope } from "arktype";
import { binary } from "../schema/binary";
import { bitwise } from "../schema/bitwise";
import { SchemaAnalyzer, type AnalyzerConfig } from "./analyzer";

type FixtureFn = () => any;

interface Fixture {
	scope: FixtureFn;
	cfg?: AnalyzerConfig;
}

const FIXTURES: Record<string, Fixture> = {
	primitives_native_align: {
		scope: () =>
			scope({
				...binary.import(),
				Sample: { tiny: "u8", word: "u32", signed: "i32", flag: "bool" },
			}),
	},
	primitives_bigint: {
		scope: () =>
			scope({
				...binary.import(),
				Big: { a: "u128", b: "i128", c: "u64", d: "f64" },
			}),
	},
	enum_string_union: {
		scope: () =>
			scope({
				...binary.import(),
				Mode: "'idle' | 'active' | 'error'",
			}),
	},
	alias_to_primitive: {
		scope: () => scope({ ...binary.import(), Counter: "u32" }),
	},
	struct_with_struct_ref: {
		scope: () =>
			scope({
				...binary.import(),
				Inner: { x: "u8" },
				Outer: { inner: "Inner", flag: "bool" },
			}),
	},
	optional_field: {
		scope: () =>
			scope({
				...binary.import(),
				Cfg: { name: "u32", "age?": "u8" },
			}),
		cfg: { mode: "rich" },
	},
	fixed_array: {
		scope: () =>
			scope({
				...binary.import(),
				Buf: { data: "u8[] == 16" },
			}),
	},
	bounded_array_rich: {
		scope: () =>
			scope({
				...binary.import(),
				Tags: { items: "u32[] <= 10" },
			}),
		cfg: { mode: "rich" },
	},
	tagged_union: {
		scope: () =>
			scope({
				...binary.import(),
				A: { x: "u8" },
				B: { y: "u16" },
				U: "A | B",
			}),
	},
	inline_struct_via_spread: {
		scope: () =>
			scope({
				...binary.import(),
				Base: { id: "u32" },
				Derived: { "...": "Base", extra: "u8" },
			}),
	},
	bit_packed_sub_byte: {
		scope: () =>
			scope({
				...binary.import(),
				...bitwise.import(),
				Flags: { a: "u1", b: "u3", c: "u4" },
			}),
	},
	auto_layout_reorder: {
		scope: () =>
			scope({
				...binary.import(),
				Mixed: { x: "u8", y: "u32", z: "u8" },
			}),
		cfg: { autoLayout: true },
	},
	zero_padding_layout: {
		scope: () =>
			scope({
				...binary.import(),
				Wire: { a: "u8", b: "u32", c: "u16" },
			}),
		cfg: { layoutType: "zero-padding" },
	},
	std140_vec3: {
		scope: () =>
			scope({
				...binary.import(),
				Trap: { a: "f32", b: "f32[] == 3" },
			}),
		cfg: { layoutType: "std140" },
	},
	std430_array: {
		scope: () =>
			scope({
				...binary.import(),
				Data: { values: "f32[] == 10" },
			}),
		cfg: { layoutType: "std430" },
	},
	rich_string_bounded: {
		scope: () =>
			scope({
				...binary.import(),
				Note: { body: "string <= 80" },
			}),
		cfg: { mode: "rich" },
	},
	rich_map: {
		scope: () =>
			scope({
				...binary.import(),
				Lookup: { table: "Record<string, u32>" },
			}),
		cfg: { mode: "rich" },
	},
	rich_unknown_any: {
		scope: () =>
			scope({
				...binary.import(),
				Any: { payload: "unknown" },
			}),
		cfg: { mode: "rich" },
	},
};

const SNAPSHOT_DIR = path.join(import.meta.dir, "__baseline__");

function plan(name: string): string {
	const f = FIXTURES[name]!;
	const a = new SchemaAnalyzer(f.scope(), {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
		...(f.cfg ?? {}),
	});
	return JSON.stringify(a.analyze("v1", "le"), null, 2);
}

describe("layout plan baseline (locks analyzer output for Phase 2 split)", () => {
	for (const name of Object.keys(FIXTURES)) {
		test(name, () => {
			const got = plan(name);
			const file = path.join(SNAPSHOT_DIR, `${name}.json`);
			if (process.env.BASELINE_UPDATE === "1") {
				fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
				fs.writeFileSync(file, got + "\n");
				return;
			}
			if (!fs.existsSync(file)) {
				throw new Error(
					`Missing baseline ${file}. Run with BASELINE_UPDATE=1 to seed it.`,
				);
			}
			const expected = fs.readFileSync(file, "utf8").trimEnd();
			expect(got.trimEnd()).toBe(expected);
		});
	}
});
