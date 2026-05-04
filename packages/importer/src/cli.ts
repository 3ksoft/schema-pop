#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import { fstatSync } from "node:fs";
import * as path from "node:path";

// Bun.Glob is provided by the bun runtime (this CLI runs only under
// bun via the shebang). Declared inline so we don't pull @types/bun
// into the importer package's devDeps just for one symbol.
declare const Bun: {
	Glob: new (
		pattern: string,
	) => {
		scan(opts: { cwd: string; onlyFiles?: boolean }): AsyncIterable<string>;
	};
};
import { writeLayoutPlan, LAYOUT_JSON_SCHEMA_VERSION } from "schema-pop/node";
import {
	type Engine,
	type Lang,
	fileToArktypeScope,
	fileToLayoutPlan,
	loadExtras,
	pickEngine,
} from "./index";

const HELP = `schema-pop-import — import Rust / C / C++ source into an arktype scope.

Usage:
  schema-pop-import <input> -o <output.ts> [options]                      # single file
  schema-pop-import 'src/**/*.{h,hpp}' -o out/ [options]                   # glob → directory
  schema-pop-import a.h b.h c.h -o out/ [options]                          # multi-arg → directory
  schema-pop-import <input> -o <output.ts> -- -I./inc -DFOO=1              # clang flags after \`--\`
  schema-pop-import 'src/**/*.h' | schema-pop emit -t md -o docs/          # pipe to schema-pop

Pipe mode (omit -o or pass -o -):
  When stdout is a pipe, outputs LayoutPlan JSON instead of writing files.
  Single input  → one JSON object  (same envelope as .layout.json on disk).
  Multiple inputs → JSON array of envelopes, consumed by \`schema-pop emit\`.
  Progress and errors are written to stderr so they don't corrupt the stream.

Engines:
  Rust         → tree-sitter (bundled wasm grammar, zero runtime deps)
  C / C++      → system clang (better — resolves #include, macros, attributes)
                 Tree-sitter is available as a fallback via \`-e treesitter\`.
  TypeScript   → tree-sitter (interfaces / type aliases / enums, hand-written
                 \`.ts\` only — NOT for re-importing existing arktype scopes).
                 Pass \`-l typescript\` explicitly; \`.ts\` extension is not
                 auto-detected because most \`.ts\` files in a schema-pop
                 project are already arktype scopes.

Options:
  -o, --output <path>     Output path. A single \`.ts\` file when one input
                          resolves; a DIRECTORY when the input is a glob,
                          multiple positionals are passed, or the path
                          ends with \`/\`. In directory mode each input
                          \`<name>.<ext>\` becomes \`<outDir>/<name>.ts\`.
  -l, --lang <lang>       Force language (default: from extension).
						  Supported for treesitter:
						  c, cpp, c-sharp, dart, elixir, go, java, 
						  kotlin, kotlin, objc, php, python, rust, 
						  scala, swift, typescript						  
  -e, --engine <engine>   Force engine: treesitter | clang (default: auto)
  -n, --scope <name>      Exported scope binding name (default: $)
  -t, --type <kind>       Filter the emitted IR: \`types\` (drop function
                          declarations) | \`functions\` (drop data shapes) |
                          \`all\` (default). Handy for headers that are mostly
                          function-pointer vtables when you only want the
                          struct surface.
  -x, --extras <spec>     Extra arktype scope to splice in. Repeatable. Spec
                          form: \`<path>[#exportName]\` — defaults to first
                          arktype scope export found in the file. Aliases
                          declared there resolve as refs (no \`unknown\`
                          downgrade) and the file is imported in the output.
                          Use this for custom \`Bit<u32, 9>\` / \`Binary<...>\`
                          types not in the schema-pop standard scopes.
      --clang <path>      Path to clang executable (default: \`clang\` on PATH)
      --no-auto-stdint    Disable auto -include stdint.h (clang engine only)
  -h, --help              Show this help

Anything after \`--\` is forwarded verbatim to clang (\`-I\`, \`-D\`, \`-std=...\`).

Notes:
  * Rust + C(++) use the same IR + emitter, so output shape is identical.
  * Pointers, function pointers, multidim arrays, unions, templates fall
    through as either skipped (with reason) or emitted as \`unknown\` with
    the original type preserved in a comment.
`;

