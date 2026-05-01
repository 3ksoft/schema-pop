#!/usr/bin/env bun
/// <reference types="node" />

import path from "node:path";
import { buildConfig } from "./node";
import { runBindings, type BindingSpec } from "./bind";
import { createJiti } from "jiti";

function printHelp() {
	console.log(`schema-pop — schema codegen

Usage:
  schema-pop [config-path]            Build schemas (default config: pop.config.ts)
  schema-pop bind <source> [--out <dest>]
                                      Append destructured exports + type aliases
                                      from arktype scope(s) to a copy of <source>.
  schema-pop bind --config <pop-cfg>  Run all \`bindings:\` entries from a pop.config.ts.
  schema-pop --help                   Show this help.

Bind flags:
  --out, -o <path>     Destination file or directory (default: ./dist/<basename>).
  --config, -c <path>  Read \`bindings: BindingSpec[]\` from this config (default: pop.config.ts).

Bind never runs as part of \`schema-pop\` (build) — by design. Run it before
your tsc/bun build step in your own pipeline.`);
}

async function bindCommand(args: string[]) {
	let source: string | undefined;
	let dest: string | undefined;
	let configPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--out" || a === "-o") dest = args[++i];
		else if (a === "--config" || a === "-c") configPath = args[++i];
		else if (a === "--help" || a === "-h") {
			printHelp();
			return;
		} else if (!source) source = a;
		else {
			console.error(`schema-pop bind: unexpected argument "${a}"`);
			process.exit(2);
		}
	}

	if (source) {
		const finalDest = dest ?? path.join("./dist", path.basename(source));
		const { runBindings } = await import("./bind");
		await runBindings([{ source, dest: finalDest }]);
		return;
	}

	const cfgPath = path.resolve(process.cwd(), configPath ?? "pop.config.ts");
	const jiti = createJiti(import.meta.url);
	const mod = (await jiti.import(cfgPath)) as any;
	const config = mod.default || mod.config || mod;
	const bindings: BindingSpec[] = config.bindings ?? [];
	if (bindings.length === 0) {
		console.error(
			`schema-pop bind: no source given and no \`bindings\` in ${cfgPath}`,
		);
		process.exit(2);
	}
	await runBindings(bindings, path.dirname(cfgPath));
}

async function main() {
	const args = process.argv.slice(2);
	const cmd = args[0];

	try {
		if (cmd === "bind") {
			await bindCommand(args.slice(1));
			return;
		}
		if (cmd === "--help" || cmd === "-h") {
			printHelp();
			return;
		}
		const configPath = cmd ?? "pop.config.ts";
		await buildConfig(configPath);
		console.log("✨ Schema generation complete.");
	} catch (e) {
		console.error("❌", (e as Error).message ?? e);
		process.exit(1);
	}
}

main();
