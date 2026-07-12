#!/usr/bin/env bun
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	intro,
	isCancel,
	multiselect,
	note,
	outro,
	select,
	spinner,
	text,
} from "@clack/prompts";
import cac from "cac";
import { bold, cyan, dim, green, yellow } from "kolorist";

const __dirname = import.meta.dirname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Schema templates use the canonical `<name>.<version>.ts` naming. For the
 * picker we only show unique schema names — picking one copies every version
 * file matching `<name>.*.ts`.
 */
function getAvailableSchemas(): string[] {
	const schemasDir = join(__dirname, "schemas");
	if (!existsSync(schemasDir)) return [];
	const names = new Set<string>();
	for (const f of readdirSync(schemasDir)) {
		if (!statSync(join(schemasDir, f)).isFile()) continue;
		const m = f.match(/^(.+?)\.[0-9][0-9.]*\.tsx?$/);
		if (m) names.add(m[1]!);
	}
	return [...names].sort();
}

function getAvailableHarnesses(): string[] {
	const harnessDir = join(__dirname, "scaffold", "harness");
	if (!existsSync(harnessDir)) return [];
	return readdirSync(harnessDir).filter((f) =>
		statSync(join(harnessDir, f)).isDirectory(),
	);
}

/**
 * Parse a `<name>.<version>.ts(x)` filename into its parts. Mirrors
 * core's `parseSchemaFilename` but local to the scaffold so we don't
 * import schema-pop at scaffold-build time. Returns null when the
 * basename doesn't match the convention.
 */
function parsePopFilename(
	file: string,
): { schemaName: string; version: string } | null {
	const m = file.match(/^(.+?)\.([0-9][0-9.]*)\.tsx?$/);
	if (!m) return null;
	return { schemaName: m[1]!, version: m[2]! };
}

function compareVersions(a: string, b: string): number {
	const sa = a.split(".");
	const sb = b.split(".");
	const max = Math.max(sa.length, sb.length);
	for (let i = 0; i < max; i++) {
		const na = Number(sa[i] ?? "0");
		const nb = Number(sb[i] ?? "0");
		if (Number.isFinite(na) && Number.isFinite(nb)) {
			if (na !== nb) return na - nb;
		}
	}
	return 0;
}

/**
 * Build the `TARGETS` array literal that gets spliced into the generated
 * `scripts/generate.ts`. Each entry is `{ target, dest, config? }` consumed
 * by `exportPlan(plan, target, config)`.
 */
function computeTargets(
	pType: "monorepo" | "project" | "all",
	harnesses: string[],
): string {
	const t: { target: string; dest: string; config?: string }[] = [];

	if (pType === "monorepo" || pType === "all") {
		// Each harness gets the schema struct (`<lang>`) plus the harness
		// project (`<lang>:harness` → main + build files) so it compiles and
		// can round-trip bytes over stdin/stdout in the ABI test.
		if (harnesses.includes("ts")) {
			t.push({
				target: "ts",
				dest: "../../packages/ts/src/schema.ts",
				config: "{ exportJsonPlan: true }",
			});
			// Codec (per-type serialize/deserialize) — the TS harness uses it to
			// encode fixtures to bytes for the cross-language round-trip.
			t.push({
				target: "ts:codec",
				dest: "../../packages/ts/src/codec.ts",
				config: '{ importPath: "./schema" }',
			});
			// Deterministic fixtures for the round-trip driver.
			t.push({
				target: "random",
				dest: "../../packages/ts/src/fixtures.json",
				config: "{ count: 8, seed: 42 }",
			});
		}
		if (harnesses.includes("rust")) {
			t.push({ target: "rust", dest: "../../packages/rust/src/schema.rs" });
			t.push({ target: "rust:harness", dest: "../../packages/rust/src" });
		}
		if (harnesses.includes("cpp")) {
			t.push({ target: "cpp", dest: "../../packages/cpp/src/schema.hpp" });
			t.push({ target: "c", dest: "../../packages/cpp/src/schema.h" });
			t.push({ target: "cpp:harness", dest: "../../packages/cpp/src" });
		}
		if (harnesses.includes("zig")) {
			t.push({
				target: "zig",
				dest: "../../packages/zig/src/schema.zig",
				config: "{ pub: true }",
			});
			t.push({ target: "zig:harness", dest: "../../packages/zig/src" });
		}
		if (pType === "all") {
			if (harnesses.includes("bf")) {
				t.push({ target: "bf", dest: "../../packages/bf/schema.bf" });
				t.push({ target: "bf:harness", dest: "../../packages/bf" });
			}
			t.push({ target: "html", dest: "./dist/schema.html" });
			t.push({ target: "svg", dest: "./dist/svg" });
			t.push({ target: "wgsl", dest: "./dist/schema.wgsl" });
			t.push({ target: "random", dest: "./dist/random.json" });
		}
	} else {
		t.push({
			target: "ts",
			dest: "./dist/schema.ts",
			config: "{ exportJsonPlan: true }",
		});
		t.push({ target: "rust", dest: "./dist/schema.rs" });
	}

	return t
		.map(
			(e) =>
				`\t{ target: "${e.target}", dest: "${e.dest}"${e.config ? `, config: ${e.config}` : ""} },`,
		)
		.join("\n");
}

