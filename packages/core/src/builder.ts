import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { SchemaAnalyzer } from "./layout/analyzer";
import { runBindings, isArktypeScope, type BindingSpec } from "./bind";
import { diffPlans } from "./migrations";
import { compareVersions, parseSchemaFilename, type PopConfig } from "./schema/config";
import {
	getSchemaPopConfig,
	type SchemaPopConfig,
} from "./schema/schema-pop";
import type { ExporterPlugin, LayoutPlan } from "./schema/index";
import { renderComment } from "./utils/comments";

/**
 * Reads schema-pop's own package.json so the auto-generated header can
 * include the version that produced the file. Cached after first hit;
 * falls back to "unknown" if package.json can't be located (unlikely
 * but harmless).
 */
let cachedVersion: string | undefined;
function getSchemaPopVersion(): string {
	if (cachedVersion) return cachedVersion;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [
			path.resolve(here, "../package.json"), // src/* layout
			path.resolve(here, "../../package.json"), // dist/* layout
		];
		for (const p of candidates) {
			if (fs.existsSync(p)) {
				const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
				if (pkg.name === "schema-pop" && typeof pkg.version === "string") {
					cachedVersion = pkg.version as string;
					return cachedVersion;
				}
			}
		}
	} catch {
		// fall through
	}
	cachedVersion = "unknown";
	return cachedVersion;
}

type MigrationSummary = {
	target: string;
	schemaName: string;
	fromVersion: string;
	toVersion: string;
	autoCount: number;
	userSupplied: { typeName: string; reasons: string[] }[];
};

interface EffectiveConfig {
	endian: "le" | "be";
	wordSize: 32 | 64;
	autoLayout: boolean;
	layout: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
	mode: "binary" | "rich";
}

function mergeConfigs(
	global: PopConfig,
	file: SchemaPopConfig | undefined,
): EffectiveConfig {
	const f = file ?? {};
	return {
		endian: f.endian ?? global.endian ?? "le",
		wordSize: f.wordSize ?? global.wordSize ?? 64,
		autoLayout: f.autoLayout ?? global.autoLayout ?? true,
		layout: f.layout ?? global.layout ?? "aligned",
		mode: f.mode ?? global.mode ?? "binary",
	};
}

function resolveTargets(
	global: PopConfig,
	file: SchemaPopConfig | undefined,
): ExporterPlugin<any>[] {
	const fileTargets = file?.targets ?? [];
	const globalTargets = global.targets ?? [];
	const extendsTargets = file?.extendsTargets ?? true;
	if (fileTargets.length === 0) return globalTargets;
	if (!extendsTargets) return fileTargets;
	return [...globalTargets, ...fileTargets];
}

function findScope(module: Record<string, unknown>): unknown {
	if (module["$"]) return module["$"];
	for (const v of Object.values(module)) {
		if (isArktypeScope(v)) return v;
	}
	return undefined;
}

function expandGlobs(patterns: string[], rootDir: string): string[] {
	const Bun = (globalThis as { Bun?: { Glob?: any } }).Bun;
	if (!Bun?.Glob) {
		throw new Error(
			"schema-pop discovery requires Bun's runtime (Bun.Glob is not available).",
		);
	}
	const seen = new Set<string>();
	for (const pat of patterns) {
		const glob = new Bun.Glob(pat);
		for (const f of glob.scanSync({ cwd: rootDir, absolute: true })) {
			seen.add(f as string);
		}
	}
	return [...seen].sort();
}

export async function buildConfig(
	configPath: string,
	ctx?: { addWatchFile?: (p: string) => void },
) {
	const jiti = createJiti(import.meta.url);
	const resolvedPath = path.resolve(process.cwd(), configPath);
	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`Configuration file not found: ${resolvedPath}`);
	}
	const rootDir = path.dirname(resolvedPath);
	const configModule = (await jiti.import(resolvedPath)) as Record<
		string,
		unknown
	>;
	const config =
		(configModule["default"] as PopConfig | undefined) ??
		(configModule["config"] as PopConfig | undefined) ??
		(configModule as unknown as PopConfig);
	await buildSchema(config, rootDir, ctx);
	const bindings = config.bindings as BindingSpec[] | undefined;
	if (bindings?.length) {
		await runBindings(bindings, rootDir);
	}
}

