#!/usr/bin/env bun
import { intro, outro, text, spinner, multiselect, select, isCancel, note } from "@clack/prompts";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, copyFileSync } from "node:fs";
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
            const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : undefined;
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
            if (value === "monorepo" || value === "project" || value === "all") opts.type = value;
            break;
        case "harnesses":
            opts.harnesses = value.split(",").map((s) => s.trim()).filter(Boolean);
            break;
        case "schemas":
            opts.schemas = value.split(",").map((s) => s.trim()).filter(Boolean);
            break;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAvailableSchemas(): string[] {
    const schemasDir = join(__dirname, "schemas");
    if (!existsSync(schemasDir)) return [];
    return readdirSync(schemasDir)
        .filter((f) => statSync(join(schemasDir, f)).isFile() && [".ts", ".js"].includes(extname(f)))
        .map((f) => basename(f, extname(f)));
}

function getAvailableHarnesses(): string[] {
    const harnessDir = join(__dirname, "scaffold", "harness");
    if (!existsSync(harnessDir)) return [];
    return readdirSync(harnessDir).filter((f) => statSync(join(harnessDir, f)).isDirectory());
}

/**
 * Group schema files by base name, treating `<base>V<n>.ts` as version <n>.0
 * and bare `<base>.ts` as version 1.0. Returns groups keyed by base name with
 * versions sorted ascending.
 */
function groupSchemaVersions(files: string[]): { name: string; versions: { version: string; file: string }[] }[] {
    const groups = new Map<string, { version: string; file: string }[]>();
    for (const file of files) {
        const m = file.match(/^(.+?)V(\d+)$/);
        const base = m ? m[1]! : file;
        const version = m ? `${m[2]}.0` : "1.0";
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base)!.push({ version, file });
    }
    return Array.from(groups.entries()).map(([name, versions]) => ({
        name,
        versions: versions.sort((a, b) => parseFloat(a.version) - parseFloat(b.version)),
    }));
}

