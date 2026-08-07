/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { fromModule, SchemaAnalyzer } from "../../core/src";
import {
	binary,
	type EnumPlan,
	type LayoutPlan,
	type StructPlan,
	type UnionPlan,
	wgsl,
} from "../../schema/src";

/**
 * Layout-focused analyzer cases. `analyzer.test.ts` covers extraction shape
 * (inline structs, symbol provenance, analyzer state); this file pins the
 * ARITHMETIC — offsets, padding, alignment and stride — across the schema
 * shapes and layout modes that consumers actually use.
 *
 * These are the numbers every exporter and codec is derived from, so each
 * assertion states the byte math it locks in.
 */

function analyze(
	defs: Record<string, unknown>,
	settings: Record<string, unknown> = {},
	tier: "binary" | "wgsl" = "binary",
): LayoutPlan {
	const mod = scope({
		...(tier === "wgsl" ? wgsl.import() : binary.import()),
		...(defs as Record<string, never>),
	});
	return new SchemaAnalyzer().analyze(fromModule(mod.export()), {
		mode: "binary",
		version: "1.0.0",
		endian: "le",
		wordSize: "64",
		...settings,
	}).plan;
}

function struct(plan: LayoutPlan, name: string): StructPlan {
	const t = plan.types.find((x) => x.name === name);
	if (!t || t.kind !== "struct") throw new Error(`${name} is not a struct`);
	return t;
}

/** `{ fieldName: [offset, size, paddingAfter] }` — compact layout snapshot. */
function layoutOf(s: StructPlan): Record<string, [number, number, number]> {
	return Object.fromEntries(
		s.fields.map((f) => [f.name, [f.offset, f.size, f.paddingAfter]]),
	);
}

describe("analyzer layout — alignment and padding", () => {
	test("declaration order is preserved and gaps are padded, not reordered", () => {
		const s = struct(analyze({ M: { a: "u8", b: "u32", c: "u16" } }), "M");
		// u8 at 0 → 3 bytes of padding so the u32 lands on its 4-byte boundary,
		// u16 at 8, then 2 trailing bytes to round the struct up to align 4.
		expect(layoutOf(s)).toEqual({
			a: [0, 1, 3],
			b: [4, 4, 0],
			c: [8, 2, 2],
		});
		expect([s.size, s.align, s.paddedSize]).toEqual([12, 4, 12]);
	});

	test("autoSort reorders by descending alignment and reclaims the padding", () => {
		const s = struct(
			analyze({ M: { a: "u8", b: "u32", c: "u16" } }, { autoSort: true }),
			"M",
		);
		expect(s.fields.map((f) => f.name)).toEqual(["b", "c", "a"]);
		// Same three fields, 12 bytes → 8: only one trailing pad byte remains.
		expect(layoutOf(s)).toEqual({
			b: [0, 4, 0],
			c: [4, 2, 0],
			a: [6, 1, 1],
		});
		expect(s.paddedSize).toBe(8);
	});

	test("a u64 raises the whole struct's alignment to 8", () => {
		const s = struct(analyze({ M: { flag: "u8", total: "u64" } }), "M");
		expect(s.align).toBe(8);
		expect(layoutOf(s)).toEqual({ flag: [0, 1, 7], total: [8, 8, 0] });
		expect(s.paddedSize).toBe(16);
	});

	test("a nested struct propagates its alignment to the parent", () => {
		const plan = analyze({
			Inner: { big: "u64" },
			Outer: { tag: "u8", inner: "Inner" },
		});
		expect(struct(plan, "Inner").align).toBe(8);
		const outer = struct(plan, "Outer");
		// Inner's align 8 wins over the u8, so `inner` starts at 8, not 1.
		expect(outer.align).toBe(8);
		expect(layoutOf(outer)).toEqual({ tag: [0, 1, 7], inner: [8, 8, 0] });
	});
});

describe("analyzer layout — composite fields", () => {
	test("a fixed array of struct references strides by the element's padded size", () => {
		const plan = analyze({
			V: { x: "f32", y: "f32", z: "f32" },
			A: { rows: "V[] == 3", w: "f32" },
		});
		expect(struct(plan, "V").paddedSize).toBe(12);
		const a = struct(plan, "A");
		// 3 × 12 = 36 with no inter-element padding (align 4 already satisfied).
		expect(layoutOf(a)).toEqual({ rows: [0, 36, 0], w: [36, 4, 0] });
		expect(a.paddedSize).toBe(40);

		const rows = a.fields.find((f) => f.name === "rows")!;
		expect(rows.type.kind).toBe("array");
		if (rows.type.kind !== "array") return;
		expect(rows.type.exactLength).toBe(3);
	});

	test("a bounded string reserves a u32 length plus its maximum bytes", () => {
		const s = struct(analyze({ S: { name: "string <= 8", id: "u32" } }), "S");
		// 4-byte length prefix + 8 bytes of inline payload = 12.
		expect(layoutOf(s)).toEqual({ name: [0, 12, 0], id: [12, 4, 0] });
		const name = s.fields.find((f) => f.name === "name")!;
		expect(name.type.kind).toBe("string");
	});

	test("an optional field reserves a presence byte ahead of its payload", () => {
		const s = struct(analyze({ O: { present: "u32", maybe: "u16?" } }), "O");
		const maybe = s.fields.find((f) => f.name === "maybe")!;
		expect(maybe.type.kind).toBe("optional");
		// 1 presence byte + u16 payload, rounded up to the struct's align 4.
		expect(maybe.size).toBe(4);
		expect(s.paddedSize).toBe(8);
	});
});

