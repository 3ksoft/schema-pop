/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import type { LayoutPlan } from "@schema-pop/schema";
import { scope } from "arktype";
import { binary } from "@schema-pop/schema";
import { nuxtUi } from "@schema-pop/exporter";
import { analyze } from "./utils";

function asMap(out: string | Record<string, string>): Record<string, string> {
	if (typeof out === "string") throw new Error("expected multi-file output");
	return out;
}

describe("nuxt-ui exporter — schemas.ts (arktype, standalone)", () => {
	test("emits a self-contained scope — no runtime dep on schema-pop", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Sample: { tiny: "u8", word: "u32", signed: "i32", flag: "bool" },
			}),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		const schemas = out["schemas.ts"]!;
		expect(schemas).toContain('import { scope } from "arktype";');
		// Generated artifact must work standalone (writing_own_exporters.md §9).
		expect(schemas).not.toContain('from "@schema-pop/schema"');
		expect(schemas).not.toContain("binary.import");
		expect(schemas).toContain("export const $ = scope({");
		// Only referenced primitives are hoisted — inlined bounds, not Zod.
		expect(schemas).toContain('u8: "0 <= number.integer <= 255"');
		expect(schemas).toContain('u32: "0 <= number.integer <= 4294967295"');
		expect(schemas).toContain(
			'i32: "-2147483648 <= number.integer <= 2147483647"',
		);
		expect(schemas).toContain('bool: "boolean"');
		expect(schemas).not.toContain("z.number()");
		// Field defs reference the hoisted alias by name (DRY within the scope).
		expect(schemas).toMatch(/"tiny":\s*"u8"/);
		expect(schemas).toMatch(/"word":\s*"u32"/);
		expect(schemas).toMatch(/"signed":\s*"i32"/);
		expect(schemas).toMatch(/"flag":\s*"bool"/);
		// Destructure-rename to ${Name}Schema + inferred type alias.
		expect(schemas).toContain("Sample: SampleSchema");
		expect(schemas).toContain(
			"export type Sample = typeof SampleSchema.infer;",
		);
	});

	test("only hoists primitives the schema actually references", () => {
		const plan = analyze(
			scope({ ...binary.import(), Tiny: { x: "u8" } }),
			"v1",
		);
		const schemas = asMap(nuxtUi().generate(plan))["schemas.ts"]!;
		expect(schemas).toContain("u8:");
		// Unused primitives stay out of the file.
		expect(schemas).not.toContain("u32:");
		expect(schemas).not.toContain("i64:");
		expect(schemas).not.toContain("f64:");
	});

	test("renders enum reference as string union + USelectMenu in form", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Mode: "'idle' | 'active' | 'error'",
				Device: { mode: "Mode", id: "u16" },
			}),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		const schemas = out["schemas.ts"]!;
		// Enum emitted as a quoted arktype union literal inside the scope.
		expect(schemas).toMatch(/Mode:\s*"'[^"]+'"/);
		for (const lit of ["'idle'", "'active'", "'error'"]) {
			expect(schemas).toContain(lit);
		}
		// Field-level reference is a bare alias name, resolved by the scope.
		expect(schemas).toMatch(/"mode":\s*"Mode"/);
		const form = out["DeviceForm.vue"]!;
		expect(form).toContain("USelectMenu");
		expect(form).toMatch(/:items='\[.*"idle".*\]'/);
	});

	test("optional encodes as `key?` in arktype object literal", () => {
		const plan = analyze(
			scope({ ...binary.import(), Cfg: { name: "string", age: "u8?" } }),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		const schemas = out["schemas.ts"]!;
		// Optional marker on the key, no `.optional()` chain.
		expect(schemas).toMatch(/"age\?":\s*"u8"/);
		expect(schemas).not.toContain(".optional()");
		const form = out["CfgForm.vue"]!;
		expect(form).toContain("unset");
		expect(form).toContain("UCheckbox");
	});

	test("string maxLength maps to arktype length constraint", () => {
		const plan = analyze(
			scope({ ...binary.import(), N: { name: "string <= 32" } }),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		expect(out["schemas.ts"]).toMatch(/"name":\s*"string <= 32"/);
	});
});

describe("nuxt-ui exporter — file structure", () => {
	test("emits one *Form.vue per struct + index.ts barrel", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				A: { x: "u8" },
				B: { y: "u16" },
			}),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		expect(Object.keys(out).sort()).toEqual(
			["AForm.vue", "BForm.vue", "index.ts", "schemas.ts"].sort(),
		);
		expect(out["index.ts"]).toContain('export * from "./schemas";');
		expect(out["index.ts"]).toContain(
			'export { default as AForm } from "./AForm.vue";',
		);
	});

	test("SFC imports ${Name}Schema (arktype Type) and feeds it to UForm", () => {
		const plan = analyze(
			scope({ ...binary.import(), Profile: { name: "string", age: "u8" } }),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		const form = out["ProfileForm.vue"]!;
		expect(form).toContain(
			'import { ProfileSchema, type Profile } from "./schemas";',
		);
		expect(form).toContain(':schema="ProfileSchema"');
	});

	test("struct reference emits child component import + nested form", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Inner: { v: "u8" },
				Outer: { inner: "Inner", flag: "bool" },
			}),
			"v1",
		);
		const out = asMap(nuxtUi().generate(plan));
		const outer = out["OuterForm.vue"]!;
		expect(outer).toContain('import InnerForm from "./InnerForm.vue";');
		expect(outer).toContain("<InnerForm v-model=");
		expect(outer).toContain("embedded");
		// Field reference inside the schema literal is just the alias name.
		expect(out["schemas.ts"]).toMatch(/"inner":\s*"Inner"/);
	});

	test("deprecated struct is skipped from form generation but kept in schemas", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Old: { x: "u8" },
				New: { x: "u8" },
			}),
			"v1",
		);
		const oldStruct = plan.types.find((t) => t.name === "Old")!;
		(oldStruct as any).obsolete = true;
		(oldStruct as any).obsoleteReason = "use New";
		const out = asMap(nuxtUi().generate(plan));
		expect(out["NewForm.vue"]).toBeDefined();
		expect(out["OldForm.vue"]).toBeUndefined();
		expect(out["schemas.ts"]).toContain("OldSchema");
	});
});
