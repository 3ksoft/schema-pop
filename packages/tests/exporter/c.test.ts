/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { c } from "@schema-pop/exporter";

describe("c exporter — useOriginalType", () => {
	function planWithOriginalTypes(): any {
		// Hand-construct a plan as an importer would after writing
		// `kind: "any", originalType: "X"` for unresolved fields.
		return {
			endian: "le",
			wordSize: 64,
			autoLayout: false,
			version: "v1",
			types: [
				{
					kind: "struct",
					name: "Frame",
					size: 24,
					align: 8,
					paddedSize: 24,
					fields: [
						{
							name: "len",
							type: {
								kind: "primitive",
								name: "u32",
								size: 4,
								align: 4,
								paddedSize: 4,
							},
							offset: 0,
							size: 4,
							bitOffset: 0,
							bitSize: 32,
							paddingAfter: 0,
						},
						{
							name: "count",
							type: { kind: "any", originalType: "size_t" },
							offset: 8,
							size: 8,
							bitOffset: 0,
							bitSize: 64,
							paddingAfter: 0,
						},
						{
							name: "label",
							type: { kind: "any", originalType: "char[16]" },
							offset: 16,
							size: 16,
							bitOffset: 0,
							bitSize: 128,
							paddingAfter: 0,
						},
					],
				},
			],
		};
	}

	test("default emits original C spelling, not byte blob", () => {
		const out = c({ dest: "out.h" }).generate(planWithOriginalTypes());
		// `size_t` is valid C — preserved verbatim instead of `uint8_t count[8]`.
		expect(out).toContain("size_t count;");
		// Array suffix split: `char[16]` → `char label[16]`.
		expect(out).toContain("char label[16];");
		// Should NOT have leaked the `[u8; ...]` shape onto labels.
		expect(out).not.toMatch(/uint8_t count\[/);
	});

	test("useOriginalType: false → struct skipped as rich-tier", () => {
		// With the cheat off, an `any`-kind field has no honest C
		// representation, so isRichType filters the whole struct (the
		// pre-cheat default behavior). Output is empty.
		const out = c({ dest: "out.h", useOriginalType: false }).generate(
			planWithOriginalTypes(),
		);
		expect(out).not.toContain("Frame");
	});
});

