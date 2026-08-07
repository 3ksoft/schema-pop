/// <reference types="@types/bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scope } from "arktype";
import {
	createInterpretedCodec,
	createRuntimeCodec,
	fromModule,
	SchemaAnalyzer,
} from "@schema-pop/core";
import { binary, type LayoutPlan } from "@schema-pop/schema";
import { tsCodec } from "@schema-pop/exporter";

/**
 * Parity across all three codecs schema-pop ships:
 *
 *   1. JIT          `createRuntimeCodec`     — builds readers via `new Function`
 *   2. interpreted  `createInterpretedCodec` — CSP-safe, walks the plan at runtime
 *   3. generated    `tsCodec` exporter       — emits standalone TS source
 *
 * They are three independent implementations of one wire format, so any
 * disagreement is a bug in at least one of them. Each case below runs the same
 * fixture through all three and asserts:
 *
 *   - identical BYTES out of `serialize` (the wire format is the contract)
 *   - every codec can `deserialize` every other codec's bytes to the same object
 *
 * The generated codec is written to a temp file and imported, because that is
 * how consumers actually use it — testing the emitted source as source.
 */

const TMP_ROOT = join(import.meta.dirname, "..", ".tmp");
mkdirSync(TMP_ROOT, { recursive: true });
const TMP = mkdtempSync(join(TMP_ROOT, "codec-parity-"));

interface CodecCase {
	name: string;
	/** Extra scope entries layered on top of the `binary` tier. */
	defs: Record<string, unknown>;
	/** Type to round-trip; must be a struct in the resulting plan. */
	type: string;
	value: Record<string, unknown>;
	layout?: "aligned" | "std430";
}

const CASES: CodecCase[] = [
	{
		name: "primitives with trailing padding",
		defs: { Header: { magic: "u32", revision: "u16", flags: "u8" } },
		type: "Header",
		value: { magic: 0xdeadbeef, revision: 517, flags: 9 },
	},
	{
		name: "signed and float primitives",
		defs: { Reading: { delta: "i32", drift: "i16", temperature: "f32" } },
		type: "Reading",
		value: { delta: -123456, drift: -900, temperature: 36.5 },
	},
	{
		name: "f64 keeps full precision",
		defs: { Precise: { value: "f64", tag: "u8" } },
		type: "Precise",
		value: { value: 0.1 + 0.2, tag: 7 },
	},
	{
		name: "64-bit integers",
		defs: { Counter: { total: "u64", offset: "i64" } },
		type: "Counter",
		value: { total: 9007199254740991, offset: -4503599627370496 },
	},
	{
		name: "nested struct reference",
		defs: {
			Vec3: { x: "f32", y: "f32", z: "f32" },
			Sample: { id: "u32", position: "Vec3", label: "u8" },
		},
		type: "Sample",
		value: { id: 42, position: { x: 1.5, y: -2.25, z: 0.125 }, label: 3 },
	},
	{
		name: "fixed array of primitives",
		defs: { Window: { samples: "u16[] == 4", scale: "f32" } },
		type: "Window",
		value: { samples: [1, 2, 3, 65535], scale: 2.5 },
	},
	{
		name: "fixed array of struct references",
		defs: {
			Vec3: { x: "f32", y: "f32", z: "f32" },
			Transform: { rows: "Vec3[] == 3", weight: "f32" },
		},
		type: "Transform",
		value: {
			rows: [
				{ x: 1, y: 2, z: 3 },
				{ x: 4, y: 5, z: 6 },
				{ x: 7, y: 8, z: 9 },
			],
			weight: 0.5,
		},
	},
	{
		name: "sub-byte bitfields packed into one byte",
		defs: { Flags: { a: "u1", b: "u3", c: "u4", payload: "u32" } },
		type: "Flags",
		value: { a: 1, b: 5, c: 11, payload: 0xcafe },
	},
	{
		name: "bitfields spanning two bytes",
		defs: { Wide: { x: "u5", y: "u5", rest: "u16" } },
		type: "Wide",
		value: { x: 21, y: 30, rest: 4096 },
	},
	{
		name: "boolean field",
		defs: { Toggle: { enabled: "boolean", level: "u8" } },
		type: "Toggle",
		value: { enabled: true, level: 200 },
	},
	{
		name: "string enum lowered to an integer tag",
		defs: {
			Mode: "'idle' | 'running' | 'halted'",
			Machine: { mode: "Mode", ticks: "u32" },
		},
		type: "Machine",
		value: { mode: "halted", ticks: 1234 },
	},
	{
		name: "std430 layout",
		defs: {
			Vec3: { x: "f32", y: "f32", z: "f32" },
			Params: { origin: "Vec3", count: "u32" },
		},
		type: "Params",
		value: { origin: { x: 3, y: 2, z: 1 }, count: 8 },
		layout: "std430",
	},
];

