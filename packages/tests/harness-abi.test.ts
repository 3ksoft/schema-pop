/// <reference types="@types/bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

/**
 * Cross-language ABI verification — INDEPENDENT of the verdaccio registry.
 *
 * The old flow (create.test.ts) only reached harness compilation + ABI
 * round-trip after: docker + verdaccio + publish + bunx scaffold + install.
 * That made the most valuable test in the repo depend on Docker and a
 * registry. Here we instead:
 *
 *   1. copy the committed scaffolded fixture (integration-test-project)
 *   2. `bun scripts/generate.ts` — resolves @schema-pop/* from the monorepo
 *      workspace links in packages/tests/node_modules (no registry needed)
 *   3. compile the native harnesses (rust/cpp/zig) with whatever toolchains
 *      are present; absent toolchains are soft-skipped, present ones MUST pass
 *   4. run the TS harness run-abi-test.ts which round-trips bytes through each
 *      native harness and asserts byte-identical output (real ABI check)
 *
 * Needs the toolchains from `flake.nix` — run inside `nix develop`. Soft-skips
 * (not fails) when a compiler is absent so a bare `bun run test` stays green.
 *
 * The temp project MUST live under packages/tests/ so bun walks up to
 * packages/tests/node_modules and finds the @schema-pop/* workspace links.
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const FIXTURE = join(
	import.meta.dirname,
	"verdaccio/tmp_test/integration-test-project",
);
// Same scratch root as the verdaccio test; biome ignores `**/tmp_test`.
const TMP = mkdtempSync(join(import.meta.dirname, "verdaccio/tmp_test", ".harness-"));
const LONG_TIMEOUT = 180_000;

// Local packages the generated code resolves through — resolution from the
// temp project goes node_modules → dist/index.js (exports field), so dist must
// match src. We rebuild only when stale (CI runs `bun run build` first, so the
// usual case is a no-op and avoids racing publish.test.ts which also builds).
const DEP_PACKAGES = [
	"packages/schema",
	"packages/core",
	"packages/exporter",
];

const TOOLCHAIN_BINS = {
	// rustc needs a C linker (cc) to produce the final binary.
	rust: ["cargo", "cc"],
	cpp: ["g++"],
	zig: ["zig"],
} as const;

function toolchainAvailable(bins: readonly string[]): boolean {
	return bins.every((b) => Bun.which(b) !== null);
}

// Newest mtime of any file under `dir` (recursive); -Infinity when missing.
function newestMtime(dir: string): number {
	if (!existsSync(dir)) return -Infinity;
	let newest = -Infinity;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, newestMtime(full));
		} else if (entry.isFile()) {
			newest = Math.max(newest, statSync(full).mtimeMs);
		}
	}
	return newest;
}

describe("harness ABI round-trip (no registry)", () => {
	beforeAll(async () => {
		// 1. Rebuild dist of the local deps when stale, so generate uses code
		//    that matches src. Skips when dist is already fresh.
		for (const pkg of DEP_PACKAGES) {
			const dist = join(REPO_ROOT, pkg, "dist", "index.js");
			const src = join(REPO_ROOT, pkg, "src");
			// Any source file newer than dist means a stale build.
			const needsBuild =
				!existsSync(dist) || newestMtime(src) > statSync(dist).mtimeMs;
			if (needsBuild) {
				console.log(`🔨 rebuilding ${pkg} dist (stale)`);
				const res = await $`bun run build`
					.cwd(join(REPO_ROOT, pkg))
					.nothrow()
					.quiet();
				if (res.exitCode !== 0) {
					console.error(`${pkg} build failed:\n${res.stderr.toString()}`);
					throw new Error(`local build failed for ${pkg}`);
				}
			}
		}

		// 2. Copy the scaffolded project; drop the committed lockfile (it pins
		//    tarballs from localhost:4873, i.e. a dead registry).
		cpSync(FIXTURE, TMP, { recursive: true });
		rmSync(join(TMP, "bun.lock"), { force: true });
	}, LONG_TIMEOUT);

	afterAll(() => {
		rmSync(TMP, { recursive: true, force: true });
	});

	test(
		"generates all target artifacts from local packages",
		async () => {
			const gen = await $`bun scripts/generate.ts`
				.cwd(join(TMP, "packages/schema"))
				.nothrow();
			if (gen.exitCode !== 0) {
				console.error("Generate stdout:", gen.stdout.toString());
				console.error("Generate stderr:", gen.stderr.toString());
			}
			expect(gen.exitCode).toBe(0);

			// Every current target should have been emitted.
			const expected = [
				join(TMP, "packages/ts/src/schema.ts"),
				join(TMP, "packages/ts/src/codec.ts"),
				join(TMP, "packages/rust/src/schema.rs"),
				join(TMP, "packages/rust/src/main.rs"),
				join(TMP, "packages/rust/Cargo.toml"),
				join(TMP, "packages/cpp/src/schema.hpp"),
				join(TMP, "packages/cpp/src/main.cpp"),
				join(TMP, "packages/zig/src/schema.zig"),
				join(TMP, "packages/zig/src/main.zig"),
			];
			for (const f of expected) {
				expect(existsSync(f), `missing generated file ${f}`).toBe(true);
			}
		},
		LONG_TIMEOUT,
	);

	test(
		"compiles native harnesses + passes ABI round-trip",
		async () => {
			// Soft-skip when no toolchain is available at all.
			const present = (
				Object.entries(TOOLCHAIN_BINS) as [
					keyof typeof TOOLCHAIN_BINS,
					readonly string[],
				][]
			).filter(([, bins]) => toolchainAvailable(bins));
			if (present.length === 0) {
				console.log(
					`⏭️  no native toolchains (cargo/g++/zig) — run inside \`nix develop\` for the ABI check`,
				);
				return;
			}

			// Build every harness whose toolchain exists; a present toolchain
			// with a failing build is a real failure (not a skip).
			for (const [lang] of present) {
				const dir = join(TMP, "packages", lang);
				const build = await $`bun run build`.cwd(dir).nothrow().quiet();
				if (build.exitCode !== 0) {
					console.error(`${lang} harness build failed:\n${build.stderr.toString()}`);
				}
				expect(build.exitCode, `${lang} harness build`).toBe(0);
			}

			// Run the ABI round-trip: TS codec encodes fixtures, each native
			// harness `layout`/`roundtrip` must agree byte-for-byte. Harnesses
			// without binaries are skipped internally.
			const abi = await $`bun run src/run-abi-test.ts`
				.cwd(join(TMP, "packages/ts"))
				.nothrow();
			if (abi.exitCode !== 0) {
				console.error("ABI stdout:", abi.stdout.toString());
				console.error("ABI stderr:", abi.stderr.toString());
			}
			expect(abi.exitCode).toBe(0);
		},
		LONG_TIMEOUT * 3,
	);
});
