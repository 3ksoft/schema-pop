import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
	"packages/core",
	"packages/core-exporters",
	"packages/extra-exporters",
	"packages/create"
];

describe("create-schema-pop Integration", () => {

	// Shared registry env — ensures bunx and bun install both hit Verdaccio
	const testEnv = {
		...process.env,
		npm_config_registry: REGISTRY,
		BUN_CONFIG_REGISTRY: REGISTRY
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
				if (res.ok) { ready = true; break; }
			} catch (e) { }
			await new Promise((r) => setTimeout(r, 1000));
		}
		if (!ready) throw new Error("Verdaccio failed to start");

		console.log("📦 Publishing packages...");
		for (const pkg of PACKAGES) {
			const pkgPath = join(import.meta.dirname, "../../", pkg);
			console.log(`   ➡️  Building & Publishing: ${pkg}`);
			await $`bun run build`.cwd(pkgPath).nothrow().quiet();

			// Use `bun publish` instead of `npm publish` so that:
			// 1. workspace:* deps are rewritten to real semver in the tarball
			// 2. --no-git-checks is a valid flag (it's a bun-specific flag)
			// 3. --access public ensures scoped packages are installable
			const pub = await $`bun publish --registry ${REGISTRY} --access public --no-git-checks`
				.cwd(pkgPath)
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
	}, LONG_TIMEOUT); // Give docker time to start

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


	it("should scaffold project via bunx from local registry", async () => {
		console.log("🏗️  Scaffolding...");

		const scaffold = await $`bun create schema-pop --name ${PROJECT_NAME} --type all`
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
	}, LONG_TIMEOUT * 2); // Long timeout for full E2E

	it("should generate schemas", async () => {
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
	}, LONG_TIMEOUT);

	it("should build artifacts", async () => {
		console.log("🛠️  Building artifacts...");
		const buildProc = await $`bun run build`
			.cwd(PROJECT_PATH)
			.nothrow()
			.quiet();

		if (buildProc.exitCode !== 0) {
			console.error("Build Stdout:", buildProc.stdout.toString());
			console.error("Build Error:", buildProc.stderr.toString());
		}
		expect(buildProc.exitCode).toBe(0);
	}, LONG_TIMEOUT * 2);

	it("should pass ABI Consistency integration test", async () => {
		console.log("🧪 Running ABI Consistency integration test...");
		const tsTestProc = await $`bun run test`
			.cwd(PROJECT_PATH)
			.nothrow()
			.quiet();

		if (tsTestProc.exitCode !== 0) {
			console.error("Test Stdout:", tsTestProc.stdout.toString());
			console.error("Test Error:", tsTestProc.stderr.toString());
		} else {
			console.log(tsTestProc.stdout.toString());
		}
		expect(tsTestProc.exitCode).toBe(0);
	}, LONG_TIMEOUT);

	it("should run a user-supplied custom exporter", async () => {
		console.log("🔌 Testing custom exporter loading...");
		const schemaPath = join(PROJECT_PATH, "packages", "schema");

		// 1. User-side custom exporter — emits a tiny markdown report.
		const exporterSrc = `import type { LayoutPlan, ExporterPlugin, BaseConfig } from "schema-pop";

export interface MarkdownConfig extends BaseConfig {}

export function markdown(config: MarkdownConfig = {}): ExporterPlugin<MarkdownConfig> {
    return {
        name: "markdown",
        config: { commentStyle: "none", ...config },
        generate: (plan: LayoutPlan) => {
            let md = \`# Schema \${plan.version}\\n\\n\`;
            for (const t of plan.types) {
                md += \`## \${t.name} (\${t.kind}, \${t.size}b, align \${t.align})\\n\\n\`;
                if (t.kind === "struct") {
                    md += \`| offset | name | size |\\n|---|---|---|\\n\`;
                    for (const f of t.fields) md += \`| +\${f.offset} | \${f.name} | \${f.size} |\\n\`;
                    md += \`\\n\`;
                }
            }
            return md;
        },
        wrapVersion: (version, code) => \`<!-- version: \${version} -->\\n\${code}\\n\`,
    };
}
`;
		writeFileSync(join(schemaPath, "src", "markdown-exporter.ts"), exporterSrc);

		// 2. Standalone config that imports the custom exporter alongside the
		//    bundled `defineConfig` helper. Reusing the project's own schema
		//    sources keeps the test self-contained.
		const sources = readdirSync(join(schemaPath, "src", "schema"))
			.filter((f) => f.endsWith(".ts") && !/V\d+\.ts$/.test(f))
			.map((f) => f.replace(/\.ts$/, ""))
			.sort();
		const firstSchema = sources[0];
		expect(firstSchema).toBeDefined();

		const customConfigSrc = `import { defineConfig } from "schema-pop";
import { markdown } from "./src/markdown-exporter";

export default defineConfig({
    schemas: [{
        name: "${firstSchema}",
        versions: [
            { version: "1.0", source: "./src/schema/${firstSchema}.ts" },
        ],
        targets: [
            markdown({ dest: "./dist/custom.md" }),
        ],
    }],
});
`;
		writeFileSync(join(schemaPath, "pop.custom.config.ts"), customConfigSrc);

		// 3. Run the schema-pop CLI with the custom config.
		const customGen = await $`bun x schema-pop pop.custom.config.ts`
			.env(testEnv)
			.cwd(schemaPath)
			.nothrow();

		if (customGen.exitCode !== 0) {
			console.error("Custom generate stdout:", customGen.stdout.toString());
			console.error("Custom generate stderr:", customGen.stderr.toString());
		}
		expect(customGen.exitCode).toBe(0);

		// 4. Verify the output file exists and looks plausible.
		const outPath = join(schemaPath, "dist", "custom.md");
		expect(existsSync(outPath)).toBe(true);
		const md = readFileSync(outPath, "utf-8");
		expect(md).toContain("# Schema");
		expect(md).toContain("<!-- version:");
		expect(md).toMatch(/\| offset \| name \| size \|/);

		all_tests_passed = true;
	}, LONG_TIMEOUT);
});
