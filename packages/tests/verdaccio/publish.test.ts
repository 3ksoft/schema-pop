import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
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
const LONG_TIMEOUT = 60_000;

// Releasable packages. `packages/cli` (schema-pop) and `packages/create`
// (create-schema-pop) were removed, so the registry test only covers the
// packages that are actually published.
const PACKAGES = [
	"packages/schema",
	"packages/core",
	"packages/exporter",
	"packages/importer",
];

const SCOPED_NAMES = [
	"@schema-pop/schema",
	"@schema-pop/core",
	"@schema-pop/exporter",
	"@schema-pop/importer",
];

// This test is the only one in the suite that needs Docker. When the docker
// binary is absent (e.g. bare `bun run test` on a dev box) soft-skip instead
// of failing the whole suite; CI runs it explicitly.
const HAS_DOCKER = Bun.which("docker") !== null;

describe.skipIf(!HAS_DOCKER)("schema-pop publish (verdaccio)", () => {
	// Shared registry env — ensures bunx and bun install both hit Verdaccio.
	const testEnv = {
		...process.env,
		npm_config_registry: REGISTRY,
		BUN_CONFIG_REGISTRY: REGISTRY,
	};

	let version = "0.0.0";

	beforeAll(async () => {
		version = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../schema/package.json"), "utf8"),
		).version;

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

			// `bun publish` rewrites workspace:* deps to real semver in the
			// tarball; --access public ensures scoped packages are installable.
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
	}, LONG_TIMEOUT * 5); // Build + publish all packages can take a few minutes

	afterAll(async () => {
		// Remove the container (stop + rm) so a crashed run never leaves a
		// stale container holding port 4873 for the next run.
		console.log("\n🛑 Stopping Verdaccio...");
		await $`docker rm -f ${CONTAINER_NAME}`.nothrow().quiet();

		// Scratch consumer project is not worth committing.
		rmSync(join(TMP_ROOT, "consumer"), { recursive: true, force: true });
	});

	it("should expose every published package at the expected version", async () => {
		for (const name of SCOPED_NAMES) {
			const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`);
			expect(res.ok, `${name} manifest fetchable`).toBe(true);
			const manifest = (await res.json()) as { versions?: Record<string, unknown> };
			expect(
				manifest.versions?.[version],
				`${name}@${version} present in registry`,
			).toBeTruthy();
		}
	}, LONG_TIMEOUT);

	it("should install published packages from the local registry", async () => {
		// A scratch consumer project pulls the freshly-published tarballs from
		// Verdaccio — proving the publish pipeline produces installable packages.
		const consumer = join(TMP_ROOT, "consumer");
		rmSync(consumer, { recursive: true, force: true });
		mkdirSync(consumer, { recursive: true });
		writeFileSync(
			join(consumer, "package.json"),
			JSON.stringify(
				{
					name: "consumer",
					private: true,
					type: "module",
					dependencies: {
						"@schema-pop/core": version,
						"@schema-pop/exporter": version,
					},
				},
				null,
				2,
			),
		);

		const install = await $`bun install`
			.env(testEnv)
			.cwd(consumer)
			.nothrow()
			.quiet();
		if (install.exitCode !== 0) {
			console.error("Install stdout:", install.stdout.toString());
			console.error("Install stderr:", install.stderr.toString());
		}
		expect(install.exitCode).toBe(0);

		for (const name of ["@schema-pop/core", "@schema-pop/exporter"]) {
			expect(
				existsSync(join(consumer, "node_modules", name)),
				`${name} installed from registry`,
			).toBe(true);
		}
	}, LONG_TIMEOUT * 2);
});
