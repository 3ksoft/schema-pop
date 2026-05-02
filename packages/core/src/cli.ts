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
  schema-pop emit <schema.pop.ts> [-t <type>] [-o <output>]
                                      One-shot render of a single schema. Reads
                                      stdin when input is \`-\` or omitted on a
                                      pipe. Output goes to stdout if -o omitted;
                                      type inferred from the -o extension when
                                      -t is missing. Bypasses pop.config.ts.
  schema-pop bind <source> [--out <dest>]
                                      Append destructured exports + type aliases
                                      from arktype scope(s) to a copy of <source>.
  schema-pop bind --config <pop-cfg>  Run all \`bindings:\` entries from a pop.config.ts.
  schema-pop layout [config-path] [--type T] [--schema S] [--version V]
                                      Dump the analyzer's view of struct / union
                                      offsets + sizes (P16 diagnostic).
  schema-pop --help                   Show this help.

Emit flags:
  -t, --type <name>    Target language: rust | c | cpp | go | ts | zig | md |
                       html | wgsl | glsl | svg | openapi | nuxt-ui | mermaid.
                       Inferred from --output extension when omitted.
  -o, --output <path>  Output file (default: stdout).
  -n, --name <name>    Override schema name (handy for stdin / non-canonical
                       filenames). Default: parsed from input filename or "stdin".

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

const EMIT_TYPE_BY_EXT: Record<string, string> = {
	rs: "rust",
	h: "c",
	hpp: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	cc: "cpp",
	ts: "ts",
	zig: "zig",
	go: "go",
	md: "md",
	html: "html",
	wgsl: "wgsl",
	glsl: "glsl",
	svg: "svg",
	yaml: "openapi",
	yml: "openapi",
	mmd: "mermaid",
	bf: "brainfuck",
	json: "json-schema",
};

const EMIT_PACKAGE_BY_TYPE: Record<string, "core" | "extra"> = {
	rust: "core",
	c: "core",
	cpp: "core",
	ts: "core",
	zig: "core",
	go: "core",
	random: "core",
	md: "extra",
	html: "extra",
	wgsl: "extra",
	glsl: "extra",
	svg: "extra",
	openapi: "extra",
	mermaid: "extra",
	"nuxt-ui": "extra",
	nuxtUi: "extra",
	brainfuck: "extra",
	bf: "extra",
	jsonSchema: "extra",
	"json-schema": "extra",
};

const EMIT_FACTORY_BY_TYPE: Record<string, string> = {
	"nuxt-ui": "nuxtUi",
	bf: "brainfuck",
	"json-schema": "jsonSchema",
};

async function loadEmitExporter(
	type: string,
): Promise<{ name: string; instance: any } | null> {
	const pkg = EMIT_PACKAGE_BY_TYPE[type];
	if (!pkg) return null;
	const factoryName = EMIT_FACTORY_BY_TYPE[type] ?? type;
	const moduleName =
		pkg === "core"
			? "@schema-pop/core-exporters"
			: "@schema-pop/extra-exporters";
	let mod: Record<string, any>;
	try {
		// Resolve from the user's cwd, not from cli.ts's location.
		// Without the explicit resolveSync the dynamic import would
		// look in `packages/core/node_modules/` which doesn't carry
		// the exporter packages (no circular dep).
		const Bun = (globalThis as { Bun?: { resolveSync?: (s: string, from: string) => string } }).Bun;
		const resolved = Bun?.resolveSync
			? Bun.resolveSync(moduleName, process.cwd())
			: moduleName;
		mod = (await import(resolved)) as Record<string, any>;
	} catch (e) {
		console.error(
			`schema-pop emit: failed to load ${moduleName}.\n  ${(e as Error).message}\n  hint: bun add -d ${moduleName}`,
		);
		process.exit(2);
	}
	const factory = mod[factoryName];
	if (typeof factory !== "function") {
		console.error(
			`schema-pop emit: ${moduleName} has no exporter named "${factoryName}".`,
		);
		process.exit(2);
	}
	return { name: type, instance: factory({}) };
}

async function emitCommand(args: string[]) {
	let input: string | undefined;
	let output: string | undefined;
	let typeName: string | undefined;
	let nameOverride: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--type" || a === "-t") typeName = args[++i];
		else if (a === "--output" || a === "-o") output = args[++i];
		else if (a === "--name" || a === "-n") nameOverride = args[++i];
		else if (a === "--help" || a === "-h") {
			printHelp();
			return;
		} else if (!input) input = a;
		else {
			console.error(`schema-pop emit: unexpected argument "${a}"`);
			process.exit(2);
		}
	}

	// Stdin support: explicit `-` or no positional arg + non-TTY stdin.
	const fs = await import("node:fs");
	const useStdin =
		input === "-" || (!input && !process.stdin.isTTY);
	let absInput: string;
	let cleanupTmp: (() => void) | null = null;
	if (useStdin) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin)
			chunks.push(chunk as Buffer);
		const source = Buffer.concat(chunks).toString("utf8");
		const os = await import("node:os");
		const tmp = path.join(
			os.tmpdir(),
			`schema-pop-emit-${process.pid}-${Date.now()}.pop.ts`,
		);
		fs.writeFileSync(tmp, source);
		absInput = tmp;
		cleanupTmp = () => {
			try {
				fs.unlinkSync(tmp);
			} catch {}
		};
	} else if (!input) {
		console.error(
			"schema-pop emit: input file required (or pipe via stdin).\n  schema-pop emit <schema.pop.ts> [-t <type>] [-o <output>]\n  cat <schema.pop.ts> | schema-pop emit -t md",
		);
		process.exit(2);
	} else {
		absInput = path.resolve(process.cwd(), input);
	}

	if (!typeName && output) {
		const ext = path.extname(output).replace(/^\./, "").toLowerCase();
		typeName = EMIT_TYPE_BY_EXT[ext];
	}
	if (!typeName) {
		console.error(
			"schema-pop emit: -t <type> required (or pass -o <file.ext> to infer).",
		);
		process.exit(2);
	}

	if (!fs.existsSync(absInput)) {
		console.error(`schema-pop emit: input not found: ${absInput}`);
		process.exit(2);
	}

	const exporter = await loadEmitExporter(typeName);
	if (!exporter) {
		const known = Object.keys(EMIT_PACKAGE_BY_TYPE).sort().join(", ");
		console.error(
			`schema-pop emit: unknown target "${typeName}". Known: ${known}`,
		);
		process.exit(2);
	}

	const jiti = createJiti(import.meta.url);
	const mod = (await jiti.import(absInput)) as Record<string, unknown>;
	const { findScopeForEmit, parseSchemaFilenameLocal } = await import(
		"./schema/index"
	).then(async () => {
		const { isArktypeScope } = await import("./bind");
		const { parseSchemaFilename } = await import("./schema/config");
		return {
			findScopeForEmit: (m: Record<string, unknown>): unknown => {
				if (m["$"] && isArktypeScope(m["$"])) return m["$"];
				if (m["default"] && isArktypeScope(m["default"]))
					return m["default"];
				for (const v of Object.values(m)) if (isArktypeScope(v)) return v;
				return undefined;
			},
			parseSchemaFilenameLocal: parseSchemaFilename,
		};
	});

	const scope = findScopeForEmit(mod);
	if (!scope) {
		console.error(
			`schema-pop emit: no arktype scope export in ${path.relative(process.cwd(), absInput)}.`,
		);
		process.exit(2);
	}

	const { getSchemaPopConfig } = await import("./schema/schema-pop");
	const fileCfg = getSchemaPopConfig(scope) ?? {};
	// Stdin input has no meaningful filename — skip parsing so the
	// throwaway temp basename doesn't become the schema name.
	const parsed = useStdin ? null : parseSchemaFilenameLocal(absInput);
	const schemaName =
		nameOverride ??
		fileCfg.schemaName ??
		parsed?.schemaName ??
		(useStdin ? "stdin" : path.basename(absInput).replace(/\.(pop\.)?tsx?$/, ""));
	const version = fileCfg.version ?? parsed?.version ?? "1";

	const { SchemaAnalyzer } = await import("./layout/analyzer");
	const analyzer = new SchemaAnalyzer(scope as any, {
		wordSize: fileCfg.wordSize ?? 64,
		autoLayout: fileCfg.autoLayout ?? true,
		layoutType: fileCfg.layout ?? "aligned",
		mode: fileCfg.mode ?? "binary",
	});
	const safeVersion = `${schemaName}_${version}`;
	const plan = analyzer.analyze(safeVersion, fileCfg.endian ?? "le");
	const functions = mod["functions"];
	if (Array.isArray(functions) && functions.length > 0) {
		(plan as any).functions = functions;
	}

	const instance = exporter.instance;
	let content = instance.generate(plan);
	if (typeof content !== "string") {
		console.error(
			`schema-pop emit: ${typeName} exporter produces multiple files — write a config + run \`schema-pop\` instead.`,
		);
		process.exit(2);
	}
	if (instance.wrapVersion) content = instance.wrapVersion(schemaName, content);
	if (instance.getFileHeader) content = instance.getFileHeader() + content;
	if (instance.getFileFooter) content += instance.getFileFooter();

	if (output) {
		const absOut = path.resolve(process.cwd(), output);
		fs.mkdirSync(path.dirname(absOut), { recursive: true });
		fs.writeFileSync(absOut, content);
		console.error(
			`✅ [Schema-Pop] Generated: ${path.relative(process.cwd(), absOut)}`,
		);
	} else {
		process.stdout.write(content);
	}
	cleanupTmp?.();
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
		if (cmd === "emit") {
			await emitCommand(args.slice(1));
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