describe("analyzer layout — bit packing", () => {
	test("sub-byte fields each take their own byte unless autoPack is on", () => {
		const s = struct(analyze({ W: { x: "u5", y: "u5", rest: "u16" } }), "W");
		// Packing is opt-in: without autoPack the two u5s stay byte-addressable.
		expect(s.fields.map((f) => [f.name, f.offset, f.bitOffset, f.bitSize])).toEqual([
			["x", 0, 0, 5],
			["y", 1, 0, 5],
			["rest", 2, 0, 16],
		]);
		expect(s.paddedSize).toBe(4);
	});

	test("autoPack merges sub-byte fields into one shared byte", () => {
		const s = struct(
			analyze({ P: { a: "u1", b: "u1", c: "u1", d: "u32" } }, { autoPack: true }),
			"P",
		);
		// a/b/c all live at byte 0, at ascending bit offsets.
		expect(s.fields.map((f) => [f.name, f.offset, f.bitOffset])).toEqual([
			["a", 0, 0],
			["b", 0, 1],
			["c", 0, 2],
			["d", 4, 0],
		]);
		expect(s.paddedSize).toBe(8);
	});

	test("a whole-byte field is not marked as a bitfield", () => {
		// The codecs treat `bitSize < size * 8` as "packed". A plain u8 or
		// boolean must fail that test, or every field reads through shift+mask.
		const s = struct(analyze({ T: { enabled: "boolean", level: "u8" } }), "T");
		for (const f of s.fields) {
			expect(f.bitSize, `${f.name} bitSize`).toBe(f.size * 8);
		}
	});
});

describe("analyzer layout — enums and unions", () => {
	test("a string union becomes an enum numbered in declaration order", () => {
		const plan = analyze({
			Mode: "'idle' | 'run' | 'halt'",
			M: { mode: "Mode", t: "u32" },
		});
		const mode = plan.types.find((t) => t.name === "Mode") as EnumPlan;
		expect(mode.kind).toBe("enum");
		expect(mode.underlyingType).toBe("u8");
		// Declaration order, NOT arktype's canonical alphabetical order.
		expect(mode.variants.map((v) => [v.name, v.value])).toEqual([
			["idle", 0],
			["run", 1],
			["halt", 2],
		]);
		expect(layoutOf(struct(plan, "M"))).toEqual({
			mode: [0, 1, 3],
			t: [4, 4, 0],
		});
	});

	test("a tagged union sizes to its largest variant plus the tag", () => {
		const plan = analyze({
			A: { tag: "'a'", x: "u8" },
			B: { tag: "'b'", y: "u32" },
			U: "A | B",
		});
		const u = plan.types.find((t) => t.name === "U") as UnionPlan;
		expect(u.kind).toBe("union");
		expect([u.tagOffset, u.tagSize, u.tagType]).toEqual([0, 1, "u8"]);
		// Tag byte, then the payload realigned to 4 (B's align) → 4 + 4 = 8.
		expect([u.align, u.paddedSize]).toEqual([4, 8]);
		expect(struct(plan, "A").paddedSize).toBe(1);
		expect(struct(plan, "B").paddedSize).toBe(4);
	});
});

describe("analyzer layout — GPU layout modes", () => {
	test("std430 packs a vec3-shaped struct without rounding it up to 16", () => {
		const plan = analyze(
			{ V3: { x: "f32", y: "f32", z: "f32" }, P: { o: "V3", n: "u32" } },
			{ layout: "std430" },
		);
		expect(struct(plan, "V3").paddedSize).toBe(12);
		// std430 lets the trailing u32 fill the 4 bytes after the vec3.
		expect(layoutOf(struct(plan, "P"))).toEqual({ o: [0, 12, 0], n: [12, 4, 0] });
		expect(struct(plan, "P").paddedSize).toBe(16);
	});

	test("std140 rounds every array element up to 16 bytes", () => {
		const p = struct(analyze({ P: { xs: "f32[] == 3", n: "u32" } }, { layout: "std140" }), "P");
		// 3 f32 elements, each padded to a 16-byte stride → 48, not 12.
		expect(layoutOf(p)).toEqual({ xs: [0, 48, 0], n: [48, 4, 12] });
		expect([p.align, p.paddedSize]).toEqual([16, 64]);
	});

	test("the wgsl tier carries vec3f's declared 12/16 size-vs-align split", () => {
		const p = struct(
			analyze({ P: { o: "vec3f", n: "u32" } }, { layout: "std430" }, "wgsl"),
			"P",
		);
		// vec3f is 12 bytes of data on a 16-byte alignment, so `n` slots into
		// the gap and the struct closes at exactly 16.
		expect(layoutOf(p)).toEqual({ o: [0, 12, 0], n: [12, 4, 0] });
		expect([p.align, p.paddedSize]).toEqual([16, 16]);
	});
});