export function generateTypes(schema: LayoutPlan, target: ExporterPlugin<any>) {
	const config = target.config;
	const code = target.generate(schema);
	if (typeof code === "string" && code && !config.noWrap) {
		return code;
	}
	return code;
}

export async function buildSchema(
	config: PopConfig,
	rootDir: string,
	ctx?: { addWatchFile?: (p: string) => void },
) {
	const jiti = createJiti(import.meta.url);
	const targetContents: Record<
		string,
		{
			targetConfig: any;
			targetInstance: ExporterPlugin<any>;
			body: string;
			plans: LayoutPlan[];
			contributors: { schemaName: string; version: string }[];
		}
	> = {};
	const migrationSummaries: MigrationSummary[] = [];

	// 1. Discover schema files via glob (default ./**/*.pop.ts).
	const patternsRaw = config.schemas;
	const patterns: string[] = Array.isArray(patternsRaw)
		? patternsRaw
		: typeof patternsRaw === "string"
			? [patternsRaw]
			: ["**/*.pop.ts", "**/*.pop.tsx"];
	const candidateFiles = expandGlobs(patterns, rootDir);

	// 2. Load each candidate file and resolve (schemaName, version).
	//    The filename pattern is the convention; an explicit
	//    `schemaPop({ schemaName, version }, scope)` overrides it so a
	//    file outside the naming convention can still join the build
	//    (e.g. importer-generated `wifi-types.gen.ts`).
	type Loaded = {
		version: string;
		path: string;
		scope: any;
		fileCfg: SchemaPopConfig | undefined;
		mod: Record<string, unknown>;
	};
	const groups = new Map<string, Loaded[]>();
	for (const file of candidateFiles) {
		if (ctx?.addWatchFile) ctx.addWatchFile(file);
		let mod: Record<string, unknown>;
		try {
			mod = (await jiti.import(file)) as Record<string, unknown>;
		} catch (e) {
			console.error(
				`❌ [Schema-Pop] Failed to load ${path.relative(rootDir, file)}: ${(e as Error).message}`,
			);
			continue;
		}
		const scope = findScope(mod);
		if (!scope) {
			console.error(
				`❌ [Schema-Pop] No arktype scope export in ${path.relative(rootDir, file)} — skipping.`,
			);
			continue;
		}
		const fileCfg = getSchemaPopConfig(scope);

		let schemaName: string | undefined;
		let version: string | undefined;
		if (fileCfg?.schemaName && fileCfg?.version) {
			schemaName = fileCfg.schemaName;
			version = fileCfg.version;
		} else {
			const parsed = parseSchemaFilename(file);
			if (parsed) {
				schemaName = parsed.schemaName;
				version = parsed.version;
			}
		}
		if (!schemaName || !version) {
			console.warn(
				`⚠️  [Schema-Pop] ${path.relative(rootDir, file)}: filename doesn't match <name>.<version>.pop.ts and \`schemaPop({...})\` didn't set both \`schemaName\` and \`version\` — skipping.`,
			);
			continue;
		}

		const entry: Loaded = { version, path: file, scope, fileCfg, mod };
		const list = groups.get(schemaName);
		if (list) list.push(entry);
		else groups.set(schemaName, [entry]);
	}

	if (groups.size === 0) {
		console.warn(
			`⚠️  [Schema-Pop] No schema files matched ${patterns.join(", ")} under ${rootDir}`,
		);
		return;
	}

	// 3. For each group: sort versions, run analyzer + emit.
	const groupNames = [...groups.keys()].sort();
	for (const schemaName of groupNames) {
		const loaded = groups.get(schemaName)!;
		loaded.sort((a, b) => compareVersions(a.version, b.version));

		// Effective config + targets: take the highest version's
		// `schemaPop()` config as the source of truth (older versions
		// usually don't even need a wrap). Layout / endian / mode flags
		// can still vary per version if the user explicitly wraps each.
		const latest = loaded[loaded.length - 1]!;
		const targets = resolveTargets(config, latest.fileCfg);

		let previousPlan: LayoutPlan | null = null;
		for (let i = 0; i < loaded.length; i++) {
			const v = loaded[i]!;
			const isLatest = i === loaded.length - 1;
			const eff = mergeConfigs(config, v.fileCfg);
			const safeVersion = `${schemaName}_${v.version}`;

			const analyzer = new SchemaAnalyzer(v.scope, {
				wordSize: eff.wordSize,
				autoLayout: eff.autoLayout,
				layoutType: eff.layout,
				mode: eff.mode,
			});
			const plan = analyzer.analyze(safeVersion, eff.endian);

			// Attach function declarations from the same module if exported.
			const functions = v.mod["functions"];
			if (Array.isArray(functions) && functions.length > 0) {
				plan.functions = functions;
			}

			for (const target of targets) {
				const instance = target as ExporterPlugin<any>;
				const targetConfig = instance.config;

				// Resolve `dest`: per-target wins; else `<destDir>/<schemaName>.<ext>`.
				let dest: string | undefined = targetConfig.dest;
				if (!dest && config.destDir) {
					const ext = instance.extension ?? instance.name;
					dest = path.join(config.destDir, `${schemaName}.${ext}`);
				}
				if (!dest) continue;

				if (!instance.wrapVersion && loaded.length > 1) {
					if (!isLatest) continue;
					console.warn(
						`⚠️  [Schema-Pop] Exporter "${instance.name}" only supports a single version — only ${schemaName}@${v.version} (latest) emitted to ${dest}`,
					);
				}

				let content = instance.generate(plan);

				if (typeof content === "string") {
					if (!targetContents[dest]) {
						targetContents[dest] = {
							targetConfig,
							targetInstance: instance,
							body: "",
							plans: [],
							contributors: [],
						};
					}
					const entry = targetContents[dest]!;
					entry.plans.push(plan);
					entry.contributors.push({ schemaName, version: v.version });

					if (instance.wrapVersion) {
						content = instance.wrapVersion(safeVersion, content);
					}
					entry.body += `${content}\n`;

					if (
						instance.wrapVersion &&
						previousPlan &&
						instance.generateMigration
					) {
						const migration = instance.generateMigration(previousPlan, plan);
						if (migration) entry.body += `\n${migration}\n`;
						migrationSummaries.push(
							buildMigrationSummary(
								instance.name,
								schemaName,
								previousPlan,
								plan,
							),
						);
					}
				} else {
					for (const [filename, subContent] of Object.entries(content)) {
						const fileDest = path.join(dest, filename);
						if (!targetContents[fileDest]) {
							targetContents[fileDest] = {
								targetConfig,
								targetInstance: instance,
								body: "",
								plans: [],
								contributors: [],
							};
						}
						targetContents[fileDest]!.plans.push(plan);
						targetContents[fileDest]!.contributors.push({
							schemaName,
							version: v.version,
						});
						targetContents[fileDest]!.body +=
							(subContent as string) + "\n";
					}
				}
			}
			previousPlan = plan;
		}
	}

	// 4. Write all aggregated outputs.
	for (const dest in targetContents) {
		const entry = targetContents[dest]!;
		const { targetInstance, targetConfig } = entry;
		const absDest = path.resolve(rootDir, dest);

		let finalFile = "";
		if (!targetConfig.noHeader) {
			const endianStr = (config.endian ?? "le") === "be"
				? "Big Endian"
				: "Little Endian";
			const lines = [`AUTO GENERATED BY schema-pop@${getSchemaPopVersion()}`];
			const seen = new Set<string>();
			const schemasList: string[] = [];
			for (const c of entry.contributors) {
				const tag = c.schemaName
					? `${c.schemaName}@${c.version}`
					: c.version;
				if (seen.has(tag)) continue;
				seen.add(tag);
				schemasList.push(tag);
			}
			if (schemasList.length === 1) {
				lines.push(`Schema: ${schemasList[0]}`);
			} else if (schemasList.length > 1) {
				lines.push(`Schemas: ${schemasList.join(", ")}`);
			}
			lines.push(`Layout: ${endianStr}`);
			const header = renderComment(
				targetConfig.commentStyle ?? "slash",
				lines.join("\n"),
			);
			if (header) finalFile += header + "\n";
		}

		if (targetInstance.getFileHeader) {
			finalFile += targetInstance.getFileHeader() + "\n";
		}

		if (targetConfig.prependToFile)
			finalFile += targetConfig.prependToFile + "\n";
		finalFile += entry.body;
		if (targetConfig.appendToFile)
			finalFile += targetConfig.appendToFile + "\n";

		if (targetInstance.getFileFooter) {
			finalFile += targetInstance.getFileFooter();
		}

		const dir = path.extname(absDest) ? path.dirname(absDest) : absDest;
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

		if (path.extname(absDest)) {
			fs.writeFileSync(absDest, finalFile);
			console.log(
				`✅ [Schema-Pop] Generated: ${path.relative(rootDir, absDest)}`,
			);
		}

		if (targetInstance.getHarness) {
			const harnessFiles = targetInstance.getHarness(entry.plans);
			for (const [filename, fileContent] of Object.entries(harnessFiles)) {
				const harnessDest = path.resolve(dir, filename);
				const hDir = path.dirname(harnessDest);
				if (!fs.existsSync(hDir)) fs.mkdirSync(hDir, { recursive: true });
				fs.writeFileSync(harnessDest, fileContent as string);
				console.log(
					`✅ [Schema-Pop] Harness File: ${path.relative(rootDir, harnessDest)}`,
				);
			}
		}
	}

	if (migrationSummaries.length > 0) printMigrationSummary(migrationSummaries);
}

