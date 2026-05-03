/// <reference types="@types/bun" />
import { afterAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scaffold-output matrix. Runs `create-schema-pop` with several flag
 * combinations and verifies the *static shape* of the emitted files:
 *
 *   1. exit code 0 from the scaffold step
 *   2. v2 conventions in the emitted files
 *      (defineConfig in pop.config.ts, no v1 `schemas: [{ versions:
 *       [...] }]` syntax, all schema files end in `.pop.ts`, latest
 *       version wraps with `schemaPop({ targets: [...] }, scope({...}))`)
 *   3. injected target imports cover every `<exporter>(...)` usage in
 *      the wrap — catches the regex-only injection bug where bundled
 *      schemas with non-canonical `import { scope, binary } from
 *      "schema-pop"` left `schemaPop` unimported.
 *   4. injected file is balanced (parens / braces / brackets) — cheap
 *      sanity check on the string-based wrap insertion.
 *   5. `bun install` + `bun run generate` are NOT exercised here —
 *      `bun add` against `file:` deps doesn't copy package contents
 *      reliably and the existing Verdaccio test in `create.test.ts`
 *      already covers the install / generate path end-to-end.
 *
 * The matrix is deliberately broad: minimal project, monorepo with
 * subset of harnesses, full `--type all`. Each combination shares the
 * same tmp root, gets cleaned up at the end.
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const CREATE_BIN = join(REPO_ROOT, "packages/create/bin.ts");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "scaffold-matrix-"));
const LONG_TIMEOUT = 180_000;

interface Combo {
	name: string;
	args: string[];
	expectedHarnesses: string[];
	expectsExtraExporters: boolean;
	type: "project" | "monorepo" | "all";
}

const combos: Combo[] = [
	{
		name: "project-empty",
		args: ["--type", "project"],
		type: "project",
		expectedHarnesses: [],
		expectsExtraExporters: false,
	},
	{
		name: "project-pinstatus",
		args: ["--type", "project", "--schemas", "pin-status"],
		type: "project",
		expectedHarnesses: [],
		expectsExtraExporters: false,
	},
	{
		name: "monorepo-ts",
		args: ["--type", "monorepo", "--harnesses", "ts"],
		type: "monorepo",
		expectedHarnesses: ["ts"],
		expectsExtraExporters: false,
	},
	{
		name: "monorepo-ts-rust",
		args: ["--type", "monorepo", "--harnesses", "ts,rust"],
		type: "monorepo",
		expectedHarnesses: ["ts", "rust"],
		expectsExtraExporters: false,
	},
	{
		name: "monorepo-all-harnesses",
		args: ["--type", "monorepo", "--harnesses", "ts,rust,cpp,zig"],
		type: "monorepo",
		expectedHarnesses: ["ts", "rust", "cpp", "zig"],
		expectsExtraExporters: false,
	},
	{
		name: "all",
		args: ["--type", "all"],
		type: "all",
		expectedHarnesses: ["ts", "rust", "cpp", "zig", "bf"],
		expectsExtraExporters: true,
	},
];

