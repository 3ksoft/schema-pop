/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, wgsl as wgslSchema } from "../../schema/src";
import { wgsl } from "../../exporter/src";
import { analyze } from "./utils";
import { fromModule, SchemaAnalyzer } from "../../core/src";

function gen(s: any, cfg: Parameters<typeof wgsl>[0] = { dest: "out.wgsl" }) {
	return wgsl(cfg).generate(analyze(scope({ ...wgslSchema.import(), ...s }), "v1"));
}

function genStd430(
	s: any,
	cfg: Parameters<typeof wgsl>[0] = { dest: "out.wgsl" },
) {
	return wgsl(cfg).generate(
		analyze(scope({ ...wgslSchema.import(), ...s }), "v1", "std430"),
	);
}

describe("wgsl exporter — primitive types", () => {
	test("generates proper unpacker for small types", () => {
		const sc = scope({
			...wgslSchema.import(),
			Color: "u8[] == 4",
			Struct: {
				field: "Color"
			}
		});
		const mod = sc.export();
		const schema = fromModule(mod);
		const plan = new SchemaAnalyzer().analyze(schema);
		const out = wgsl({ outputStyle: "helpers" }).generate(plan);
		expect(out).not.toContain("NaN");
	});


	test("u8/u16/u32 all collapse to u32", () => {
		const out = gen({ S: { a: "u8", b: "u16", c: "u32" } });
		// every field should appear, all typed as u32
		expect(out).toMatch(/a:\s*u32/);
		expect(out).toMatch(/b:\s*u32/);
		expect(out).toMatch(/c:\s*u32/);
	});

	test("i8/i16/i32 all collapse to i32", () => {
		const out = gen({ S: { a: "i8", b: "i16", c: "i32" } });
		expect(out).toMatch(/a:\s*i32/);
		expect(out).toMatch(/b:\s*i32/);
		expect(out).toMatch(/c:\s*i32/);
	});

	test("f32 emits f32", () => {
		const out = gen({ S: { x: "f32" } });
		expect(out).toContain("x: f32");
	});
});

describe("wgsl exporter — vectors and arrays", () => {
	test("f32[] == 2/3/4 lower to vec2/3/4<f32>", () => {
		const out = gen({
			S: { a: "f32[] == 2", b: "f32[] == 3", c: "f32[] == 4" },
		});
		expect(out).toMatch(/a:\s*(@size\(\d+\)\s*)?vec2<f32>/);
		expect(out).toMatch(/b:\s*(@size\(\d+\)\s*)?vec3<f32>/);
		expect(out).toMatch(/c:\s*(@size\(\d+\)\s*)?vec4<f32>/);
	});

	test("i32[] == 2 lowers to vec2<i32>", () => {
		const out = gen({ S: { v: "i32[] == 2" } });
		expect(out).toMatch(/v:\s*(@size\(\d+\)\s*)?vec2<i32>/);
	});

	test("fixed-length arrays > 4 emit array<T, N>", () => {
		const out = gen({ S: { hits: "i32[] == 16" } });
		expect(out).toMatch(/hits:\s*(@size\(\d+\)\s*)?array<i32,\s*16>/);
	});
});

describe("wgsl exporter — alias", () => {
	test("alias to f32 vector emits `alias Name = vecN<f32>;`", () => {
		const out = gen({ Vec2: "f32[] == 2" });
		expect(out).toContain("alias Vec2 = vec2<f32>;");
	});

	test("alias to i32 vector emits IVec form", () => {
		const out = gen({ IVec2: "i32[] == 2" });
		expect(out).toContain("alias IVec2 = vec2<i32>;");
	});
});