function buildMigrationSummary(
	target: string,
	schemaName: string,
	from: LayoutPlan,
	to: LayoutPlan,
): MigrationSummary {
	const diff = diffPlans(from, to);
	let autoCount = 0;
	const userSupplied: { typeName: string; reasons: string[] }[] = [];
	for (const td of diff.types) {
		if (
			td.kind === "unchanged" ||
			td.kind === "added" ||
			td.kind === "removed"
		)
			continue;
		if (td.status === "auto") {
			autoCount++;
			continue;
		}
		const reasons = td.fieldChanges
			.filter((c) => c.status === "user-supplied")
			.map((c) => {
				switch (c.kind) {
					case "type-narrowed":
						return `field '${c.to.name}': narrowing`;
					case "type-changed":
						return `field '${c.to.name}': structural type change`;
					case "added":
						return `field '${c.field.name}': new field with no auto default`;
					case "renamed":
						return `field '${c.to.name}': renamed AND type changed`;
					default:
						return c.kind;
				}
			});
		userSupplied.push({
			typeName: (td as any).to.name,
			reasons: reasons.length > 0 ? reasons : ["see generated comment"],
		});
	}
	return {
		target,
		schemaName,
		fromVersion: from.version,
		toVersion: to.version,
		autoCount,
		userSupplied,
	};
}

function printMigrationSummary(summaries: MigrationSummary[]) {
	const totalAuto = summaries.reduce((n, s) => n + s.autoCount, 0);
	const totalUser = summaries.reduce((n, s) => n + s.userSupplied.length, 0);
	if (totalAuto === 0 && totalUser === 0) return;
	console.log(`\n📦 [Schema-Pop] migrations:`);
	console.log(`  ✓ ${totalAuto} auto-derived`);
	if (totalUser > 0) {
		console.log(`  ⚠  ${totalUser} require user-supplied impl:`);
		for (const s of summaries) {
			for (const u of s.userSupplied) {
				const tag = `${s.target}: ${s.schemaName ? `${s.schemaName} ` : ""}${u.typeName} ${s.fromVersion} → ${s.toVersion}`;
				console.log(`     - ${tag}`);
				for (const r of u.reasons) console.log(`         · ${r}`);
			}
		}
	}
}
