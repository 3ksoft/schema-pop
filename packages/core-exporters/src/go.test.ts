/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, migrations as migScope, SchemaAnalyzer } from "schema-pop";
import type { LayoutPlan } from "schema-pop";
import { go } from "./go";

function analyze(s: any, version: string): LayoutPlan {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

function emit(plan: LayoutPlan, cfg = {}): string {
	const out = go(cfg).generate(plan);
	if (typeof out !== "string") throw new Error("expected string output");
	return out;
}

describe("go exporter — primitives + struct shape", () => {
	test("emits package header and struct with native Go types", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Sample: {
					tiny: "u8",
					word: "u32",
					signed: "i32",
					big: "u64",
					ratio: "f32",
					flag: "bool",
				},
			}),
			"v1",
		);
		const out = emit(plan);
		expect(out).toMatch(/^package /);
		expect(out).toContain("type Sample struct {");
		expect(out).toContain("Tiny uint8");
		expect(out).toContain("Word uint32");
		expect(out).toContain("Signed int32");
		expect(out).toContain("Big uint64");
		expect(out).toContain("Ratio float32");
		expect(out).toContain("Flag bool");
	});

	test("u128 / i128 fall back to [16]byte", () => {
		const plan = analyze(
			scope({ ...binary.import(), Big: { a: "u128", b: "i128" } }),
			"v1",
		);
		const out = emit(plan);
		expect(out).toContain("A [16]byte");
		expect(out).toContain("B [16]byte");
	});

	test("explicit padding emitted as blank `_ [N]byte` field", () => {
		const plan = analyze(
			scope({ ...binary.import(), P: { a: "u8", b: "u32" } }),
			"v1",
		);
		const out = emit(plan);
		// u8 followed by u32 needs 3-byte padding before the u32 to keep
		// natural alignment — emitted as a blank field.
		expect(out).toMatch(/_ \[3\]byte/);
	});

	test("size assertion via unsafe.Sizeof — pulls in `unsafe` import", () => {
		const plan = analyze(
			scope({ ...binary.import(), S: { x: "u32" } }),
			"v1",
		);
		const out = emit(plan);
		expect(out).toContain('import "unsafe"');
		expect(out).toMatch(/unsafe\.Sizeof\(S\{\}\) - \d+/);
	});
});

describe("go exporter — enums, aliases, optional, arrays", () => {
	test("string-literal union → typed string + typed const block", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Mode: "'idle' | 'active' | 'error'",
			}),
			"v1",
		);
		const out = emit(plan);
		expect(out).toContain("type Mode string");
		expect(out).toContain("const (");
		// Variant order is normalized by the analyzer — assert membership.
		for (const v of ["Idle", "Active", "Error"]) {
			expect(out).toContain(`Mode${v} Mode = "${v.toLowerCase()}"`);
		}
	});

	test("alias renders as `type X = Y`", () => {
		const plan = analyze(
			scope({ ...binary.import(), Counter: "u32" }),
			"v1",
		);
		const out = emit(plan);
		expect(out).toContain("type Counter = uint32");
	});

	test("fixed-length array → [N]T", () => {
		const plan = analyze(
			scope({ ...binary.import(), B: { checksum: "u8[] == 16" } }),
			"v1",
		);
		const out = emit(plan, { includeSizeAssertions: false });
		expect(out).toContain("Checksum [16]uint8");
	});

	test("optional field → *T pointer", () => {
		const plan = analyze(
			scope({ ...binary.import(), C: { x: "u32", "y?": "u16" } }),
			"v1",
		);
		const out = emit(plan, { includeSizeAssertions: false });
		expect(out).toMatch(/Y \*uint16/);
	});
});

describe("go exporter — deprecation + config", () => {
	test("Obsolete<> → `// Deprecated:` line above field", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				B: { x: "u32" },
			}),
			"v1",
		);
		// Mark field obsolete on the plan — reuses the same path the
		// analyzer takes for `Obsolete<>` markers.
		const struct = plan.types.find((t) => t.name === "B")!;
		(struct as any).fields[0].obsolete = true;
		(struct as any).fields[0].obsoleteReason = "use Y";
		const out = emit(plan);
		expect(out).toContain("// Deprecated: use Y");
	});

	test("custom package name overrides default", () => {
		const plan = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const out = emit(plan, { package: "telemetry" });
		expect(out).toMatch(/^package telemetry/);
	});

	test("includeSizeAssertions: false omits unsafe import", () => {
		const plan = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"v1",
		);
		const out = emit(plan, { includeSizeAssertions: false });
		expect(out).not.toContain('import "unsafe"');
		expect(out).not.toContain("unsafe.Sizeof");
	});
});