async function main() {
	const argv = process.argv.slice(2);
	const sep = argv.indexOf("--");
	const ownArgs = sep >= 0 ? argv.slice(0, sep) : argv;
	const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

	const { values, positionals } = parseArgs({
		args: ownArgs,
		options: {
			output: { type: "string", short: "o" },
			lang: { type: "string", short: "l" },
			engine: { type: "string", short: "e" },
			scope: { type: "string", short: "n" },
			type: { type: "string", short: "t" },
			extras: { type: "string", short: "x", multiple: true },
			format: { type: "string" },
			clang: { type: "string" },
			"no-auto-stdint": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: false,
		allowPositionals: true,
	});

	if (values.help || positionals.length === 0) {
		process.stdout.write(HELP);
		process.exit(values.help ? 0 : 1);
	}

	const output = values.output as string | undefined;
	// fstatSync(1) checks the actual stdout file descriptor — more reliable
	// than process.stdout.isTTY which Bun leaves undefined in all cases.
	const isStdoutPipe = (() => {
		try {
			return fstatSync(1).isFIFO();
		} catch {
			return false;
		}
	})();
	const isPipeMode = output === "-" || (!output && isStdoutPipe);

	if (!isPipeMode && !output) {
		console.error("error: --output is required");
		process.exit(2);
	}

	// Expand positionals: each entry is either a literal file or a glob
	// pattern (presence of `*` / `?` / `[` / `{` triggers Bun.Glob expand).
	const inputs: string[] = [];
	for (const p of positionals) {
		const expanded = await expandGlob(p);
		if (expanded.length === 0) {
			console.error(`error: no files matched "${p}"`);
			process.exit(2);
		}
		inputs.push(...expanded);
	}

	// Pipe mode: stream LayoutPlan JSON to stdout, progress to stderr.
	if (isPipeMode) {
		if (inputs.length === 1) {
			const plan = await runOnePlan(inputs[0]!, values, passthrough);
			process.stdout.write(
				JSON.stringify(
					{ $schemaVersion: LAYOUT_JSON_SCHEMA_VERSION, plan },
					null,
					2,
				) + "\n",
			);
		} else {
			const envelopes: { $schemaVersion: string; plan: unknown }[] = [];
			for (const inp of inputs) {
				try {
					const plan = await runOnePlan(inp, values, passthrough);
					envelopes.push({ $schemaVersion: LAYOUT_JSON_SCHEMA_VERSION, plan });
				} catch (e) {
					console.error(`❌ ${inp}: ${(e as Error).message}`);
				}
			}
			process.stdout.write(JSON.stringify(envelopes, null, 2) + "\n");
		}
		return;
	}

	// Normal mode: write to output path.
	const absOutput = path.resolve(output!);

	// Output is a directory when explicitly slash-suffixed, when it
	// already exists as a dir, or when the input fan-out is > 1.
	const outputLooksLikeDir =
		output!.endsWith("/") ||
		output!.endsWith(path.sep) ||
		(await isExistingDir(absOutput));
	const isDirMode = inputs.length > 1 || outputLooksLikeDir;

	if (!isDirMode && inputs.length === 1) {
		await runOne(inputs[0]!, absOutput, values, passthrough);
		return;
	}

	await fs.mkdir(absOutput, { recursive: true });
	// Keep the source extension as part of the output basename so a
	// `foo.cpp` and a `foo.h` in the same batch don't both write to
	// `foo.ts` (the second one would silently overwrite the first).
	// Result: `foo.cpp.layout.json` / `foo.h.layout.json` — verbose, but unambiguous.
	// Batch mode defaults to `.layout.json` (the cheap path that bypasses
	// emit.ts roundtrip); pass `--format ts` to opt into legacy arktype source.
	const format =
		(values.format as string | undefined) === "ts" ? "ts" : "layout.json";
	for (const inp of inputs) {
		const absInp = path.resolve(inp);
		const base = path.basename(absInp);
		const dest = path.join(absOutput, `${base}.${format}`);
		try {
			await runOne(inp, dest, values, passthrough);
		} catch (e) {
			console.error(`❌ ${inp}: ${(e as Error).message}`);
		}
	}
}

async function buildImportArgs(
	absInput: string,
	values: Record<string, unknown>,
	passthrough: string[],
	outFileForExtras: string,
) {
	const langOverride = values.lang as Lang | undefined;
	const engineOverride = values.engine as Engine | undefined;
	if (
		langOverride &&
		!["rust", "c", "c++", "typescript"].includes(langOverride)
	) {
		console.error(
			`error: invalid --lang "${langOverride}" (expected: rust | c | c++ | typescript)`,
		);
		process.exit(2);
	}
	if (engineOverride && !["treesitter", "clang"].includes(engineOverride)) {
		console.error(
			`error: invalid --engine "${engineOverride}" (expected: treesitter | clang)`,
		);
		process.exit(2);
	}

	const filterRaw = values.type as string | undefined;
	if (filterRaw && !["all", "types", "functions"].includes(filterRaw)) {
		console.error(
			`error: invalid --type "${filterRaw}" (expected: all | types | functions)`,
		);
		process.exit(2);
	}
	const filter = (filterRaw ?? "all") as "all" | "types" | "functions";

	let engine: Engine;
	let lang: Lang;
	try {
		({ engine, lang } = pickEngine(absInput, {
			engine: engineOverride,
			lang: langOverride,
		}));
	} catch (e) {
		console.error(`error: ${(e as Error).message}`);
		process.exit(2);
	}

	const extraArgs = await maybeInjectStdint(
		absInput,
		passthrough,
		engine === "clang" && !values["no-auto-stdint"],
	);

	const extrasSpecs = (values.extras as string[] | undefined) ?? [];
	const extras = [];
	for (const spec of extrasSpecs) {
		try {
			extras.push(await loadExtras(spec, { outFile: outFileForExtras }));
		} catch (e) {
			console.error(`error: ${(e as Error).message}`);
			process.exit(2);
		}
	}

	return { engine, lang, extraArgs, extras, filter };
}

async function runOnePlan(
	input: string,
	values: Record<string, unknown>,
	passthrough: string[],
) {
	const absInput = path.resolve(input);
	const { engine, lang, extraArgs, extras, filter } = await buildImportArgs(
		absInput,
		values,
		passthrough,
		absInput,
	);
	const plan = await fileToLayoutPlan(absInput, {
		engine,
		lang,
		clangBin: values.clang as string | undefined,
		extraClangArgs: extraArgs,
		extras,
		filter,
	});
	console.error(
		`✅ ${path.relative(process.cwd(), absInput)} (${lang}, ${engine}, layout-json)`,
	);
	return plan;
}

async function runOne(
	input: string,
	absOutput: string,
	values: Record<string, unknown>,
	passthrough: string[],
): Promise<void> {
	const absInput = path.resolve(input);

	const { engine, lang, extraArgs, extras, filter } = await buildImportArgs(
		absInput,
		values,
		passthrough,
		absOutput,
	);

	// Output extension picks the format:
	//   .layout.json — direct LayoutPlan, no arktype round-trip (preferred)
	//   .ts          — legacy arktype scope source (kept for hand-edit workflows)
	if (absOutput.endsWith(".layout.json")) {
		const plan = await fileToLayoutPlan(absInput, {
			engine,
			lang,
			clangBin: values.clang as string | undefined,
			extraClangArgs: extraArgs,
			extras,
			filter,
		});
		await writeLayoutPlan(plan, absOutput);
		console.log(
			`✅ ${path.relative(process.cwd(), absInput)} → ${path.relative(process.cwd(), absOutput)} (${lang}, ${engine}, layout-json)`,
		);
		return;
	}

	const code = await fileToArktypeScope(absInput, {
		scopeName: (values.scope as string) ?? "$",
		engine,
		lang,
		clangBin: values.clang as string | undefined,
		extraClangArgs: extraArgs,
		extras,
		filter,
	});

	await fs.mkdir(path.dirname(absOutput), { recursive: true });
	await fs.writeFile(absOutput, code);
	console.log(
		`✅ ${path.relative(process.cwd(), absInput)} → ${path.relative(process.cwd(), absOutput)} (${lang}, ${engine})`,
	);
}

/**
 * Pre-scan source for `uint8_t`/etc. without an explicit `#include
 * <stdint.h>` and prepend `-include stdint.h` when found. Same heuristic
 * as the standalone clang_importer CLI — copied here so the unified
 * binary stays self-contained.
 */
async function maybeInjectStdint(
	inputPath: string,
	passthrough: string[],
	enabled: boolean,
): Promise<string[]> {
	if (!enabled) return passthrough;
	if (passthrough.some((a) => a === "-include" || a.startsWith("-include="))) {
		return passthrough;
	}
	let src: string;
	try {
		src = await fs.readFile(inputPath, "utf8");
	} catch {
		return passthrough;
	}
	const usesStdint = /\b(?:u?int(?:8|16|32|64)_t)\b/.test(src);
	if (!usesStdint) return passthrough;
	const hasInclude = /#\s*include\s*[<"](?:stdint|cstdint)\.?h?[>"]/.test(src);
	if (hasInclude) return passthrough;
	return ["-include", "stdint.h", ...passthrough];
}

/**
 * Expand a positional argument as either a literal file path or a glob.
 * Anything containing `*`, `?`, `[`, or `{` is treated as a glob and
 * scanned via `Bun.Glob`. Literal paths are returned as a single-element
 * array. Sorted output so multi-file runs are deterministic.
 */
async function expandGlob(pattern: string): Promise<string[]> {
	if (!/[*?[\]{}]/.test(pattern)) return [pattern];
	const out: string[] = [];
	const g = new Bun.Glob(pattern);
	for await (const f of g.scan({ cwd: process.cwd(), onlyFiles: true })) {
		out.push(f);
	}
	return out.sort();
}

async function isExistingDir(p: string): Promise<boolean> {
	try {
		const st = await fs.stat(p);
		return st.isDirectory();
	} catch {
		return false;
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
