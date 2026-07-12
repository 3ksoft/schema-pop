#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { type } from "arktype";
import cac from "cac";

import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import {
	CliParserSchema,
	PopSchema,
	PopSchemaSettings,
} from "@schema-pop/schema";

const isInteractive = process.stdout.isTTY === true;

const cli = cac("schema-pop");
const E_INFO = 1;
const E_DEBUG = 3;
const E_ERROR = 5;
var _log = "";
const log = (text: string, error_level: number = E_DEBUG) => {
	if (isInteractive) console.log(text);
	_log += text += "\n";
};
const jsonDump = (json: any, multiline?: boolean) => {
	if (multiline) return JSON.stringify(json, null, 2);
	else return JSON.stringify(json);
};
cli
	.command("[.args...]", "Build & Convert Schemas")
	.option("-o, --output <path>", "Output path")
	.option("-s, --schema", "Dump schema-pop json")
	.option("-a, --analyzer", "Dump analyzer json")
	.option("-l, --multiline", "dump multiline json")
	.option("-t, --type <name>", "Target language")
	.option("-m, --mode <name>", "Mode 'binary' | 'rich' = 'binary")

	.action(async (args, options) => {
		const config = CliParserSchema({
			input: args,
			output: options.output ?? "",
			type: options.type ?? "ts",
			mode: options.mode ?? "rich",
		});

		if (config instanceof type.errors) {
			log("❌ Could not parse arguments");
			for (const e of config) log(e.message);
			process.exit(1);
		}

		log(`🛠️  Processing ${config.inputs.length} files...`);

		for (const input of config.inputs) {
			try {
				const filePath = path.resolve(input.path);
				const ext = path.extname(filePath).slice(1);
				const basename = path.basename(filePath);
				let schema: any = undefined;

				// --- KROK OPCJONALNY: BEZPOŚREDNIE ŁADOWANIE (SKIP IMPORTER) ---

				// A. Obsługa JSON (jeśli to już jest gotowy PopSchema)
				if (ext === "json") {
					try {
						const raw = await readFile(filePath, "utf-8");
						const data = JSON.parse(raw);
						// Sprawdzamy czy to pasuje do naszego schematu
						const validated = PopSchema(data);
						if (!(validated instanceof type.errors)) {
							schema = validated;
							log(`✨ ${input.path}: Loaded directly as JSON schema`);
						}
					} catch {
						/* nie jest poprawnym JSONem lub schematem - spróbujemy importerem */
					}
				}

				// B. Obsługa TS/JS (jeśli plik eksportuje schemat ArkType)
				if (!schema && ["ts", "js", "tsx", "jsx"].includes(ext)) {
					try {
						// Bun potrafi importować .ts bezpośrednio
						const mod = await import(filePath);
						for (const k in mod) {
							const ex = mod[k];
							if ((ex as any)[" arkKind"]) {
								const mod =
									typeof (ex as any).export === "function"
										? (ex as any).export()
										: ex;
								const settings: PopSchemaSettings = {
									mode: config.mode,
								};
								const result = fromModule(mod, settings);
								if (result.errors.length > 0) {
									for (const err in result.errors) log(err, E_ERROR);
									return;
								}
								for (const warn in result.warnings) {
									log(warn);
								}
								schema = result.schema;
								log(`✨ ${input.path}: Extracted schema from ${ex}`);
								break;
							}
						}
					} catch {}
				}

				// 2. KROK STANDARDOWY: IMPORTER (jeśli skróty nie zadziałały)
				if (!schema) {
					const importerPkg = await smartResolve(
						"@schema-pop/importer",
						filePath,
					);
					const source = await readFile(filePath, "utf-8");
					const importerFunc = importerPkg[ext] || importerPkg.default;

					if (typeof importerFunc === "function") {
						schema = await importerFunc({
							name: filePath.replace(/\.(ts|tsx|json)$/, ""),
							contents: source,
							config: null,
						});
					}
				}

				if (!schema || !schema.types) {
					log(`⚠️  Skipped ${input.path}: No valid schema types found`);
					continue;
				}

				if (options.schema) {
					console.log(jsonDump(schema, options.multiline));
					return;
				}

				const analyzer = new SchemaAnalyzer();
				const { plan } = analyzer.analyze(schema);

				if (options.analyzer) {
					console.log(jsonDump(schema, options.multiline));
					return;
				}

				const exporterPkg = await smartResolve(
					"@schema-pop/exporter",
					filePath,
				);

				const targetType = config.target.type;
				const generated = exporterPkg.exportPlan(plan, targetType, {});

				// Multi-file output (e.g. harness exporters) — `generated` is a
				// `Record<string, string>` of relative paths → contents. Write
				// each entry into the output directory.
				if (typeof generated !== "string") {
					if (config.target.path === "stdout") {
						log(`\n--- Result for ${input.path} ---`);
						for (const [name, contents] of Object.entries(generated)) {
							log(`\n--- ${name} ---`);
							log(String(contents));
						}
					} else {
						const baseDir = config.target.path.endsWith("/")
							? config.target.path
							: config.target.path + "/";
						for (const [name, contents] of Object.entries(generated)) {
							const outFile = path.join(baseDir, name);
							await mkdir(path.dirname(outFile), { recursive: true });
							await writeFile(outFile, String(contents), "utf-8");
							log(`✅ Generated: ${outFile}`);
						}
					}
					continue;
				}

				const content = generated;

				const outName =
					filePath.replace(/\.(ts|tsx|json)$/, "") + `.${targetType}`;
				const outPath =
					config.target.path === "stdout"
						? null
						: config.target.path.endsWith("/")
							? path.join(config.target.path, outName)
							: config.target.path;

				if (!outPath) {
					log(`\n--- Result for ${input.path} ---`);
					log(content);
				} else {
					await mkdir(path.dirname(outPath), { recursive: true });
					await writeFile(outPath, content, "utf-8");
					log(`✅ Generated: ${outPath}`);
				}
			} catch (err) {
				log(`❌ Error processing ${input.path}: ${err}`);
			}
		}
	});