describe("go exporter — versionNamespace prefix", () => {
	test("prefixes types + consts + refs with version slug", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Mode: "'idle' | 'active'",
				B: { mode: "Mode", x: "u32" },
			}),
			"1",
		);
		const out = emit(plan, { versionNamespace: true });
		// Type decls carry the prefix.
		expect(out).toContain("type V1Mode string");
		expect(out).toContain("type V1B struct");
		// Enum constants are prefixed too.
		expect(out).toContain("V1ModeActive V1Mode = ");
		// Field reference resolves to the prefixed type, not raw `Mode`.
		expect(out).toMatch(/Mode V1Mode/);
		// Size assertion uses the prefixed type.
		expect(out).toContain("unsafe.Sizeof(V1B{})");
	});

	test("default (versionNamespace: false) leaves types unprefixed", () => {
		const plan = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"1",
		);
		const out = emit(plan);
		expect(out).toContain("type B struct");
		expect(out).not.toContain("V1B");
	});
});

describe("go exporter — generateMigration", () => {
	test("ArkType default → emits literal in field assignment", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", firmware: "u16 = 11" } }),
			"2",
		);
		const out = go({ versionNamespace: true }).generateMigration!(v1, v2);
		expect(out).toContain("func MigrateBFromV1ToV2(src V1B) V2B");
		expect(out).toContain("Firmware: 11,");
	});

	test("Renamed field reads from old field name", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { voltage_mv: "u32" } }),
			"1",
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				...migScope.import(),
				B: { voltage: "Renamed<u32, 'voltage_mv'>" },
			}),
			"2",
		);
		const out = go({ versionNamespace: true }).generateMigration!(v1, v2);
		expect(out).toContain("Voltage: src.VoltageMv,");
	});

	test("Narrowing → user-supplied stub var declaration", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "1");
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }), "2");
		const out = go({ versionNamespace: true }).generateMigration!(v1, v2);
		expect(out).toContain("// MigrateBFromV1ToV2: implement this");
		expect(out).toContain("var MigrateBFromV1ToV2 func(src V1B) V2B");
	});

	test("Without versionNamespace migrations are no-op (both versions need distinct names)", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", y: "u16 = 1" } }),
			"2",
		);
		const out = go().generateMigration!(v1, v2);
		expect(out).toBe("");
	});
});

describe("go exporter — getHarness", () => {
	test("emits main.go + go.mod + package.json with build script", () => {
		const plan = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"1",
		);
		const harnessFiles = go({ harness: true }).getHarness!([plan]);
		// Canonical Go layout keeps schema/ and cmd/harness/ as siblings
		// under the module root so they don't collide on `package` decls.
		expect(harnessFiles["../cmd/harness/main.go"]).toBeDefined();
		expect(harnessFiles["../go.mod"]).toBeDefined();
		expect(harnessFiles["../package.json"]).toBeDefined();
		const main = harnessFiles["../cmd/harness/main.go"]!;
		expect(main).toContain("package main");
		expect(main).toContain('schema "harness/schema"');
		expect(main).toContain("func layout(out io.Writer)");
		expect(main).toContain("func roundtrip(version, ty string");
		// Layout line for the type — uses unprefixed name in single-version mode.
		expect(main).toMatch(/schema\.B\{\}/);
	});

	test("multi-version harness uses prefixed type names", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }), "1");
		const v2 = analyze(
			scope({ ...binary.import(), B: { x: "u32", y: "u16 = 1" } }),
			"2",
		);
		const harnessFiles = go({
			harness: true,
			versionNamespace: true,
		}).getHarness!([v1, v2]);
		const main = harnessFiles["../cmd/harness/main.go"]!;
		expect(main).toContain("schema.V1B{}");
		expect(main).toContain("schema.V2B{}");
	});

	test("no harness when harness: false", () => {
		expect(go({ harness: false }).getHarness).toBeUndefined();
		expect(go().getHarness).toBeUndefined();
	});
});