describe("wgsl exporter — struct shape", () => {
	test("struct emits header + closing brace", () => {
		const out = gen({ S: { x: "f32" } });
		expect(out).toMatch(/struct S \{[\s\S]*\};/);
	});

	test("nested struct via reference emits referenced type name", () => {
		const out = gen({
			Particle: { pos: "f32[] == 2", mass: "f32" },
			Body: { p: "Particle" },
		});
		expect(out).toContain("struct Particle");
		expect(out).toContain("struct Body");
		expect(out).toMatch(/p:\s*Particle/);
	});

	test("packed struct with nested struct reference uses unpack_words_to_ helper", () => {
		// A small struct (TypesMask) that gets packed into a shared word,
		// referenced by a larger struct. The unpack should call the nested
		// struct's unpack_words_to_ helper, not try to construct it with
		// extractBits as a single-argument constructor.
		const out = gen({
			TypesMask: { type: "u8", flags: "u8" },
			Container: {
				id: "u32",
				mask: "TypesMask",
			},
		});
		expect(out).toContain("struct TypesMask");
		expect(out).toMatch(/unpack_words_to_types_mask\(/);
		// Should NOT emit a broken single-argument struct constructor
		expect(out).not.toMatch(/TypesMask\(extractBits/);
		expect(out).not.toMatch(/types_mask = TypesMask\(/);
	});

	test("unions should pack properly", () => {
		const out = gen({
			None: { kind: "'none'" },
			Some: { kind: "'some'", value: "u32" },
			AnyOf: "None | Some",
		});
		expect(out).not.toContain("array<u32, 1>");

	});

	test("size should be properly calculated", () => {
		const out = gen({
			Zone: {
				kind: "'zone'",
				bounds: "vec4f",
			},
			Obstacle: {
				kind: "'obstacle'",
				pos: ["vec2f", "=", () => [0, 0]],
				rotation: "f32",
				material: { mass: "f32" },
				enabled: "boolean = true",
				static: "boolean = true",
				round: "boolean = true"
			},
			GameObject: "Zone | Obstacle"
		});
		expect(out).toContain("array<u32, 1>");

	});

});

describe("wgsl exporter — padding", () => {
	// std430: f32 followed by vec4<f32> forces 12 bytes of trailing padding
	// on the f32 (vec4 needs 16-byte alignment). Clean fixture for padding
	// without u8→u32 widening side-effects.
	const padFixture = { S: { tag: "f32", v: "f32[] == 4" } };

	test("default paddingStyle 'fields' emits explicit named pad slots", () => {
		const out = genStd430(padFixture);
		expect(out).toMatch(/_pad_tag/);
		expect(out).not.toMatch(/@size\(/);
	});

	test("paddingStyle 'size' emits @size(N) annotation", () => {
		const out = genStd430(padFixture, {
			dest: "out.wgsl",
			paddingStyle: "size",
		});
		expect(out).toMatch(/@size\(\d+\)\s+tag:/);
		expect(out).not.toMatch(/_pad_tag/);
	});
});

describe("wgsl exporter — error/warning paths", () => {
	test("f64 throws (WGSL has no 64-bit float)", () => {
		expect(() => gen({ S: { x: "f64" } })).toThrow(/f64/);
	});
});

describe("wgsl exporter — bool", () => {
	test("bool fields are emitted as u32 (host-shareable structs cannot contain bool)", () => {
		const out = gen({ S: { flag: "boolean" } });
		expect(out).toMatch(/flag:\s*u32/);
	});
});

describe("wgsl exporter — bitfields", () => {
	test("bitfield struct emits _bitfield_N container field", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		expect(out).toContain("_bitfield_0: u32");
	});

	test("unpacked helper struct is emitted with correct field types", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		expect(out).toMatch(/struct FlagsUnpacked \{/);
		expect(out).toMatch(/a:\s*bool/);
		expect(out).toMatch(/b:\s*u32/);
		expect(out).toMatch(/c:\s*u32/);
	});

	test("unpack function is emitted with correct shift and mask per field", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		expect(out).toMatch(/fn unpack_flags\(packed: Flags\) -> FlagsUnpacked/);
		expect(out).toMatch(/bool\(_raw0 & 0x1u\)/);    // a: u1
		expect(out).toMatch(/_raw0 >> 1u\) & 0x7u/);   // b: u3 at bitOffset 1
		expect(out).toMatch(/_raw0 >> 4u\) & 0xFu/);   // c: u4 at bitOffset 4
	});

	test("fields spanning two bytes emit two raw let bindings in unpack", () => {
		// u5 + u5 = 10 bits → byte 0 and byte 1
		const out = gen({ Wide: { x: "u5", y: "u5" } });
		expect(out).toMatch(/_raw0/);
		expect(out).toMatch(/_raw1/);
	});

	test("pack function is emitted symmetric to unpack", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		expect(out).toMatch(/fn pack_flags\(unpacked: FlagsUnpacked\) -> Flags/);
		// each bitfield word gets zero-initialized once, then OR'd per field
		expect(out).toMatch(/out\._bitfield_0 = 0u;/);
		// bool at bitOffset 0 uses select() with no shift; bit-width fields mask & shift
		expect(out).toMatch(
			/out\._bitfield_0 \|= select\(0u, 1u, unpacked\.a\);/,
		);
		expect(out).toMatch(/\(unpacked\.b & 0x7u\) << 1u/);
		expect(out).toMatch(/\(unpacked\.c & 0xFu\) << 4u/);
	});

	test("pack handles bitfields spanning two bytes with separate word writes", () => {
		const out = gen({ Wide: { x: "u5", y: "u5" } });
		expect(out).toMatch(/fn pack_wide\(unpacked: WideUnpacked\) -> Wide/);
		expect(out).toMatch(/out\._bitfield_0 = 0u;/);
		expect(out).toMatch(/out\._bitfield_1 = 0u;/);
	});
});
