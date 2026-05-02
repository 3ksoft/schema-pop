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
  schema-pop layout [config-path] [--type T] [--schema S] [--version V]
                                      Dump the analyzer's view of struct / union
                                      offsets + sizes — paste next to a Rust
                                      \`offset_of!\` printout to find layout
                                      divergences (see docs/requests.md P16).
  schema-pop --help                   Show this help.

Bind flags:
  --out, -o <path>     Destination file or directory (default: ./dist/<basename>).
  --config, -c <path>  Read \`bindings: BindingSpec[]\` from this config (default: pop.config.ts).

Layout flags:
  --type, -t <name>    Restrict output to one type (repeatable).
  --schema, -s <name>  Pick one schema by name (default: first in config).
  --version, -v <v>    Pick one version (default: latest in selected schema).

Bind never runs as part of \`schema-pop\` (build) — by design. Run it before
your tsc/bun build step in your own pipeline.`);
}

async function layoutCommand(args: string[]) {
	let configPath: string | undefined;
	const types: string[] = [];
	let schemaName: string | undefined;
	let versionName: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--type" || a === "-t") types.push(args[++i]!);
		else if (a === "--schema" || a === "-s") schemaName = args[++i];
		else if (a === "--version" || a === "-v") versionName = args[++i];
		else if (a === "--help" || a === "-h") {
			printHelp();
			return;
		} else if (!configPath) configPath = a;
		else {
			console.error(`schema-pop layout: unexpected argument "${a}"`);
			process.exit(2);
		}
	}

	const cfgPath = path.resolve(process.cwd(), configPath ?? "pop.config.ts");
	const jiti = createJiti(import.meta.url);
	const cfgModule = (await jiti.import(cfgPath)) as any;
	const config = cfgModule.default || cfgModule.config || cfgModule;
	const rootDir = path.dirname(cfgPath);

	const schemas = (config.schemas ?? []) as any[];
	if (schemas.length === 0) {
		console.error(`schema-pop layout: no schemas in ${cfgPath}`);
		process.exit(2);
	}
	const schema = schemaName
		? schemas.find((s) => s.name === schemaName)
		: schemas[0];
	if (!schema) {
		console.error(
			`schema-pop layout: schema "${schemaName}" not found (available: ${schemas
				.map((s) => s.name)
				.join(", ")})`,
		);
		process.exit(2);
	}

	const versions = (schema.versions ?? []) as any[];
	const version = versionName
		? versions.find((v) => v.version === versionName)
		: versions[versions.length - 1];
	if (!version) {
		console.error(
			`schema-pop layout: version "${versionName}" not found in schema "${schema.name}" (available: ${versions
				.map((v: any) => v.version)
				.join(", ")})`,
		);
		process.exit(2);
	}

	const fs = await import("node:fs");
	const filePath = path.resolve(
		rootDir,
		version.source.endsWith(".ts") ? version.source : version.source + ".ts",
	);
	if (!fs.existsSync(filePath)) {
		console.error(`schema-pop layout: source file not found: ${filePath}`);
		process.exit(2);
	}
	const sourceModule = (await jiti.import(filePath)) as any;

	let scope: any;
	if (version.exportName) scope = sourceModule[version.exportName];
	else if (sourceModule["$"]) scope = sourceModule["$"];
	else if (schema.name && sourceModule[schema.name])
		scope = sourceModule[schema.name];
	else {
		// duck-type
		for (const v of Object.values(sourceModule)) {
			if (
				typeof v === "object" &&
				v !== null &&
				typeof (v as any).export === "function" &&
				typeof (v as any).import === "function"
			) {
				scope = v;
				break;
			}
		}
	}
	if (!scope) {
		console.error(`schema-pop layout: no arktype scope export in ${filePath}`);
		process.exit(2);
	}

	const { SchemaAnalyzer } = await import("./layout/analyzer");
	const { dumpLayoutPlan } = await import("./layout/dump");
	const analyzer = new SchemaAnalyzer(scope, {
		wordSize: config.wordSize,
		autoLayout:
			schema.autoLayout !== undefined
				? schema.autoLayout
				: config.autoLayout,
		layoutType: schema.layout || config.layout || "aligned",
		mode: version.mode === "rich" ? "rich" : "binary",
	});
	const safeVersion = schema.name
		? `${schema.name}_${version.version}`
		: version.version;
	const plan = analyzer.analyze(safeVersion, config.endian || "le");

	process.stdout.write(
		dumpLayoutPlan(plan, types.length ? { types } : undefined),
	);
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
		if (cmd === "layout") {
			await layoutCommand(args.slice(1));
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
