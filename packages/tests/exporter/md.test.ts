/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import type { FunctionPlan, LayoutPlan } from "@schema-pop/schema";
import { scope } from "arktype";
import { binary } from "@schema-pop/schema";
import { md } from "@schema-pop/exporter";
import { analyze } from "./utils";

describe("md exporter", () => {
	test("renders struct with field table + sizes", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Battery: { voltage_mv: "u32", flags: "u8" },
			}),
			"v1",
		);
		const out = md().generate(plan);
		expect(out).toContain("## types");
		expect(out).toContain("### `Battery`");
		expect(out).toContain("| Offset | Field | Type | Size | Notes |");
		expect(out).toContain("`voltage_mv`");
		expect(out).toContain("`u32`");
		expect(out).toContain("`flags`");
	});

	test("renders enum variants", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Status: "'Idle' | 'Active' | 'Error'",
			}),
			"v1",
		);
		const out = md().generate(plan);
		expect(out).toContain("### `Status`");
		expect(out).toContain("| Variant | Value |");
		expect(out).toContain("`Active`");
	});

	test("renders alias as inline reference", () => {
		const plan = analyze(scope({ ...binary.import(), DeviceId: "u32" }), "v1");
		const out = md().generate(plan);
		expect(out).toContain("### `DeviceId`");
		expect(out).toMatch(/Alias for `u32`/);
	});

	test("renders functions section when plan.functions populated", () => {
		const plan = analyze(
			scope({ ...binary.import(), Battery: { x: "u32" } }),
			"v1",
		);
		const fns: FunctionPlan[] = [
			{
				name: "battery_read",
				symbol: "battery_read",
				abi: "C",
				description: "Read battery state.",
				returnType: { kind: "unit" },
				args: [
					{
						name: "id",
						type: {
							kind: "primitive",
							name: "u32",
							size: 4,
							align: 4,
							paddedSize: 4,
							popKind: "binary",
						} as any,
					},
				],
			},
		];
		plan.functions = fns;
		const out = md().generate(plan);
		expect(out).toContain("## functions");
		expect(out).toContain("### `battery_read`");
		expect(out).toContain('extern "C"');
		expect(out).toContain("Read battery state");
		expect(out).toContain("battery_read(id: u32) -> void");
	});

	test("no functions → no functions section", () => {
		const plan = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const out = md().generate(plan);
		expect(out).not.toContain("## functions");
	});

	test("preamble option prepends raw markdown", () => {
		const plan = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "v1");
		const out = md({ preamble: "# Custom title\n\nIntro paragraph." }).generate(
			plan,
		);
		expect(out.indexOf("# Custom title")).toBe(0);
		expect(out).toContain("## types");
	});

	test("wrapVersion wraps multi-version output with `# v...`", () => {
		const exp = md();
		const wrapped = exp.wrapVersion!("v1", "## types\n");
		expect(wrapped).toContain("# vv1");
	});
});
