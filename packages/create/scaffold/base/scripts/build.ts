import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const isWatch = process.argv.includes("--watch");
const root = join(import.meta.dir, "..");

async function buildAll() {
	console.log("\n🍭 [Schema-Pop] Starting Unified Build...\n");

	// 1. Generate Schemas
	console.log("📄 Generating Schemas...");
	await $`bun run --filter '*-schema' generate`.cwd(root);

	// 2. Build Native Harnesses
	const harnesses = [
		{
			name: "rust",
			dir: "packages/rust",
			cmd: "cargo build --release && cp target/release/harness ./harness",
		},
		{
			name: "cpp",
			dir: "packages/cpp",
			cmd: "g++ -std=c++17 -O1 src/main.cpp -o harness",
		},
		{
			name: "zig",
			dir: "packages/zig",
			cmd: "zig build-exe src/main.zig -O ReleaseSafe --name harness && rm -f harness.o",
		},
		{
			name: "bf",
			dir: "packages/bf",
			cmd: "gcc -O2 interpreter.c -o bf-interpreter && chmod +x harness",
		},
		{
			name: "ts",
			dir: "packages/ts",
			cmd: "bun build --compile src/run-abi-test.ts --outfile harness",
		},
	];

	let failures = 0;
	for (const h of harnesses) {
		const fullPath = join(root, h.dir);
		if (existsSync(fullPath)) {
			console.log(`🛠️  Building ${h.name} harness...`);
			const proc = await $`${{ raw: h.cmd }}`.cwd(fullPath).nothrow();
			if (proc.exitCode !== 0) {
				console.error(`❌ Failed to build ${h.name} harness:`);
				console.error(proc.stderr.toString());
				failures++;
			}
		}
	}
	if (failures > 0) throw new Error(`${failures} harness build(s) failed`);

	console.log("\n✨ Build Complete!\n");
}

if (isWatch) {
	console.log("👀 Watch mode enabled (watching packages/schema/src)...\n");
	// Simple watch logic for the schema source
	const watcher = require("node:fs").watch(
		join(root, "packages/schema/src"),
		{ recursive: true },
		async (event: string, filename: string) => {
			if (filename) {
				console.log(`🔄 Change detected in ${filename}`);
				await buildAll();
			}
		},
	);
} else {
	await buildAll();
}
