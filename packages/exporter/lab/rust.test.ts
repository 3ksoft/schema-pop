/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { compileMigration } from "./rust";

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
	test("emits correct Rust function header", async () => {
		const out = await migrate("x: v1.a");
		expect(out).toContain("pub fn migrate_v(src: &[u8], dst: &mut [u8])");
	});

	test("wraps body in unsafe block", async () => {
		const out = await migrate("x: v1.a");
		expect(out).toContain("unsafe {");
	});
});

// ── Member access ─────────────────────────────────────────────────────────────

describe("member access", () => {
	test("simple field copy resolves to correct type and offset", async () => {
		const out = await migrate("x: v1.a");
		expect(out).toContain("*(dst.as_mut_ptr().add(0) as *mut i32)");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
	});

	test("float field reads as f32 and writes as f64 with cast", async () => {
		const out = await migrate("y: v1.rate");
		expect(out).toContain("*(dst.as_mut_ptr().add(8) as *mut f64)");
		expect(out).toContain("*(src.as_ptr().add(12) as *const f32)");
		expect(out).toContain("as f64");
	});

	test("bool field reads as u8 with != 0 guard", async () => {
		// Use a bool plan where dst also accepts a bool-like field.
		const boolDst: any = {
			version: "v2",
			endian: "le",
			wordSize: 64,
			autoLayout: false,
			types: [
				{
					kind: "struct",
					name: "Dst",
					size: 1,
					paddedSize: 1,
					align: 1,
					fields: [f("flag", "bool", 1, 0)],
				},
			],
		};
		const out = await compileMigration(
			"function m(v1: Src): Dst { return { flag: v1.flag }; }",
			SRC,
			boolDst,
		);
		expect(out).toContain("*(src.as_ptr().add(8) as *const u8) != 0");
	});

	test("unresolved member emits comment", async () => {
		const out = await migrate("x: v1.unknown");
		expect(out).toContain("/* unresolved:");
	});
});

// ── Shorthand property ────────────────────────────────────────────────────────

describe("shorthand property", () => {
	test("shorthand copies src→dst offsets with correct pointer types", async () => {
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
		expect(out).toContain("*(dst.as_mut_ptr().add(4) as *mut u32)");
		expect(out).toContain("*(src.as_ptr().add(0) as *const u32)");
	});
});

// ── Binary operators ──────────────────────────────────────────────────────────

