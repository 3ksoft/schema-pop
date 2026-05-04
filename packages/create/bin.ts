#!/usr/bin/env bun
import {
	intro,
	outro,
	text,
	spinner,
	multiselect,
	select,
	isCancel,
	note,
} from "@clack/prompts";
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	statSync,
	existsSync,
	copyFileSync,
	rmSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import { cyan, green, dim, yellow, bold } from "kolorist";

const __dirname = import.meta.dirname;

// ---------------------------------------------------------------------------
// CLI flag parser
// ---------------------------------------------------------------------------

interface CliOptions {
	name?: string;
	type?: "monorepo" | "project" | "all";
	harnesses?: string[];
	schemas?: string[];
	help?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {};
	const args = argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			opts.help = true;
			continue;
		}

		const eqMatch = arg.match(/^--([a-z-]+)=(.+)$/);
		if (eqMatch) {
			applyFlag(opts, eqMatch[1], eqMatch[2]);
			continue;
		}

		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const val =
				args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : undefined;
			if (val !== undefined) {
				applyFlag(opts, key, val);
			} else {
				applyFlag(opts, key, "true");
			}
			continue;
		}

		if (!opts.name && !arg.startsWith("-")) {
			opts.name = arg;
		}
	}

	return opts;
}

function applyFlag(opts: CliOptions, key: string, value: string) {
	switch (key) {
		case "name":
			opts.name = value;
			break;
		case "type":
			if (value === "monorepo" || value === "project" || value === "all")
				opts.type = value;
			break;
		case "harnesses":
			opts.harnesses = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			break;
		case "schemas":
			opts.schemas = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			break;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Schema templates use the canonical `<name>.<version>.pop.ts` naming
 * (config v2). For the picker we only show unique schema names —
 * picking one copies every version file matching `<name>.*.pop.ts`.
 */
function getAvailableSchemas(): string[] {
	const schemasDir = join(__dirname, "schemas");
	if (!existsSync(schemasDir)) return [];
	const names = new Set<string>();
	for (const f of readdirSync(schemasDir)) {
		if (!statSync(join(schemasDir, f)).isFile()) continue;
		const m = f.match(/^(.+?)\.[0-9][0-9.]*\.pop\.tsx?$/);
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
 * Parse a `<name>.<version>.pop.ts(x)` filename into its parts. Mirrors
 * core's `parseSchemaFilename` but local to the scaffold so we don't
 * import schema-pop at scaffold-build time. Returns null when the
 * basename doesn't match the convention.
 */
function parsePopFilename(
	file: string,
): { schemaName: string; version: string } | null {
	const m = file.match(/^(.+?)\.([0-9][0-9.]*)\.pop\.tsx?$/);
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
 * Build the target-import + target-instantiation lines that the schema
 * file's `schemaPop({...}, scope({...}))` wrap will reference. Shared
 * across every emitted schema since one project usually wants the same
 * exporter set for all of them.
 *
 * Returns: `{ targetImports }` is the list of `import {...} from ...`
 * lines; `{ targetLines }` is the body that goes inside the
 * `targets: [ ... ]` array, indented one level for inline embedding.
 */
function computeTargetsBlock(
	pType: "monorepo" | "project" | "all",
	harnesses: string[],
): { targetImports: string[]; targetLines: string[] } {
	// Collect named imports per source module so we end up with one
	// `import { ts, rust, c, cpp, zig } from "@schema-pop/core-exporters"`
	// line instead of N separate same-source imports.
	const namesByModule = new Map<string, Set<string>>();
	const addImport = (mod: string, ...names: string[]) => {
		const set = namesByModule.get(mod) ?? new Set<string>();
		for (const n of names) set.add(n);
		namesByModule.set(mod, set);
	};
	const lines: string[] = [];

	if (pType === "monorepo" || pType === "all") {
		if (harnesses.includes("ts")) {
			addImport("@schema-pop/core-exporters", "ts");
			lines.push(
				`\t\t\tts({ dest: "../../packages/ts/src/schema.ts", exportJsonPlan: true }),`,
			);
		}
		if (harnesses.includes("rust")) {
			addImport("@schema-pop/core-exporters", "rust");
			lines.push(
				`\t\t\trust({ dest: "../../packages/rust/src/schema.rs", harness: true }),`,
			);
		}
		if (harnesses.includes("cpp")) {
			addImport("@schema-pop/core-exporters", "cpp", "c");
			lines.push(
				`\t\t\tcpp({ dest: "../../packages/cpp/src/schema.hpp", harness: true }),`,
			);
			lines.push(`\t\t\tc({ dest: "../../packages/cpp/src/schema.h" }),`);
		}
		if (harnesses.includes("zig")) {
			addImport("@schema-pop/core-exporters", "zig");
			lines.push(
				`\t\t\tzig({ dest: "../../packages/zig/src/schema.zig", pub: true, harness: true }),`,
			);
		}
		if (pType === "all") {
			addImport("@schema-pop/core-exporters", "random");
			addImport(
				"@schema-pop/extra-exporters",
				"brainfuck",
				"glsl",
				"html",
				"nuxtUi",
				"openapi",
				"svg",
				"wgsl",
			);
			lines.push(
				`\t\t\tbrainfuck({ dest: "../../packages/bf/schema.bf", harness: true }),`,
			);
			lines.push(`\t\t\tglsl({}),`);
			lines.push(`\t\t\thtml({}),`);
			lines.push(`\t\t\tnuxtUi({}),`);
			lines.push(`\t\t\topenapi({}),`);
			lines.push(`\t\t\trandom({}),`);
			lines.push(`\t\t\tsvg({}),`);
			lines.push(`\t\t\twgsl({}),`);
		}
	} else {
		// Standalone project: ts + rust by default.
		addImport("@schema-pop/core-exporters", "ts", "rust");
		lines.push(`\t\t\tts({ dest: "./dist/schema.ts", exportJsonPlan: true }),`);
		lines.push(`\t\t\trust({ dest: "./dist/schema.rs" }),`);
	}

	const targetImports = [...namesByModule.entries()].map(
		([mod, names]) =>
			`import { ${[...names].sort().join(", ")} } from "${mod}";`,
	);
	return { targetImports, targetLines: lines };
}

/**
 * For each schema name in `dir`, find the highest-version file and
 * inject a `schemaPop({ targets: [...] }, scope({...}))` wrap around
 * its existing `scope({...})` export. Older versions stay plain.
 *
 * The transform is a string replacement (no AST) — relies on the
 * scaffold templates having a literal `export const $ = scope(`
 * opening and a final `})` close. Templates are co-owned by this
 * package so we can guarantee the shape.
 */
function injectSchemaPopWraps(
	dir: string,
	targetImports: string[],
	targetLines: string[],
): void {
	if (!existsSync(dir)) return;
	const groups = new Map<string, { version: string; file: string }[]>();
	for (const f of readdirSync(dir)) {
		const parsed = parsePopFilename(f);
		if (!parsed) continue;
		const list = groups.get(parsed.schemaName) ?? [];
		list.push({ version: parsed.version, file: f });
		groups.set(parsed.schemaName, list);
	}

	for (const [, files] of groups) {
		files.sort((a, b) => compareVersions(a.version, b.version));
		const latest = files[files.length - 1]!;
		const path = join(dir, latest.file);
		const original = readFileSync(path, "utf-8");
		// Skip if already wrapped (idempotent).
		if (/schemaPop\(\s*\{/.test(original)) continue;

		// Find the schema-pop import line and ensure `schemaPop` is in
		// the destructured names. Bundled schemas may import e.g.
		// `{ scope, binary }` (no schemaPop) — need to inject it so
		// the wrap call below resolves.
		const popImportRe =
			/^import\s*\{\s*([^}]+?)\s*\}\s*from\s*["']schema-pop["'];?/m;
		const popMatch = original.match(popImportRe);
		if (!popMatch) {
			console.warn(
				`  ⚠ skip wrap: ${latest.file} has no \`from "schema-pop"\` import`,
			);
			continue;
		}
		const existingNames = popMatch[1]!
			.split(",")
			.map((n) => n.trim())
			.filter(Boolean);
		const namesSet = new Set(existingNames);
		namesSet.add("schemaPop");
		namesSet.add("scope");
		const fixedPopImport = `import { ${[...namesSet].sort().join(", ")} } from "schema-pop";`;
		const importsBlock = targetImports.length
			? `\n${targetImports.join("\n")}`
			: "";

		const targetsBody =
			targetLines.length > 0 ? `\n${targetLines.join("\n")}\n\t\t` : "";

		const wrapped = original
			.replace(popImportRe, `${fixedPopImport}${importsBlock}`)
			.replace(
				/export const \$ = scope\(/,
				`export const $ = schemaPop(\n\t{\n\t\ttargets: [${targetsBody}],\n\t},\n\tscope(`,
			)
			.replace(/\}\);(\s*)$/, "}),\n);$1");
		writeFileSync(path, wrapped);
	}
}

function printHelp() {
	console.log(`
${bold(cyan("create-schema-pop"))} — scaffold a new schema-pop project

${bold("Usage:")}
  bunx create-schema-pop [options]

${bold("Options:")}
  --name <name>           Project name (directory to create)
  --type <type>           Project type: ${cyan("monorepo")} (default), ${cyan("project")}, or ${cyan("all")}
                          ${dim("all = monorepo + every harness + every exporter")}
  --harnesses <list>      Comma-separated harness languages: ${cyan("ts,rust,cpp,zig")} (monorepo only)
  --schemas <list>        Comma-separated schema names to include from bundled schemas/
  -h, --help              Show this help message

${bold("Examples:")}
  bunx create-schema-pop --name my-project --type monorepo --harnesses ts,rust
  bunx create-schema-pop --name my-project --type project --schemas pin-status
  bunx create-schema-pop --name kitchen-sink --type all   ${dim("# every harness + exporter")}
  bunx create-schema-pop   ${dim("# interactive mode")}
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const cliOpts = parseArgs(process.argv);

	if (cliOpts.help) {
		printHelp();
		process.exit(0);
	}

	const isInteractive = !cliOpts.name;
	const availableSchemas = getAvailableSchemas();
	const availableHarnesses = getAvailableHarnesses();

	let projectName: string;
	let projectType: "monorepo" | "project" | "all";
	let selectedHarnesses: string[];
	let selectedSchemas: string[];

	if (isInteractive) {
		intro(cyan(bold(" 🍭 schema-pop initializer ")));

		const name = await text({
			message: "What is your project name?",
			placeholder: "my-schema-project",
			validate: (value) => {
				if (!value) return "Project name is required";
				if (existsSync(join(process.cwd(), value)))
					return "Directory already exists";
			},
		});
		if (isCancel(name)) {
			process.exit(0);
		}
		projectName = name as string;

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
		projectName = cliOpts.name!;
		if (existsSync(join(process.cwd(), projectName))) {
			console.error(`Error: directory "${projectName}" already exists.`);
			process.exit(1);
		}

		projectType = cliOpts.type ?? "monorepo";
		selectedHarnesses =
			projectType === "monorepo"
				? (cliOpts.harnesses ?? ["ts", "rust"])
				: projectType === "all"
					? [...availableHarnesses]
					: [];
		if (cliOpts.schemas) {
			selectedSchemas = cliOpts.schemas.filter((s) => {
				if (!availableSchemas.includes(s)) {
					console.warn(yellow(`Warning: schema "${s}" not found — skipping.`));
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

			if (filePath.endsWith("pop.config.ts")) {
				// Config v2: pop.config.ts is just discovery + global flags.
				// Targets live in each schema file's `schemaPop({...}, scope({...}))`
				// wrap, injected during the schema-copy pass below.
				// NOTE: doc-comment uses `// ` lines instead of /** */ because
				// the default glob string `./**/*.pop.ts` contains `*/`,
				// which terminates a JSDoc block early. Tools like Biome
				// auto-strip the escape if you use `/* ... \\*\\/ ... */`,
				// so plain line-comments are the only safe form here.
				content = `// schema-pop config (v2). The discovery glob defaults to
// \`./**/*.pop.ts\` when omitted; per-schema targets and layout flags
// live inside each \`<name>.<version>.pop.ts\` file via
// \`schemaPop({...}, scope({...}))\`.
//
// Reference: https://github.com/3ksoft/schema-pop/blob/main/docs/config.md
import { defineConfig } from "schema-pop";

export default defineConfig({
\tendian: "le",
\twordSize: 64,
});
`;
			}

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
						// LOCAL_TEST points at the in-tree workspace via `file:`
						// protocol so the scaffolded project installs without
						// Verdaccio and without being inside the bun workspace
						// tree itself. LOCAL_TEST_PACKAGES_DIR overrides the
						// resolution root (absolute path to packages/).
						const localRoot = process.env.LOCAL_TEST_PACKAGES_DIR;
						const pkgPathMap: Record<string, string> = {
							"schema-pop": "core",
							"@schema-pop/core-exporters": "core-exporters",
							"@schema-pop/extra-exporters": "extra-exporters",
							"@schema-pop/clang-importer": "clang_importer",
							"@schema-pop/treesitter-importer": "treesitter_importer",
							"@schema-pop/importer": "importer",
						};
						const versionFor = (dep: string): string => {
							if (!process.env.LOCAL_TEST) return "latest";
							const sub = pkgPathMap[dep];
							if (!sub || !localRoot) return "latest";
							return `file:${localRoot}/${sub}`;
						};
						for (const dep of Object.keys(pkg.devDependencies)) {
							if (dep === "schema-pop" || dep.startsWith("@schema-pop/")) {
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
			copyRecursive(join(baseDir, "packages", "schema"), targetDir, replacer);
		}

		const schemaDestDir =
			projectType === "monorepo" || projectType === "all"
				? join(targetDir, "packages", "schema", "src", "schema")
				: join(targetDir, "src", "schema");

		// Compute target imports + list once — same set across every
		// schema this project ships (config v2 puts targets in each
		// schema file's `schemaPop({...}, scope({...}))` wrap).
		const { targetImports, targetLines } = computeTargetsBlock(
			projectType,
			selectedHarnesses,
		);

		if (selectedSchemas.length > 0 && existsSync(schemasDir)) {
			mkdirSync(schemaDestDir, { recursive: true });
			for (const schemaName of selectedSchemas) {
				// Copy every version file matching `<schemaName>.*.pop.ts`.
				for (const f of readdirSync(schemasDir)) {
					const parsed = parsePopFilename(f);
					if (parsed?.schemaName !== schemaName) continue;
					copyFileSync(join(schemasDir, f), join(schemaDestDir, f));
				}
			}
		} else {
			// No preset picked — strip the test-schema fixtures the scaffold
			// ships by default and drop a minimal default.1.0.pop.ts.
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
				join(schemaDestDir, "default.1.0.pop.ts"),
				`import { schemaPop, scope } from "schema-pop";\n\nexport const $ = scope({\n\t...schemaPop,\n\thasSchema: "boolean",\n});\n`,
			);
		}

		// Wrap the LATEST version of each schema with schemaPop({ targets },
		// scope({...})) so the build picks up exporters. Older versions in a
		// chain stay as plain `scope({})` exports — they inherit defaults
		// and only contribute to migration emit between consecutive versions.
		injectSchemaPopWraps(schemaDestDir, targetImports, targetLines);

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
}

main().catch(console.error);