cli.parse();
cli.help();

// ==========================================
// FUNKCJE POMOCNICZE
// ==========================================

async function smartResolve(
	moduleName: string,
	contextPath: string,
): Promise<any> {
	const searchPaths = [path.dirname(contextPath), process.cwd()];
	log(`🛠️  Loading ${moduleName}...`);
	log(`👀 Checking local installation`);

	for (const baseDir of searchPaths) {
		try {
			const baseUrl = `file://${path.join(baseDir, "index.js")}`;
			const resolved = import.meta.resolve(moduleName, baseUrl);
			if (resolved) {
				log(`✅ Using ${moduleName} at ${baseDir}`);
				return await import(resolved);
			}
		} catch {}
	}
	log(`👁️  Checking global paths`);

	const globalBases = [
		path.join(homedir(), ".bun", "install", "global", "node_modules"),
		getNpmGlobalRoot(),
		"/home/kr/Documents/schema-pop/packages/importer/dist",
		"/home/kr/Documents/schema-pop/packages/exporter/dist",
	];

	for (const base of globalBases) {
		if (!base) continue;

		const fullPath = path.join(base, moduleName);
		try {
			log(`✅ Using ${moduleName} at ${base}`);
			return await import(fullPath);
		} catch {
			log(`Checking ${path}`);
		}
	}

	throw new Error(
		`Module "${moduleName}" not found. ` +
			`Please install it locally in your project or globally via 'bun install -g ${moduleName}'.`,
	);
}

/**
 * Pobiera ścieżkę do globalnych modułów NPM.
 */
function getNpmGlobalRoot(): string | null {
	try {
		return execSync("npm root -g", { stdio: "pipe", encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}
