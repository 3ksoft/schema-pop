/// <reference types="@types/bun" />
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

/**
 * Scaffold-output matrix. Runs `create-schema-pop` with several flag
 * combinations and verifies the *static shape* of the emitted files:
 *
 *   1. exit code 0 from the scaffold step
 *   2. imperative conventions in the emitted files: NO `pop.config.ts`
 *      (the config-file builder is gone), a `scripts/generate.ts` that
 *      imports `@schema-pop/core` + `exportPlan` and has its
 *      `/* __TARGETS__ *\/` placeholder spliced into a real TARGETS list,
 *      schema files are plain `scope({...})` (no `schemaPop(...)` wrap)
 *      and all parse via `Bun.Transpiler`.
 *   3. `bun install` + `bun run generate` are NOT exercised here — the
 *      Verdaccio test in `create.test.ts` covers publish / install /
 *      generate / harness-compile end-to-end (workspace:* file: deps
 *      don't resolve outside the monorepo, so a local install can't run).
 *
 * The matrix is deliberately broad: minimal project, monorepo with
 * subset of harnesses, full `--type all`. Each combination shares the
 * same tmp root, gets cleaned up at the end.
 */

const REPO_ROOT = join(import.meta.dirname, "../../..");
const CREATE_BIN = join(REPO_ROOT, "packages/create/bin.ts");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "scaffold-matrix-"));
const LONG_TIMEOUT = 180_000;

interface Combo {
	name: string;
	args: string[];
	expectedHarnesses: string[];
	type: "project" | "monorepo" | "all";
}

const combos: Combo[] = [
	{
		name: "project-empty",
		args: ["--type", "project"],
		type: "project",
		expectedHarnesses: [],
	},
	{
		name: "monorepo-ts",
		args: ["--type", "monorepo", "--harnesses", "ts"],
		type: "monorepo",
		expectedHarnesses: ["ts"],
	},
	{
		name: "monorepo-ts-rust",
		args: ["--type", "monorepo", "--harnesses", "ts,rust"],
		type: "monorepo",
		expectedHarnesses: ["ts", "rust"],
	},
	{
		name: "monorepo-all-harnesses",
		args: ["--type", "monorepo", "--harnesses", "ts,rust,cpp,zig"],
		type: "monorepo",
		expectedHarnesses: ["ts", "rust", "cpp", "zig"],
	},
	{
		name: "all",
		args: ["--type", "all"],
		type: "all",
		expectedHarnesses: ["ts", "rust", "cpp", "zig", "bf"],
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
				const scaffold = await $`bun ${CREATE_BIN} ${combo.name} ${combo.args}`
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

				// project type → flat layout (schema pkg = project root);
				// monorepo / all → packages/schema/
				const schemaPkgDir =
					combo.type === "project"
						? projectDir
						: join(projectDir, "packages/schema");

				// No config-file builder anymore: `pop.config.ts` is gone,
				// generation is driven by an imperative `scripts/generate.ts`.
				expect(existsSync(join(schemaPkgDir, "pop.config.ts"))).toBe(false);

				const genPath = join(schemaPkgDir, "scripts", "generate.ts");
				expect(existsSync(genPath), "scripts/generate.ts missing").toBe(true);
				const genSrc = readFileSync(genPath, "utf8");
				expect(genSrc).toMatch(/from\s+["']@schema-pop\/core["']/);
				expect(genSrc).toMatch(/exportPlan/);
				// The `/* __TARGETS__ */` placeholder must have been spliced out
				// and replaced with a real TARGETS list.
				expect(genSrc).not.toContain("__TARGETS__");
				expect(genSrc).toMatch(/const TARGETS[\s\S]*?target:\s*["']/);
				expect(
					() => new Bun.Transpiler({ loader: "ts" }).transformSync(genSrc),
					"generate.ts doesn't parse",
				).not.toThrow();

				// Schema files: plain arktype scopes ending in `.ts(x)`, no
				// leftover `schemaPop(...)` builder wrap, and they parse.
				const schemaSrcDir = join(schemaPkgDir, "src/schema");
				const schemaFiles = existsSync(schemaSrcDir)
					? readdirSync(schemaSrcDir)
					: [];
				expect(schemaFiles.length, "no schema files emitted").toBeGreaterThan(
					0,
				);
				for (const f of schemaFiles) {
					expect(f).toMatch(/\.tsx?$/);
					const src = readFileSync(join(schemaSrcDir, f), "utf8");
					expect(src, `${f}: leftover schemaPop wrap`).not.toMatch(
						/schemaPop\s*\(/,
					);
					expect(src, `${f}: expected a scope(...) export`).toMatch(
						/export const \$\s*=\s*scope\(/,
					);
					expect(
						() => new Bun.Transpiler({ loader: "ts" }).transformSync(src),
						`${f}: schema source doesn't parse`,
					).not.toThrow();
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
