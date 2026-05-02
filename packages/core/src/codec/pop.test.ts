/**
 * Round-trip tests for PopCodec — encode → decode and verify equality.
 *
 * These exist primarily to catch tag-dispatch / layout regressions like
 * docs/requests.md P16, where the codec wrote `variantIndex + 1` while
 * the Rust generator emitted variant discriminants starting at 0,
 * leaving everything but the first variant decoding through the
 * neighbouring variant's struct layout. Every union test case below
 * exercises EVERY variant, not just the alphabetically-first one.
 */
import { describe, expect, test } from "bun:test";
import { binary, scope } from "schema-pop";
import { SchemaAnalyzer } from "../layout/analyzer";
import { PopCodec } from "./pop";

function codecFor<S extends Record<string, unknown>>(s: S): PopCodec {
	const plan = new SchemaAnalyzer(s as any, {}).analyze("test");
	return new PopCodec(plan);
}

function roundTrip(codec: PopCodec, type: string, data: unknown): unknown {
	const buf = codec.encode(type, data);
	return codec.decode(type, buf);
}

describe("PopCodec round-trip", () => {
	test("plain struct — primitive widths preserved", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				All: {
					a: "u8",
					b: "i8",
					c: "u16",
					d: "i16",
					e: "u32",
					f: "i32",
					g: "f32",
					h: "f64",
				},
			}),
		);
		const data = {
			a: 200,
			b: -100,
			c: 50_000,
			d: -20_000,
			e: 4_000_000_000,
			f: -1_500_000_000,
			g: 1.5,
			h: 1.2345678901234,
		};
		expect(roundTrip(codec, "All", data)).toEqual(data);
	});

	test("u64 / i64 / u128 / i128 — bigint round-trip", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				Big: { u: "u64", i: "i64", uu: "u128", ii: "i128" },
			}),
		);
		const data = {
			u: 0xdeadbeef_cafef00dn,
			i: -123_456_789_012n,
			uu: 0x1122334455667788_99aabbccddeeff00n,
			ii: -1n,
		};
		const out = roundTrip(codec, "Big", data) as typeof data;
		expect(out.u).toBe(data.u);
		expect(out.i).toBe(data.i);
		expect(out.uu).toBe(data.uu);
		expect(out.ii).toBe(data.ii);
	});

	test("bounded string field — declared length round-trips, padding zeroed", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				Hdr: { tag: "u8", name: "string<=16" },
			}),
		);
		const out = roundTrip(codec, "Hdr", {
			tag: 7,
			name: "hello",
		}) as { tag: number; name: string };
		expect(out.tag).toBe(7);
		expect(out.name).toBe("hello");

		// Empty string also works.
		const out2 = roundTrip(codec, "Hdr", { tag: 0, name: "" }) as {
			name: string;
		};
		expect(out2.name).toBe("");
	});

	test("fixed-length array — every element preserved", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				Vec4: "f32[] == 4",
				Pt: { p: "Vec4" },
			}),
		);
		const data = { p: [1.5, -2.25, 3.125, 0] };
		const out = roundTrip(codec, "Pt", data) as { p: number[] };
		expect(out.p).toHaveLength(4);
		expect(out.p[0]).toBe(1.5);
		expect(out.p[1]).toBe(-2.25);
		expect(out.p[2]).toBe(3.125);
		expect(out.p[3]).toBe(0);
	});

	test("bounded array — length prefix preserves declared size", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				Buf: { items: "u32[]<=4" },
			}),
		);
		const out = roundTrip(codec, "Buf", { items: [10, 20, 30] }) as {
			items: number[];
		};
		expect(out.items.slice(0, 3)).toEqual([10, 20, 30]);
		expect(out.items.length).toBe(3);
	});

	test("nested struct — inner ref round-trips", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				Inner: { x: "u32", y: "u32" },
				Outer: { tag: "u8", inner: "Inner" },
			}),
		);
		const out = roundTrip(codec, "Outer", {
			tag: 3,
			inner: { x: 100, y: 200 },
		}) as { tag: number; inner: { x: number; y: number } };
		expect(out.tag).toBe(3);
		expect(out.inner).toEqual({ x: 100, y: 200 });
	});

	test("plain enum — all variants round-trip", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				Mode: "'Idle' | 'Active' | 'Error'",
				Pkt: { mode: "Mode" },
			}),
		);
		for (const mode of ["Idle", "Active", "Error"]) {
			const out = roundTrip(codec, "Pkt", { mode }) as { mode: string };
			expect(out.mode).toBe(mode);
		}
	});

	test("tagged union — EVERY variant decodes correctly (P16 regression)", () => {
		// Three variants of clearly distinct payload shape so a tag
		// off-by-one would scramble the result, not just shift fields
		// of compatible types.
		const codec = codecFor(
			scope({
				...binary.import(),
				A: { x: "u32" },
				B: { y: "i16", z: "i16" },
				C: { msg: "string<=8" },
				M: "A | B | C",
			}),
		);

		// Variants are sorted alphabetically inside the analyzer, so the
		// expected discriminant values are A=0, B=1, C=2 — matching what
		// the Rust exporter emits for `#[repr(C, u8)]`.
		const cases: Array<[string, unknown]> = [
			["A", { kind: "A", x: 0xcafe_babe }],
			["B", { kind: "B", y: -1234, z: 5678 }],
			["C", { kind: "C", msg: "hello" }],
		];

		for (const [variant, payload] of cases) {
			const buf = codec.encode("M", payload);
			expect(buf.byteLength).toBeGreaterThan(0);

			// Tag byte must equal the alphabetical index — not +1.
			const tag = new DataView(buf.buffer, buf.byteOffset).getUint8(0);
			const expectedTag = ["A", "B", "C"].indexOf(variant);
			expect(tag).toBe(expectedTag);

			const decoded = codec.decode("M", buf) as Record<string, unknown>;
			expect(decoded.kind).toBe(variant);
			for (const [k, v] of Object.entries(payload as object)) {
				if (k === "kind") continue;
				expect(decoded[k]).toEqual(v);
			}
		}
	});

	test("union — corrupt tag surfaces UnknownTag(N), doesn't fake first variant", () => {
		const codec = codecFor(
			scope({
				...binary.import(),
				A: { x: "u8" },
				B: { y: "u8" },
				M: "A | B",
			}),
		);
		const buf = codec.encode("M", { kind: "A", x: 1 });
		// Corrupt the tag to an out-of-range value.
		const view = new DataView(buf.buffer, buf.byteOffset);
		view.setUint8(0, 99);
		const decoded = codec.decode("M", buf);
		expect(decoded).toBe("UnknownTag(99)");
	});
});
