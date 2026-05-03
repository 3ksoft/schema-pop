/// <reference types="@types/bun" />
/**
 * Round-trip invariant for the analyzer split (NEXT_STEPS Phase 2):
 *
 *   computeLayoutPlan(arktypeScopeToIR(scope)) ≡ SchemaAnalyzer(scope).analyze()
 *
 * Same fixture catalog as `_baseline.test.ts`. Both stages run on
 * every fixture; the resulting plan must JSON-equal the legacy direct
 * path. Failure here means the IR doesn't carry enough information to
 * reconstruct the LayoutPlan — which is exactly what we need to catch
 * before downstream consumers (importer pipelines, exporters) start
 * relying on the split.
 */
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary } from "../schema/binary";
import { bitwise } from "../schema/bitwise";
import { SchemaAnalyzer, type AnalyzerConfig } from "./analyzer";
import { arktypeScopeToIR } from "./scope-to-ir";
import { computeLayoutPlan } from "./compute-plan";

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

function defaults(cfg?: AnalyzerConfig): AnalyzerConfig {
	return {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
		...(cfg ?? {}),
	};
}

describe("analyzer split — round-trip identity (sidecar path)", () => {
	for (const [name, f] of Object.entries(FIXTURES)) {
		test(name, () => {
			const cfg = defaults(f.cfg);
			const direct = new SchemaAnalyzer(f.scope(), cfg).analyze("v1", "le");
			const viaSplit = computeLayoutPlan(arktypeScopeToIR(f.scope(), cfg), {
				version: "v1",
				endian: "le",
				wordSize: cfg.wordSize,
				autoLayout: cfg.autoLayout,
				layoutType: cfg.layoutType,
			});
			expect(viaSplit).toEqual(direct);
		});
	}
});

describe("analyzer split — derive path (no-sidecar IR)", () => {
	for (const [name, f] of Object.entries(FIXTURES)) {
		test(name, () => {
			const cfg = defaults(f.cfg);
			const direct = new SchemaAnalyzer(f.scope(), cfg).analyze("v1", "le");
			// IR stripped of layout sidecar — same shape a tree-sitter or
			// raw-clang importer would produce. computeLayoutPlan must
			// reconstruct identical layout from the IR alone.
			const viaDerive = computeLayoutPlan(
				arktypeScopeToIR(f.scope(), { ...cfg, noLayout: true }),
				{
					version: "v1",
					endian: "le",
					wordSize: cfg.wordSize,
					autoLayout: cfg.autoLayout,
					layoutType: cfg.layoutType,
				},
			);
			expect(viaDerive).toEqual(direct);
		});
	}
});
