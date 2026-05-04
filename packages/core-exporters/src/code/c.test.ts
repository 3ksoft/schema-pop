/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { compileMigration } from "./c";

// ── Minimal plan fixtures ─────────────────────────────────────────────────────

function prim(name: string, size: number): any {
	return {
		kind: "primitive",
		name,
		size,
		align: size,
		paddedSize: size,
		bitSize: size * 8,
	};
}

function f(name: string, typeName: string, size: number, offset: number): any {
	return {
		name,
		type: prim(typeName, size),
		offset,
		size,
		paddingAfter: 0,
		bitOffset: 0,
		bitSize: size * 8,
	};
}

// Src: a(i32@0)  b(i32@4)  flag(bool@8)  rate(f32@12)
const SRC: any = {
	version: "v1",
	endian: "le",
	wordSize: 64,
	autoLayout: false,
	types: [
		{
			kind: "struct",
			name: "Src",
			size: 16,
			paddedSize: 16,
			align: 4,
			fields: [
				f("a", "i32", 4, 0),
				f("b", "i32", 4, 4),
				f("flag", "bool", 1, 8),
				f("rate", "f32", 4, 12),
			],
		},
	],
};

// Dst: x(i32@0)  y(f64@8)
const DST: any = {
	version: "v2",
	endian: "le",
	wordSize: 64,
	autoLayout: false,
	types: [
		{
			kind: "struct",
			name: "Dst",
			size: 16,
			paddedSize: 16,
			align: 8,
			fields: [f("x", "i32", 4, 0), f("y", "f64", 8, 8)],
		},
	],
};

function migrate(body: string): Promise<string> {
	const src = `function migrate_v(v1: Src): Dst { return { ${body} }; }`;
	return compileMigration(src, SRC, DST);
}

// ── Function signature ────────────────────────────────────────────────────────

describe("signature", () => {
	test("emits correct C function header", async () => {
		const out = await migrate("x: v1.a");
		expect(out).toContain("void migrate_v(const uint8_t* src, uint8_t* dst)");
	});

	test("includes stdint / stdbool / math headers", async () => {
		const out = await migrate("x: v1.a");
		expect(out).toContain("#include <stdint.h>");
		expect(out).toContain("#include <stdbool.h>");
		expect(out).toContain("#include <math.h>");
	});
});

// ── Member access ─────────────────────────────────────────────────────────────

describe("member access", () => {
	test("simple field copy resolves to correct type and offset", async () => {
		const out = await migrate("x: v1.a");
		expect(out).toContain("*(int32_t*)(dst + 0) = *(int32_t*)(src + 0)");
	});

	test("float field uses float* cast", async () => {
		const out = await migrate("y: v1.rate");
		expect(out).toContain("*(double*)(dst + 8) = *(float*)(src + 12)");
	});

	test("unresolved member emits comment", async () => {
		const out = await migrate("x: v1.unknown");
		expect(out).toContain("/* unresolved:");
	});
});

// ── Shorthand property ────────────────────────────────────────────────────────

describe("shorthand property", () => {
	test("shorthand copies src→dst offsets", async () => {
		// Same-named struct with field 'count' at different offsets.
		const from: any = {
			version: "v1",
			endian: "le",
			wordSize: 64,
			autoLayout: false,
			types: [
				{
					kind: "struct",
					name: "S",
					size: 4,
					paddedSize: 4,
					align: 4,
					fields: [f("count", "u32", 4, 0)],
				},
			],
		};
		const to: any = {
			version: "v2",
			endian: "le",
			wordSize: 64,
			autoLayout: false,
			types: [
				{
					kind: "struct",
					name: "S",
					size: 8,
					paddedSize: 8,
					align: 4,
					fields: [f("pad", "u32", 4, 0), f("count", "u32", 4, 4)],
				},
			],
		};
		const out = await compileMigration(
			"function m(v1: S): S { return { count }; }",
			from,
			to,
		);
		expect(out).toContain("*(uint32_t*)(dst + 4) = *(uint32_t*)(src + 0)");
	});
});

// ── Binary operators ──────────────────────────────────────────────────────────

describe("binary operators", () => {
	test("arithmetic +", async () => {
		const out = await migrate("x: v1.a + v1.b");
		expect(out).toContain("(*(int32_t*)(src + 0) + *(int32_t*)(src + 4))");
	});

	test("arithmetic *", async () => {
		const out = await migrate("x: v1.a * v1.b");
		expect(out).toContain("(*(int32_t*)(src + 0) * *(int32_t*)(src + 4))");
	});

	test("logical &&", async () => {
		const out = await migrate("x: v1.a && v1.b");
		expect(out).toContain("&&");
	});

	test("logical ||", async () => {
		const out = await migrate("x: v1.a || v1.b");
		expect(out).toContain("||");
	});

	test("comparison >=", async () => {
		const out = await migrate("x: v1.a >= v1.b");
		expect(out).toContain(">=");
	});
});