/** Uniform view over a codec suite, so the three can be driven identically. */
interface Codec {
	serialize(value: unknown, view: DataView, offset: number): void;
	deserialize(view: DataView, offset: number): unknown;
}

function analyzeCase(c: CodecCase): LayoutPlan {
	const mod = scope({ ...binary.import(), ...(c.defs as Record<string, never>) });
	return new SchemaAnalyzer().analyze(fromModule(mod.export()), {
		mode: "binary",
		version: "1.0.0",
		endian: "le",
		wordSize: "64",
		layout: c.layout ?? "aligned",
	}).plan;
}

/** Emits the plan's codec to disk and imports it as a real module. */
async function loadGeneratedCodec(
	plan: LayoutPlan,
	slug: string,
): Promise<(typeName: string) => Codec> {
	const file = join(TMP, `${slug}.codec.ts`);
	await Bun.write(file, tsCodec({}).generate(plan));
	const mod = (await import(file)) as Record<string, any>;
	return (typeName: string) => {
		const serialize = mod[`serialize${typeName}`];
		const deserialize = mod[`deserialize${typeName}`];
		if (!serialize || !deserialize) {
			throw new Error(`generated codec has no functions for ${typeName}`);
		}
		return {
			serialize: (value, view, offset) => serialize(value, view, offset),
			deserialize: (view, offset) => deserialize(view, offset),
		};
	};
}

describe("codec parity (JIT / interpreted / generated)", () => {
	// One plan + three codecs per case, resolved once so each `test` stays cheap.
	const prepared = new Map<
		string,
		{ plan: LayoutPlan; stride: number; codecs: Record<string, Codec> }
	>();

	beforeAll(async () => {
		for (const [i, c] of CASES.entries()) {
			const plan = analyzeCase(c);
			const type = plan.types.find((t) => t.name === c.type);
			if (!type) throw new Error(`${c.type} missing from plan for "${c.name}"`);

			const generated = await loadGeneratedCodec(plan, `case${i}`);
			prepared.set(c.name, {
				plan,
				stride: type.paddedSize ?? type.size ?? 0,
				codecs: {
					jit: createRuntimeCodec(plan).get(c.type),
					interpreted: createInterpretedCodec(plan).get(c.type),
					generated: generated(c.type),
				},
			});
		}
	});

	afterAll(() => {
		rmSync(TMP, { recursive: true, force: true });
	});

	for (const c of CASES) {
		test(`${c.name} — all three codecs emit identical bytes`, () => {
			const { stride, codecs } = prepared.get(c.name)!;

			const encoded = Object.fromEntries(
				Object.entries(codecs).map(([label, codec]) => {
					// Pre-fill with a non-zero pattern: a codec that leaves a byte
					// untouched then differs from one that writes a real zero.
					const bytes = new Uint8Array(stride).fill(0xa5);
					codec.serialize(c.value, new DataView(bytes.buffer), 0);
					return [label, Array.from(bytes)];
				}),
			);

			expect(encoded.interpreted, "interpreted vs jit").toEqual(encoded.jit!);
			expect(encoded.generated, "generated vs jit").toEqual(encoded.jit!);
		});

		test(`${c.name} — every codec decodes every other codec's bytes`, () => {
			const { stride, codecs } = prepared.get(c.name)!;

			for (const [writer, writeCodec] of Object.entries(codecs)) {
				const bytes = new Uint8Array(stride).fill(0xa5);
				writeCodec.serialize(c.value, new DataView(bytes.buffer), 0);

				for (const [reader, readCodec] of Object.entries(codecs)) {
					const decoded = readCodec.deserialize(new DataView(bytes.buffer), 0);
					expect(decoded, `${reader} reading ${writer}'s bytes`).toMatchObject(
						c.value,
					);
				}
			}
		});
	}
});