describe("binary operators", () => {
	test("arithmetic +", async () => {
		const out = await migrate("x: v1.a + v1.b");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
		expect(out).toContain("*(src.as_ptr().add(4) as *const i32)");
		expect(out).toContain("+");
	});

	test("arithmetic *", async () => {
		const out = await migrate("x: v1.a * v1.b");
		expect(out).toContain("*");
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

	test("strict equality === maps to ==", async () => {
		const out = await migrate("x: v1.a === v1.b");
		expect(out).toContain("==");
		expect(out).not.toContain("===");
	});

	test("strict inequality !== maps to !=", async () => {
		const out = await migrate("x: v1.a !== v1.b");
		expect(out).toContain("!=");
		expect(out).not.toContain("!==");
	});
});

// ── Ternary → if-else ─────────────────────────────────────────────────────────

describe("ternary", () => {
	test("emits Rust if-else expression", async () => {
		const out = await migrate("x: v1.flag ? v1.a : v1.b");
		expect(out).toContain("if ");
		expect(out).toContain("} else {");
		expect(out).toContain("*(src.as_ptr().add(8) as *const u8) != 0");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
		expect(out).toContain("*(src.as_ptr().add(4) as *const i32)");
	});
});

// ── Null coalescing ?? ────────────────────────────────────────────────────────

describe("nullish coalescing ??", () => {
	test("emits Rust if-else with != 0 guard", async () => {
		const out = await migrate("x: v1.a ?? 0");
		expect(out).toContain("!= 0");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
		expect(out).toContain("} else {");
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
		expect(out).toContain("99");
	});

	test("true emits true", async () => {
		const out = await migrate("x: true");
		expect(out).toContain("true");
	});

	test("false emits false", async () => {
		const out = await migrate("x: false");
		expect(out).toContain("false");
	});

	test("null → 0", async () => {
		const out = await migrate("x: null");
		expect(out).toContain("(0)");
	});

	test("undefined → 0", async () => {
		const out = await migrate("x: undefined");
		expect(out).toContain("(0)");
	});
});

// ── Type assertions ───────────────────────────────────────────────────────────

describe("as expression", () => {
	test("strips TS cast and emits inner expression", async () => {
		const out = await migrate("x: v1.a as number");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
	});
});

// ── Unary operators ───────────────────────────────────────────────────────────

describe("unary operators", () => {
	test("! (logical NOT) is emitted", async () => {
		const out = await migrate("x: !v1.a");
		expect(out).toContain("!");
	});

	test("- (negation) is emitted", async () => {
		const out = await migrate("x: -v1.a");
		expect(out).toContain("-*(src.as_ptr().add(0) as *const i32)");
	});

	test("~ (bitwise NOT) maps to ! in Rust", async () => {
		const out = await migrate("x: ~v1.a");
		expect(out).toContain("!*(src.as_ptr().add(0) as *const i32)");
	});
});

// ── call_expression ───────────────────────────────────────────────────────────

describe("call_expression — global casts", () => {
	test("Number(x) → (x) as f64", async () => {
		const out = await migrate("y: Number(v1.a)");
		expect(out).toContain("as f64");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
	});

	test("BigInt(x) → (x) as i64", async () => {
		const out = await migrate("y: BigInt(v1.a)");
		expect(out).toContain("as i64");
	});

	test("Boolean(x) → (x) != 0", async () => {
		const out = await migrate("x: Boolean(v1.a)");
		expect(out).toContain("!= 0");
	});

	test("parseInt(x) → (x) as i32", async () => {
		const out = await migrate("x: parseInt(v1.a)");
		expect(out).toContain("as i32");
	});

	test("parseFloat(x) → (x) as f32", async () => {
		const out = await migrate("y: parseFloat(v1.rate)");
		expect(out).toContain("as f32");
	});

	test("unknown call emits comment", async () => {
		const out = await migrate("x: myFn(v1.a)");
		expect(out).toContain("/* unresolved call:");
	});
});

describe("call_expression — Math.*", () => {
	test("Math.floor(x) → (x).floor()", async () => {
		const out = await migrate("y: Math.floor(v1.rate)");
		expect(out).toContain(".floor()");
	});

	test("Math.ceil(x) → (x).ceil()", async () => {
		const out = await migrate("y: Math.ceil(v1.rate)");
		expect(out).toContain(".ceil()");
	});

	test("Math.round(x) → (x).round()", async () => {
		const out = await migrate("y: Math.round(v1.rate)");
		expect(out).toContain(".round()");
	});

	test("Math.trunc(x) → (x).trunc()", async () => {
		const out = await migrate("y: Math.trunc(v1.rate)");
		expect(out).toContain(".trunc()");
	});

	test("Math.abs(x) → (x).abs()", async () => {
		const out = await migrate("x: Math.abs(v1.a)");
		expect(out).toContain(".abs()");
	});

	test("Math.max(a, b) → (a).max(b)", async () => {
		const out = await migrate("x: Math.max(v1.a, v1.b)");
		expect(out).toContain(".max(");
		expect(out).toContain("*(src.as_ptr().add(0) as *const i32)");
		expect(out).toContain("*(src.as_ptr().add(4) as *const i32)");
	});

	test("Math.min(a, b) → (a).min(b)", async () => {
		const out = await migrate("x: Math.min(v1.a, v1.b)");
		expect(out).toContain(".min(");
	});
});
