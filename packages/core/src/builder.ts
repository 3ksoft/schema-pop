import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { SchemaAnalyzer } from "./layout/analyzer";
import { runBindings, isArktypeScope, type BindingSpec } from "./bind";
import { diffPlans } from "./migrations";
import type { ExporterPlugin, LayoutPlan } from "./schema/index";
import { renderComment } from "./utils/comments";

type MigrationSummary = {
	target: string;
	schemaName: string;
	fromVersion: string;
	toVersion: string;
	autoCount: number;
	userSupplied: { typeName: string; reasons: string[] }[];
};

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
	const configModule = (await jiti.import(resolvedPath)) as any;
	const config = configModule.default || configModule.config || configModule;
	if (config.schemas?.length) await buildSchema(config, rootDir, ctx);
	const bindings = config.bindings as BindingSpec[] | undefined;
	if (bindings?.length) {
		await runBindings(bindings, rootDir);
	}
}

export function generateTypes(schema: LayoutPlan, target: ExporterPlugin<any>) {
	const config = target.config;
	let code = target.generate(schema);
	if (typeof code === "string" && code && !config.noWrap) {
		return code;
	}
	return code;
}

export async function buildSchema(
	config: any,
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
		}
	> = {};
	const migrationSummaries: MigrationSummary[] = [];

	for (const schema of config.schemas || []) {
		const versions = schema.versions || [];
		const targets = schema.targets || config.targets || [];
		let previousVersion: string | null = null;
		let previousPlan: LayoutPlan | null = null;

		for (let i = 0; i < versions.length; i++) {
			const v = versions[i]!;
			const safeVersion = schema.name
				? `${schema.name}_${v.version}`
				: v.version;
			const isLatest = i === versions.length - 1;
			const filePath = path.resolve(
				rootDir,
				v.source.endsWith(".ts") ? v.source : v.source + ".ts",
			);

			if (!fs.existsSync(filePath)) {
				console.error(`❌ [Schema-Pop] File not found: ${filePath}`);
				continue;
			}

			if (ctx?.addWatchFile) ctx.addWatchFile(filePath);

			const module = (await jiti.import(filePath)) as any;
			// Resolution order:
			// 1. Explicit `versions[].exportName` (errors if missing).
			// 2. Conventional `$` and the schema's name (existing behavior).
			// 3. Any other named export that duck-types as an arktype scope —
			//    this lets schemas use `export const konektor = scope({...})`
			//    without configuring `exportName` per version.
			let scope: any = undefined;
			let scopeSource = "";
			if (v.exportName) {
				scope = module[v.exportName];
				scopeSource = v.exportName;
			} else if (module["$"]) {
				scope = module["$"];
				scopeSource = "$";
			} else if (schema.name && module[schema.name]) {
				scope = module[schema.name];
				scopeSource = schema.name;
			} else {
				const candidate = Object.entries(module).find(
					([, val]) => isArktypeScope(val),
				);
				if (candidate) {
					scope = candidate[1];
					scopeSource = candidate[0];
				}
			}

			if (!scope) {
				console.error(`❌ [Schema-Pop] No export found in ${filePath}.`);
				continue;
			}
			void scopeSource;

			const analyzer = new SchemaAnalyzer(scope, {
				wordSize: config.wordSize,
				autoLayout:
					schema.autoLayout !== undefined
						? schema.autoLayout
						: config.autoLayout,
				layoutType: schema.layout || config.layout || "aligned",
				mode: v.mode === "rich" ? "rich" : "binary",
			});
			const plan = analyzer.analyze(safeVersion, config.endian || "le");

			// Attach function declarations from the same module if exported.
			// Importers (tree-sitter / clang) emit these as a named array
			// alongside the arktype scope; the analyzer never produces them
			// because functions aren't part of arktype's domain.
			const functions = module["functions"];
			if (Array.isArray(functions) && functions.length > 0) {
				plan.functions = functions;
			}

			for (const target of targets) {
				const instance = target as ExporterPlugin<any>;
				const targetConfig = instance.config;
				const dest = targetConfig.dest;

				if (!dest) continue;

				if (!instance.wrapVersion && versions.length > 1) {
					if (!isLatest) continue;
					console.warn(
						`⚠️  [Schema-Pop] Exporter "${instance.name}" only supports a single version! Only latest schema version will be exported to ${dest}`,
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
						};
					}
					const entry = targetContents[dest]!;
					entry.plans.push(plan);

					if (instance.wrapVersion) {
						content = instance.wrapVersion(safeVersion, content);
					}
					entry.body += `${content}\n`;

					if (
						instance.wrapVersion &&
						previousVersion &&
						previousPlan &&
						instance.generateMigration
					) {
						const migration = instance.generateMigration(previousPlan, plan);
						if (migration) entry.body += `\n${migration}\n`;
						migrationSummaries.push(
							buildMigrationSummary(
								instance.name,
								schema.name || "",
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
							};
						}
						targetContents[fileDest].plans.push(plan);
						targetContents[fileDest].body += (subContent as string) + "\n";
					}
				}
			}
			previousVersion = safeVersion;
			previousPlan = plan;
		}
	}

	for (const dest in targetContents) {
		const entry = targetContents[dest]!;
		const { targetInstance, targetConfig } = entry;
		const absDest = path.resolve(rootDir, dest);

		let finalFile = "";
		if (!targetConfig.noHeader) {
			const endianStr = config.endian === "be" ? "Big Endian" : "Little Endian";
			const header = renderComment(
				targetConfig.commentStyle ?? "slash",
				`AUTO GENERATED BY SCHEMA-POP\nLayout: ${endianStr}`,
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
			console.log(`✅ [Schema-Pop] Generated: ${dest}`);
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
		if (td.kind === "unchanged" || td.kind === "added" || td.kind === "removed") continue;
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
