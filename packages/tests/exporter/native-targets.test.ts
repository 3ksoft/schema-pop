/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary } from "@schema-pop/schema";
import { exportPlan } from "@schema-pop/exporter";
import { analyze } from "./utils";

/**
 * Cross-target checks for the four native struct exporters (c / cpp / rust /
 * zig) against ONE shared plan.
 *
 * `wgsl.test.ts` covers the GPU target in depth and `rust.test.ts` covers
 * Rust-specific emission; cpp and zig had no coverage at all. The value here is
 * comparative: the same plan must come out the other side with the same field
 * order, the same padding intent and the same version namespace in every
 * language, because the ABI harness compiles them and expects them to agree.
 */

const mod = scope({
	...binary.import(),
	Mode: "'idle' | 'run' | 'halt'",
	Vec3: { x: "f32", y: "f32", z: "f32" },
	// `flag` and `mode` each leave a 3-byte hole — the interesting part.
	Sample: { id: "u32", flag: "u8", position: "Vec3", mode: "Mode" },
});

const plan = analyze(mod, "1.0.0");
const out = {
	c: String(exportPlan(plan, "c", {})),
	cpp: String(exportPlan(plan, "cpp", {})),
	rust: String(exportPlan(plan, "rust", {})),
	zig: String(exportPlan(plan, "zig", {})),
};
/** Targets that materialise the plan's padding as real struct members. */
const EXPLICIT_PADDING = ["cpp", "rust", "zig"] as const;

describe("native exporters — shared plan", () => {
	test("the plan under test actually contains the padding holes", () => {
		const sample = plan.types.find((t) => t.name === "Sample");
		expect(sample?.kind).toBe("struct");
		if (sample?.kind !== "struct") return;
		expect(
			sample.fields.map((f) => [f.name, f.offset, f.paddingAfter]),
		).toEqual([
			["id", 0, 0],
			["flag", 4, 3],
			["position", 8, 0],
			["mode", 20, 3],
		]);
		expect(sample.paddedSize).toBe(24);
	});

	for (const target of ["c", "cpp", "rust", "zig"] as const) {
		test(`${target} declares every plan type, dependencies first`, () => {
			const code = out[target];
			for (const name of ["Mode", "Vec3", "Sample"]) {
				expect(code, `${target} declares ${name}`).toContain(name);
			}
			// Vec3 is a field of Sample, so it must be declared before it or the
			// generated header/module won't compile.
			expect(code.indexOf("Vec3")).toBeLessThan(code.lastIndexOf("Sample"));
		});

		test(`${target} keeps the declared field order`, () => {
			const code = out[target];
			const positions = ["id", "flag", "position", "mode"].map((f) =>
				code.indexOf(f),
			);
			for (const p of positions) expect(p).toBeGreaterThan(-1);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		});

		test(`${target} namespaces the types under the version`, () => {
			expect(out[target]).toContain("v1_0_0");
		});
	}

	for (const target of EXPLICIT_PADDING) {
		test(`${target} materialises both padding holes as struct members`, () => {
			const code = out[target];
			expect(code, `${target} pads after flag`).toContain("_pad_flag");
			expect(code, `${target} pads after mode`).toContain("_pad_mode");
			// 3 bytes each — spelled `[3]u8` (zig), `[u8; 3]` (rust), `[3]` (cpp).
			expect(code).toMatch(/_pad_flag(: \[3\]u8|: \[u8; 3\]|\[3\])/);
		});
	}

	test("c relies on the compiler's natural padding instead of pad members", () => {
		// Deliberate divergence from the other three: the C exporter emits a
		// plain struct and lets the C ABI produce the same offsets. That holds
		// for `aligned` layouts (as asserted by the offsets above) but means C
		// carries no explicit record of the plan's padding. Pinned here so the
		// difference is a decision, not a surprise.
		expect(out.c).not.toContain("_pad_flag");
		expect(out.c).toMatch(/typedef struct v1_0_0_Sample/);
	});

	test("each target lowers the string enum to its own idiom", () => {
		// C: typedef + #define constants
		expect(out.c).toMatch(/typedef uint8_t v1_0_0_Mode/);
		expect(out.c).toContain("V1_0_0_MODE_HALT");
		// C++: using alias + constexpr constants
		expect(out.cpp).toMatch(/using Mode = uint8_t/);
		expect(out.cpp).toMatch(/constexpr Mode Mode_halt = 2/);
		// Rust: a real repr(u8) enum
		expect(out.rust).toMatch(/#\[repr\(u8\)\]/);
		expect(out.rust).toMatch(/Halt = 2/);
		// Zig: pub const alias + typed constants
		expect(out.zig).toMatch(/pub const Mode = u8/);
		expect(out.zig).toMatch(/pub const Mode_halt: Mode = 2/);
	});

	test("cpp and rust pin the struct alignment explicitly", () => {
		// The harness compares alignof against the plan, so the alignment has to
		// be declared rather than inferred.
		expect(out.cpp).toMatch(/struct alignas\(4\) Vec3/);
		expect(out.rust).toMatch(/#\[repr\(C, align\(4\)\)\]/);
		// Zig gets it from `extern struct`, which follows the C ABI.
		expect(out.zig).toMatch(/pub const Vec3 = extern struct/);
	});
});