function printHelp() {
    console.log(`
${bold(cyan("create-schema-pop"))} — scaffold a new schema-pop project

${bold("Usage:")}
  bunx create-schema-pop [options]

${bold("Options:")}
  --name <name>           Project name (directory to create)
  --type <type>           Project type: ${cyan("monorepo")} (default) or ${cyan("project")}
  --harnesses <list>      Comma-separated harness languages: ${cyan("ts,rust,cpp,zig")} (monorepo only)
  --schemas <list>        Comma-separated schema names to include from bundled schemas/
  -h, --help              Show this help message

${bold("Examples:")}
  bunx create-schema-pop --name my-project --type monorepo --harnesses ts,rust
  bunx create-schema-pop --name my-project --type project --schemas pin-status
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
                if (existsSync(join(process.cwd(), value))) return "Directory already exists";
            },
        });
        if (isCancel(name)) { process.exit(0); }
        projectName = name as string;

        const pType = await select({
            message: "What kind of project do you want to create?",
            options: [
                { value: "monorepo", label: "Multi-language Monorepo", hint: "Recommended — includes language harnesses" },
                { value: "project", label: "Standalone Schema Project", hint: "Single package, schema only" },
                { value: "all", label: "give me all!", hint: "Monorepo with all harnesses and all exporters" },
            ],
        });
        if (isCancel(pType)) { process.exit(0); }
        projectType = pType as "monorepo" | "project" | "all";

        if (projectType === "monorepo") {
            const harnesses = await multiselect({
                message: "Select language harnesses to scaffold:",
                options: [
                    { value: "ts", label: "TypeScript", hint: "Required for ABI consistency tests" },
                    { value: "rust", label: "Rust" },
                    { value: "cpp", label: "C / C++" },
                    { value: "zig", label: "Zig" },
                ],
                initialValues: ["ts", "rust"],
            });
            if (isCancel(harnesses)) { process.exit(0); }
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
            if (isCancel(schemas)) { process.exit(0); }
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
        selectedHarnesses = projectType === "monorepo" ? (cliOpts.harnesses ?? ["ts", "rust"]) : (projectType === "all" ? [...availableHarnesses] : []);
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

    selectedHarnesses = selectedHarnesses.filter((h) => availableHarnesses.includes(h));

    const targetDir = join(process.cwd(), projectName);
    const baseDir = join(__dirname, "scaffold", "base");
    const harnessDir = join(__dirname, "scaffold", "harness");
    const schemasDir = join(__dirname, "schemas");

    const s = spinner();
    s.start("Creating project structure...");

    function copyRecursive(src: string, dest: string, replacer: (content: string, filePath: string) => string) {
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

    function makeReplacer(pName: string, pType: "monorepo" | "project" | "all"): (content: string, filePath: string) => string {
        return (content: string, filePath: string): string => {
            content = content.replace(/example-schema-pop/g, pName);
            content = content.replace(/schema-pop-test/g, `${pName}-schema`);

            if (filePath.endsWith("pop.config.ts")) {
                const imports = new Set<string>();
                const sharedLines: string[] = [];
                const docLines: ((schemaName: string) => string)[] = [];

                if (pType === "monorepo" || pType === "all") {
                    if (selectedHarnesses.includes("ts")) {
                        imports.add(`import { ts } from "@schema-pop/core-exporters";`);
                        sharedLines.push(`                ts({ dest: "../../packages/ts/src/schema.ts", exportJsonPlan: true }),`);
                    }
                    if (selectedHarnesses.includes("rust")) {
                        imports.add(`import { rust } from "@schema-pop/core-exporters";`);
                        sharedLines.push(`                rust({ dest: "../../packages/rust/src/schema.rs", harness: true }),`);
                    }
                    if (selectedHarnesses.includes("cpp")) {
                        imports.add(`import { cpp, c } from "@schema-pop/core-exporters";`);
                        sharedLines.push(`                cpp({ dest: "../../packages/cpp/src/schema.hpp", harness: true }),`);
                        sharedLines.push(`                c({ dest: "../../packages/cpp/src/schema.h" }),`);
                    }
                    if (selectedHarnesses.includes("zig")) {
                        imports.add(`import { zig } from "@schema-pop/core-exporters";`);
                        sharedLines.push(`                zig({ dest: "../../packages/zig/src/schema.zig", pub: true, harness: true }),`);
                    }

                    if (pType === "all") {
                        imports.add(`import { random } from "@schema-pop/core-exporters";`);
                        imports.add(`import { brainfuck, glsl, html, nuxtUi, openapi, svg, wgsl } from "@schema-pop/extra-exporters";`);
                        sharedLines.push(`                brainfuck({ dest: "../../packages/bf/schema.bf", harness: true }),`);
                        docLines.push((n) => `                glsl({ dest: "./dist/${n}.glsl" }),`);
                        docLines.push((n) => `                html({ dest: "./dist/${n}.html" }),`);
                        docLines.push((n) => `                nuxtUi({ dest: "./dist/${n}-nuxt.ts" }),`);
                        docLines.push((n) => `                openapi({ dest: "./dist/${n}-openapi.json" }),`);
                        docLines.push((n) => `                random({ dest: "./dist/${n}-random.json" }),`);
                        docLines.push((n) => `                svg({ dest: "./dist/${n}-svg/" }),`);
                        docLines.push((n) => `                wgsl({ dest: "./dist/${n}.wgsl" }),`);
                    }
                } else {
                    // Standalone project: always include core-exporters targets
                    imports.add(`import { ts, rust } from "@schema-pop/core-exporters";`);
                    sharedLines.push(`                ts({ dest: "./dist/schema.ts", exportJsonPlan: true }),`);
                    sharedLines.push(`                rust({ dest: "./dist/schema.rs" }),`);
                }

                const renderTargets = (name: string) => {
                    const lines = [...sharedLines, ...docLines.map((f) => f(name))];
                    return "\n" + lines.join("\n") + "\n";
                };

                const importsStr = Array.from(imports).join("\n") + "\nimport { defineConfig } from \"schema-pop\";\n";
                if (selectedSchemas.length > 0) {
                    const groups = groupSchemaVersions(selectedSchemas);
                    const schemaEntries = groups.map((g) => {
                        const versionsBody = g.versions.map((v) =>
                            `                { version: "${v.version}", source: "./src/schema/${v.file}.ts" },`
                        ).join("\n");
                        return `        {\n            name: "${g.name}",\n            versions: [\n${versionsBody}\n            ],\n            targets: [${renderTargets(g.name).trimEnd()}\n            ]\n        }`;
                    }).join(",\n");
                    content = content.replace(/schemas:\s*\[\s*\{[\s\S]*?\}\s*\]/, `schemas: [\n${schemaEntries}\n    ]`);
                } else {
                    content = content.replace(/\/\/ TARGETS_PLACEHOLDER/, renderTargets("schema").trimEnd());
                }
                content = importsStr + "\n" + content.replace(/export default \{/, "export default defineConfig({").replace(/\};\s*$/, "});");
            }

            if (filePath.endsWith("package.json")) {
                try {
                    const pkg = JSON.parse(content);
                    if (pkg.name === pName || pkg.name === "example-schema-pop") {
                        if (pType === "monorepo" || pType === "all") pkg.workspaces = ["packages/schema", ...selectedHarnesses.map((h) => `packages/${h}`)];
                    }
                    if (pkg.name === `${pName}-schema` || pkg.name === "schema-pop-test") {
                        const version = process.env.LOCAL_TEST ? "workspace:*" : "latest";
                        pkg.devDependencies = pkg.devDependencies ?? {};
                        pkg.devDependencies["schema-pop"] = version;
                        if (pType === "all") {
                            pkg.devDependencies["@schema-pop/core-exporters"] = version;
                            pkg.devDependencies["@schema-pop/extra-exporters"] = version;
                        }
                    }
                    content = JSON.stringify(pkg, null, 4) + "\n";
                } catch { }
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

        if (selectedSchemas.length > 0 && existsSync(schemasDir)) {
            const schemaDestDir = (projectType === "monorepo" || projectType === "all") ? join(targetDir, "packages", "schema", "src", "schema") : join(targetDir, "src", "schema");
            mkdirSync(schemaDestDir, { recursive: true });
            for (const schemaName of selectedSchemas) {
                const schemaSrc = join(schemasDir, `${schemaName}.ts`);
                if (existsSync(schemaSrc)) copyFileSync(schemaSrc, join(schemaDestDir, `${schemaName}.ts`));
            }
        }

        s.stop("Project structure created!");
        if (isInteractive) {
            note(`${dim("cd")} ${cyan(projectName)}\n${dim("bun install")}\n${dim((projectType === "monorepo" || projectType === "all") ? "bun run build" : "bun run generate")}`, "Next steps");
            outro(`🎉 ${green(bold(projectName))} is ready!`);
        }
    } catch (err) {
        s.stop("Failed to initialize project");
        console.error(err);
        process.exit(1);
    }
}

main().catch(console.error);