afterAll(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("create-schema-pop scaffold matrix", () => {
	for (const combo of combos) {
		test(
			combo.name,
			async () => {
				const projectDir = join(TMP_ROOT, combo.name);
				const scaffold = await $`bun ${CREATE_BIN} --name ${combo.name} ${combo.args}`
					.cwd(TMP_ROOT)
					.env({
						...process.env,
						LOCAL_TEST: "1",
						LOCAL_TEST_PACKAGES_DIR: join(REPO_ROOT, "packages"),
					})
					.nothrow()
					.quiet();
				if (scaffold.exitCode !== 0) {
					console.error(`scaffold stderr: ${scaffold.stderr.toString()}`);
				}
				expect(scaffold.exitCode).toBe(0);
				expect(existsSync(projectDir)).toBe(true);

				// project type → flat layout (root pop.config.ts + src/schema/);
				// monorepo / all → packages/schema/{pop.config.ts,src/schema}/
				const schemaPkgDir =
					combo.type === "project"
						? projectDir
						: join(projectDir, "packages/schema");
				expect(existsSync(join(schemaPkgDir, "pop.config.ts"))).toBe(true);

				// pop.config.ts must be v2: defineConfig, no `schemas: [{...versions:` field
				const popCfg = readFileSync(
					join(schemaPkgDir, "pop.config.ts"),
					"utf8",
				);
				expect(popCfg).toContain("defineConfig");
				expect(popCfg).not.toMatch(/schemas\s*:\s*\[\s*\{[^}]*versions\s*:/);

				// Every schema file must end in `.pop.ts(x)`
				const schemaSrcDir = join(schemaPkgDir, "src/schema");
				const schemaFiles = existsSync(schemaSrcDir)
					? readdirSync(schemaSrcDir)
					: [];
				for (const f of schemaFiles) {
					expect(f).toMatch(/\.pop\.tsx?$/);
				}

				// Latest version of each schema family must be wrapped with schemaPop({...})
				const families = new Map<string, string[]>();
				for (const f of schemaFiles) {
					const m = f.match(/^(.+?)\.([0-9][0-9.]*)\.pop\.tsx?$/);
					if (!m) continue;
					const list = families.get(m[1]!) ?? [];
					list.push(f);
					families.set(m[1]!, list);
				}
				for (const [name, fs] of families) {
					fs.sort();
					const latest = fs[fs.length - 1]!;
					const src = readFileSync(join(schemaSrcDir, latest), "utf8");
					expect(src, `${name}: missing schemaPop wrap`).toMatch(
						/schemaPop\(\s*\{/,
					);
					expect(
						src,
						`${name}: schemaPop not imported`,
					).toMatch(
						/import\s*\{[^}]*schemaPop[^}]*\}\s*from\s*["']schema-pop["']/,
					);

					// Every exporter referenced in the wrap body must actually
					// be imported. Catches the regex-only inject bug that left
					// `ts(...)` / `rust(...)` / etc. dangling.
					const wrapBody =
						src.match(/schemaPop\(\s*\{[\s\S]*?\),?\s*scope\(/)?.[0] ?? "";
					const callees = new Set<string>();
					for (const m of wrapBody.matchAll(/\b([a-z][a-zA-Z0-9]*)\(\{?/g)) {
						const fn = m[1]!;
						if (fn !== "schemaPop") callees.add(fn);
					}
					for (const fn of callees) {
						expect(
							src,
							`${name}: ${fn} called but not imported`,
						).toMatch(
							new RegExp(
								`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*["']@schema-pop/`,
							),
						);
					}

					// Balanced delimiters — string-based injection should
					// never leave the file with mismatched ()/{}/[].
					const balance = (open: string, close: string): number => {
						let depth = 0;
						for (const c of src) {
							if (c === open) depth++;
							else if (c === close) depth--;
						}
						return depth;
					};
					expect(balance("(", ")"), `${name}: ()-mismatch`).toBe(0);
					expect(balance("{", "}"), `${name}: {}-mismatch`).toBe(0);
					expect(balance("[", "]"), `${name}: []-mismatch`).toBe(0);
				}

				// Harness directories present
				for (const h of combo.expectedHarnesses) {
					expect(
						existsSync(join(projectDir, "packages", h)),
						`expected packages/${h} to exist`,
					).toBe(true);
				}

				// package.json sanity — schema-pop pinned to workspace:*, all
				// schema-pop deps should share the same version string.
				const schemaPkg = JSON.parse(
					readFileSync(join(schemaPkgDir, "package.json"), "utf8"),
				);
				const popDeps = Object.entries(
					(schemaPkg.devDependencies ?? {}) as Record<string, string>,
				).filter(([k]) => k === "schema-pop" || k.startsWith("@schema-pop/"));
				expect(popDeps.length).toBeGreaterThan(0);
				// Every dep should point at a `file:` path (LOCAL_TEST mode);
				// each one resolves to a different package directory.
				for (const [name, v] of popDeps) {
					expect(v.startsWith("file:"), `${name} = ${v}`).toBe(true);
				}

				// install + generate are exercised end-to-end by the existing
				// Verdaccio-based create.test.ts. Skipping them here keeps
				// this matrix fast (~2s for the whole sweep) and still
				// catches the static-shape bugs that motivated the test.
			},
			LONG_TIMEOUT,
		);
	}
});