// ── Ternary ───────────────────────────────────────────────────────────────────

describe("ternary", () => {
	test("emits C ternary with correct operands", async () => {
		const out = await migrate("x: v1.flag ? v1.a : v1.b");
		expect(out).toContain("*(bool*)(src + 8)");
		expect(out).toContain("*(int32_t*)(src + 0)");
		expect(out).toContain("*(int32_t*)(src + 4)");
		expect(out).toContain("?");
		expect(out).toContain(":");
	});
});

// ── Null coalescing ?? ────────────────────────────────────────────────────────

describe("nullish coalescing ??", () => {
	test("emits ternary with != 0 guard", async () => {
		const out = await migrate("x: v1.a ?? 0");
		expect(out).toContain("!= 0");
		expect(out).toContain("*(int32_t*)(src + 0)");
	});

	test("rhs literal is present in output", async () => {
		const out = await migrate("x: v1.a ?? 42");
		expect(out).toContain("42");
		expect(out).toContain("!= 0");
	});
});

// ── Literals ──────────────────────────────────────────────────────────────────

describe("literals", () => {
	test("number literal is emitted verbatim", async () => {
		const out = await migrate("x: 99");
		expect(out).toContain("= 99");
	});

	test("true → 1", async () => {
		const out = await migrate("x: true");
		expect(out).toContain("= 1");
	});

	test("false → 0", async () => {
		const out = await migrate("x: false");
		expect(out).toContain("= 0");
	});

	test("null → 0", async () => {
		const out = await migrate("x: null");
		expect(out).toContain("= 0");
	});

	test("undefined → 0", async () => {
		const out = await migrate("x: undefined");
		expect(out).toContain("= 0");
	});
});

// ── Type assertions ───────────────────────────────────────────────────────────

describe("as expression", () => {
	test("strips cast and emits inner expression", async () => {
		const out = await migrate("x: v1.a as number");
		expect(out).toContain("*(int32_t*)(dst + 0) = *(int32_t*)(src + 0)");
	});
});

// ── call_expression ───────────────────────────────────────────────────────────

describe("call_expression — global casts", () => {
	test("Number(x) → (double)(x)", async () => {
		const out = await migrate("y: Number(v1.a)");
		expect(out).toContain("(double)(*(int32_t*)(src + 0))");
	});

	test("BigInt(x) → (int64_t)(x)", async () => {
		const out = await migrate("y: BigInt(v1.a)");
		expect(out).toContain("(int64_t)(*(int32_t*)(src + 0))");
	});

	test("Boolean(x) → ((x) != 0)", async () => {
		const out = await migrate("x: Boolean(v1.a)");
		expect(out).toContain("!= 0");
	});

	test("parseInt(x) → (int32_t)(x)", async () => {
		const out = await migrate("x: parseInt(v1.a)");
		expect(out).toContain("(int32_t)(*(int32_t*)(src + 0))");
	});

	test("parseFloat(x) → (float)(x)", async () => {
		const out = await migrate("y: parseFloat(v1.rate)");
		expect(out).toContain("(float)(*(float*)(src + 12))");
	});

	test("unknown call emits comment", async () => {
		const out = await migrate("x: myFn(v1.a)");
		expect(out).toContain("/* unresolved call:");
	});
});

describe("call_expression — Math.*", () => {
	test("Math.floor(x) → floor(x)", async () => {
		const out = await migrate("y: Math.floor(v1.rate)");
		expect(out).toContain("floor(*(float*)(src + 12))");
	});

	test("Math.ceil(x) → ceil(x)", async () => {
		const out = await migrate("y: Math.ceil(v1.rate)");
		expect(out).toContain("ceil(*(float*)(src + 12))");
	});

	test("Math.round(x) → round(x)", async () => {
		const out = await migrate("y: Math.round(v1.rate)");
		expect(out).toContain("round(*(float*)(src + 12))");
	});

	test("Math.abs(x) → ternary", async () => {
		const out = await migrate("x: Math.abs(v1.a)");
		expect(out).toContain("< 0 ?");
	});

	test("Math.max(a, b) → ternary", async () => {
		const out = await migrate("x: Math.max(v1.a, v1.b)");
		expect(out).toContain("*(int32_t*)(src + 0)");
		expect(out).toContain("*(int32_t*)(src + 4)");
		expect(out).toContain(">");
	});

	test("Math.min(a, b) → ternary", async () => {
		const out = await migrate("x: Math.min(v1.a, v1.b)");
		expect(out).toContain("<");
	});
});