/**
 * Splice the computed target list into the scaffolded `scripts/generate.ts`,
 * replacing the `/* __TARGETS__ *\/` placeholder. Schema sources stay plain
 * arktype `scope({...})` exports — generation is driven imperatively by the
 * script, not by a config-file builder.
 */
function injectTargets(schemaPkgDir: string, targetsLiteral: string): void {
	const scriptPath = join(schemaPkgDir, "scripts", "generate.ts");
	if (!existsSync(scriptPath)) return;
	const src = readFileSync(scriptPath, "utf-8");
	writeFileSync(
		scriptPath,
		src.replace(/[\t ]*\/\* __TARGETS__ \*\//, targetsLiteral),
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const cli = cac("create-schema-pop");

	cli
		.command("[name]", "Scaffold a new schema-pop project")
		.option(
			"--type <type>",
			"Project type: monorepo (default), project, or all",
		)
		.option(
			"--harnesses <list>",
			"Comma-separated harness languages: ts,rust,cpp,zig (monorepo only)",
		)
		.option(
			"--schemas <list>",
			"Comma-separated schema names to include from bundled schemas/",
		)
		.action(
			async (
				name: string | undefined,
				options: { type?: string; harnesses?: string; schemas?: string },
			) => {
				const isInteractive = !name;
				const availableSchemas = getAvailableSchemas();
				const availableHarnesses = getAvailableHarnesses();

				let projectName: string;
				let projectType: "monorepo" | "project" | "all";
				let selectedHarnesses: string[];
				let selectedSchemas: string[];

				if (isInteractive) {
					intro(cyan(bold(" 🍭 schema-pop initializer ")));

					const nameResult = await text({
						message: "What is your project name?",
						placeholder: "my-schema-project",
						validate: (value) => {
							if (!value) return "Project name is required";
							if (existsSync(join(process.cwd(), value)))
								return "Directory already exists";
						},
					});
					if (isCancel(nameResult)) {
						process.exit(0);
					}
					projectName = nameResult as string;

					const pType = await select({
						message: "What kind of project do you want to create?",
						options: [
							{
								value: "monorepo",
								label: "Multi-language Monorepo",
								hint: "Recommended — includes language harnesses",
							},
							{
								value: "project",
								label: "Standalone Schema Project",
								hint: "Single package, schema only",
							},
							{
								value: "all",
								label: "give me all!",
								hint: "Monorepo with all harnesses and all exporters",
							},
						],
					});
					if (isCancel(pType)) {
						process.exit(0);
					}
					projectType = pType as "monorepo" | "project" | "all";

					if (projectType === "monorepo") {
						const harnesses = await multiselect({
							message: "Select language harnesses to scaffold:",
							options: [
								{
									value: "ts",
									label: "TypeScript",
									hint: "Required for ABI consistency tests",
								},
								{ value: "rust", label: "Rust" },
								{ value: "cpp", label: "C / C++" },
								{ value: "zig", label: "Zig" },
							],
							initialValues: ["ts", "rust"],
						});
						if (isCancel(harnesses)) {
							process.exit(0);
						}
						selectedHarnesses = harnesses as string[];
					} else if (projectType === "all") {
						selectedHarnesses = [...availableHarnesses];
					} else {
						selectedHarnesses = [];
					}

					if (projectType === "all") {
						selectedSchemas = [...availableSchemas];
					} else if (availableSchemas.length > 0) {
						const schemas = await multiselect({
							message: "Select example schemas to include (optional):",
							options: availableSchemas.map((s) => ({ value: s, label: s })),
							required: false,
						});
						if (isCancel(schemas)) {
							process.exit(0);
						}
						selectedSchemas = schemas as string[];
					} else {
						selectedSchemas = [];
					}
				} else {
					projectName = name;
					if (existsSync(join(process.cwd(), projectName))) {
						console.error(`Error: directory "${projectName}" already exists.`);
						process.exit(1);
					}

					const rawType = options.type;
					if (
						rawType &&
						rawType !== "monorepo" &&
						rawType !== "project" &&
						rawType !== "all"
					) {
						console.error(
							`Error: --type must be one of: monorepo, project, all`,
						);
						process.exit(1);
					}
					projectType =
						(rawType as "monorepo" | "project" | "all") ?? "monorepo";

					const harnessesArg = options.harnesses
						?.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					selectedHarnesses =
						projectType === "monorepo"
							? (harnessesArg ?? ["ts", "rust"])
							: projectType === "all"
								? [...availableHarnesses]
								: [];

					const schemasArg = options.schemas
						?.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					if (schemasArg) {
						selectedSchemas = schemasArg.filter((s) => {
							if (!availableSchemas.includes(s)) {
								console.warn(
									yellow(`Warning: schema "${s}" not found — skipping.`),
								);
								return false;
							}
							return true;
						});
					} else if (projectType === "all") {
						selectedSchemas = [...availableSchemas];
					} else {
						selectedSchemas = [];
					}
				}

				selectedHarnesses = selectedHarnesses.filter((h) =>
					availableHarnesses.includes(h),
				);

				const targetDir = join(process.cwd(), projectName);
				const baseDir = join(__dirname, "scaffold", "base");
				const harnessDir = join(__dirname, "scaffold", "harness");
				const schemasDir = join(__dirname, "schemas");

				const s = spinner();
				s.start("Creating project structure...");

				function copyRecursive(
					src: string,
					dest: string,
					replacer: (content: string, filePath: string) => string,
				) {
					const stats = statSync(src);
					if (stats.isDirectory()) {
						mkdirSync(dest, { recursive: true });
						for (const file of readdirSync(src)) {
							if (["node_modules", "dist", "target"].includes(file)) continue;
							copyRecursive(join(src, file), join(dest, file), replacer);
						}
					} else {
						let content = readFileSync(src, "utf-8");
						content = replacer(content, src);
						writeFileSync(dest, content);
					}
				}

				function makeReplacer(
					pName: string,
					pType: "monorepo" | "project" | "all",
				): (content: string, filePath: string) => string {
					return (content: string, filePath: string): string => {
						content = content.replace(/example-schema-pop/g, pName);
						content = content.replace(/schema-pop-test/g, `${pName}-schema`);

						if (filePath.endsWith("package.json")) {
							try {
								const pkg = JSON.parse(content);
								if (pkg.name === pName || pkg.name === "example-schema-pop") {
									if (pType === "monorepo" || pType === "all")
										pkg.workspaces = [
											"packages/schema",
											...selectedHarnesses.map((h) => `packages/${h}`),
										];
								}
								if (
									pkg.name === `${pName}-schema` ||
									pkg.name === "schema-pop-test"
								) {
									pkg.devDependencies = pkg.devDependencies ?? {};
									const localRoot = process.env.LOCAL_TEST_PACKAGES_DIR;
									// npm-name → workspace dir under packages/. Mirrors the
									// flat layout: schema-pop = CLI, @schema-pop/* = libs.
									const pkgPathMap: Record<string, string> = {
										"schema-pop": "cli",
										"@schema-pop/schema": "schema",
										"@schema-pop/core": "core",
										"@schema-pop/exporter": "exporter",
										"@schema-pop/importer": "importer",
									};
									const versionFor = (dep: string): string => {
										if (!process.env.LOCAL_TEST) return "latest";
										const sub = pkgPathMap[dep];
										if (!sub || !localRoot) return "latest";
										return `file:${localRoot}/${sub}`;
									};
									for (const dep of Object.keys(pkg.devDependencies)) {
										if (
											dep === "schema-pop" ||
											dep.startsWith("@schema-pop/")
										) {
											pkg.devDependencies[dep] = versionFor(dep);
										}
									}
									pkg.devDependencies["schema-pop"] = versionFor("schema-pop");
								}
								content = JSON.stringify(pkg, null, 4) + "\n";
							} catch {}
						}
						return content;
					};
				}

				try {
					const replacer = makeReplacer(projectName, projectType);

					if (projectType === "monorepo" || projectType === "all") {
						copyRecursive(baseDir, targetDir, replacer);
						for (const lang of selectedHarnesses) {
							const harnessSrc = join(harnessDir, lang);
							const harnessDest = join(targetDir, "packages", lang);
							if (existsSync(harnessSrc)) {
								copyRecursive(harnessSrc, harnessDest, replacer);
							}
						}
					} else {
						copyRecursive(
							join(baseDir, "packages", "schema"),
							targetDir,
							replacer,
						);
					}

					const schemaDestDir =
						projectType === "monorepo" || projectType === "all"
							? join(targetDir, "packages", "schema", "src", "schema")
							: join(targetDir, "src", "schema");

					const targetsLiteral = computeTargets(
						projectType,
						selectedHarnesses,
					);

					if (selectedSchemas.length > 0 && existsSync(schemasDir)) {
						mkdirSync(schemaDestDir, { recursive: true });
						for (const schemaName of selectedSchemas) {
							for (const f of readdirSync(schemasDir)) {
								const parsed = parsePopFilename(f);
								if (parsed?.schemaName !== schemaName) continue;
								copyFileSync(join(schemasDir, f), join(schemaDestDir, f));
							}
						}
					} else {
						if (existsSync(schemaDestDir)) {
							for (const f of readdirSync(schemaDestDir)) {
								if (parsePopFilename(f)?.schemaName === "test-schema") {
									rmSync(join(schemaDestDir, f));
								}
							}
						} else {
							mkdirSync(schemaDestDir, { recursive: true });
						}
						writeFileSync(
							join(schemaDestDir, "default.1.0.ts"),
							`import { binary, scope } from "@schema-pop/schema";\n\nexport const $ = scope({\n\t...binary.import(),\n\tTelemetry: {\n\t\tid: "u32",\n\t\tvalue: "f32",\n\t\tactive: "bool",\n\t},\n});\n`,
						);
					}

					// Schema package root = parent of `src/schema`.
					const schemaPkgDir = join(schemaDestDir, "..", "..");
					injectTargets(schemaPkgDir, targetsLiteral);

					s.stop("Project structure created!");
					if (isInteractive) {
						note(
							`${dim("cd")} ${cyan(projectName)}\n${dim("bun install")}\n${dim(projectType === "monorepo" || projectType === "all" ? "bun run build" : "bun run generate")}`,
							"Next steps",
						);
						outro(`🎉 ${green(bold(projectName))} is ready!`);
					}
				} catch (err) {
					s.stop("Failed to initialize project");
					console.error(err);
					process.exit(1);
				}
			},
		);

	cli.help();
	cli.parse();
}

main().catch(console.error);
