import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const HARNESS_PATH = join(import.meta.dirname, "harness");
const IMAGE_NAME = "schema-pop-test-registry";

const REGISTRY = "http://localhost:4873";
const CONTAINER_NAME = "verdaccio-e2e-test";
const TMP_ROOT = join(import.meta.dirname, "tmp_test");
const PROJECT_NAME = "integration-test-project";
const PROJECT_PATH = join(TMP_ROOT, PROJECT_NAME);
const LONG_TIMEOUT = 60_000;
var all_tests_passed = false;

const PACKAGES = [
	"packages/schema",
	"packages/core",
	"packages/exporter",
	"packages/importer",
	"packages/cli",
	"packages/create",
];

describe("create-schema-pop Integration", () => {
	// Shared registry env — ensures bunx and bun install both hit Verdaccio
	const testEnv = {
		...process.env,
		npm_config_registry: REGISTRY,
		BUN_CONFIG_REGISTRY: REGISTRY,
	};

	beforeAll(async () => {
		console.log("🧹 Cleaning Bun cache...");
		await $`bun pm cache rm`.quiet();

		console.log("🏗️  Building test registry image...");
		await $`docker build -t ${IMAGE_NAME} ${HARNESS_PATH}`.quiet();

		console.log("🐳 Starting Verdaccio in Docker...");
		await $`docker rm -f ${CONTAINER_NAME}`.nothrow().quiet();
		await $`docker run -d --name ${CONTAINER_NAME} -p 4873:4873 ${IMAGE_NAME}`.quiet();

		console.log("⏳ Waiting for registry...");
		let ready = false;
		for (let i = 0; i < 15; i++) {
			try {
				const res = await fetch(REGISTRY);
				if (res.ok) {
					ready = true;
					break;
				}
			} catch (e) {}
			await new Promise((r) => setTimeout(r, 1000));
		}
		if (!ready) throw new Error("Verdaccio failed to start");

		// Verdaccio's config grants `publish: $all` (anonymous included), but
		// `bun publish` still refuses to send a request without an auth token in
		// `.npmrc`. Self-register a throwaway user via the npm adduser API to get
		// a real token, then hand it to publish through a scoped $HOME/.npmrc.
		console.log("🔑 Registering publish user with Verdaccio...");
		let authToken = "";
		try {
			const authRes = await fetch(`${REGISTRY}/-/user/org.couchdb.user:e2e`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "e2e",
					password: "e2e-password",
					email: "e2e@test.local",
				}),
			});
			authToken = ((await authRes.json()) as { token?: string }).token ?? "";
		} catch (e) {}
		if (!authToken) throw new Error("Failed to obtain Verdaccio auth token");

		if (!existsSync(TMP_ROOT)) mkdirSync(TMP_ROOT, { recursive: true });
		const authHome = join(TMP_ROOT, "npm-home");
		mkdirSync(authHome, { recursive: true });
		writeFileSync(
			join(authHome, ".npmrc"),
			`//localhost:4873/:_authToken=${authToken}\nregistry=${REGISTRY}\n`,
		);
		const publishEnv = { ...testEnv, HOME: authHome };

		console.log("📦 Publishing packages...");
		for (const pkg of PACKAGES) {
			const pkgPath = join(import.meta.dirname, "../../../", pkg);
			console.log(`   ➡️  Building & Publishing: ${pkg}`);
			await $`bun run build`.cwd(pkgPath).nothrow().quiet();

			// Use `bun publish` instead of `npm publish` so that:
			// 1. workspace:* deps are rewritten to real semver in the tarball
			// 2. --no-git-checks is a valid flag (it's a bun-specific flag)
			// 3. --access public ensures scoped packages are installable
			const pub =
				await $`bun publish --registry ${REGISTRY} --access public --no-git-checks`
					.cwd(pkgPath)
					.env(publishEnv)
					.nothrow()
					.quiet();

			if (pub.exitCode !== 0) {
				console.error(`❌ Failed to publish ${pkg}`);
				console.error(pub.stderr.toString());
				throw new Error(`Publish failed for ${pkg}`);
			}
		}
		console.log("✅ All packages published!");

		if (existsSync(PROJECT_PATH)) rmSync(PROJECT_PATH, { recursive: true });
		if (!existsSync(TMP_ROOT)) mkdirSync(TMP_ROOT, { recursive: true });
	}, LONG_TIMEOUT * 5); // Build + publish all packages can take a few minutes

	afterAll(async () => {
		console.log("\n🛑 Stopping Verdaccio...");
		await $`docker stop ${CONTAINER_NAME}`.quiet();
		if (all_tests_passed) {
			console.log("\n✅ All tests passed!");
			// console.log("🧹 Cleaning up...");
			// if (existsSync(PROJECT_PATH)) rmSync(PROJECT_PATH, { recursive: true });
			// if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) {
			// 	rmSync(TMP_ROOT, { recursive: true });
			// }
		} else {
			console.log("\n❌ Some tests failed!");
			console.log(`👉 Check ${PROJECT_PATH} for post-mortem`);
		}
	});

	it(
		"should scaffold project via bunx from local registry",
		async () => {
			console.log("🏗️  Scaffolding...");

			// Pin the freshly-published version and resolve via bunx so the
			// scaffolder comes from Verdaccio — a bare `bun create schema-pop`
			// resolves `create-schema-pop@latest` off real npm, which pins an
			// old `schema-pop` version that doesn't exist in the test registry.
			const VERSION = JSON.parse(
				readFileSync(
					join(import.meta.dirname, "../../create/package.json"),
					"utf8",
				),
			).version;
			const scaffold = await $`bunx create-schema-pop@${VERSION} ${PROJECT_NAME} --type all`
				.env(testEnv)
				.cwd(TMP_ROOT)
				.nothrow();

			expect(scaffold.exitCode).toBe(0);

			console.log("📦 Installing dependencies...");
			const install = await $`bun install`
				.env(testEnv)
				.cwd(PROJECT_PATH)
				.nothrow();

			expect(install.exitCode).toBe(0);
			all_tests_passed = true;
		},
		LONG_TIMEOUT * 2,
	); // Long timeout for full E2E

	// The scaffold ships an imperative `scripts/generate.ts` (fromModule →
	// analyze → exportPlan per target) — no config-file builder. `bun run
	// generate` fans out to each schema package's generate script.
	it(
		"should generate schemas",
		async () => {
			console.log("🧬  Generating schemas...");
			const genProc = await $`bun run generate`
				.cwd(PROJECT_PATH)
				.nothrow()
				.quiet();

			if (genProc.exitCode !== 0) {
				console.error("Generate Stdout:", genProc.stdout.toString());
				console.error("Generate Error:", genProc.stderr.toString());
			}
			expect(genProc.exitCode).toBe(0);
		},
		LONG_TIMEOUT,
	);

	// `bun run test` in the scaffold runs `bun run build` (generate + compile
	// the rust/cpp/zig/bf/ts harnesses — the `<lang>:harness` exporters emit
	// each `main.*` + build files) then the TS harness `run-abi-test.ts`,
	// which encodes fixtures with the generated codec and round-trips the
	// bytes through each native harness, asserting they come back identical
	// (real cross-language ABI check). Compiling needs the toolchains from
	// `flake.nix` — run inside `nix develop`. Soft-skips (not fails) when a
	// compiler is absent so a bare `bun run test` stays green.
	it(
		"should compile all harnesses + pass ABI round-trip test",
		async () => {
			const missing = ["cargo", "gcc", "g++", "zig"].filter(
				(t) => Bun.which(t) === null,
			);
			if (missing.length) {
				console.log(
					`⏭️  missing toolchains: ${missing.join(", ")} (run inside \`nix develop\`)`,
				);
				return;
			}

			const tsTestProc = await $`bun run test`
				.cwd(PROJECT_PATH)
				.nothrow()
				.quiet();
			if (tsTestProc.exitCode !== 0) {
				console.error("Build/ABI stdout:", tsTestProc.stdout.toString());
				console.error("Build/ABI stderr:", tsTestProc.stderr.toString());
			}
			expect(tsTestProc.exitCode).toBe(0);
		},
		LONG_TIMEOUT * 3,
	);

});
