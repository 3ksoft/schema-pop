#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Engine,
	type Lang,
	fileToArktypeScope,
	loadExtras,
	pickEngine,
} from "./index";

const HELP = `schema-pop-import — import Rust / C / C++ source into an arktype scope.

Usage:
  schema-pop-import <input> -o <output.ts> [options]
  schema-pop-import <input> -o <output.ts> -- -I./inc -DFOO=1   # clang flags after \`--\`

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
  -o, --output <path>     Output .ts file (required)
  -l, --lang <lang>       Force language: rust | c | c++ | typescript (default: from extension)
  -e, --engine <engine>   Force engine: treesitter | clang (default: auto)
  -n, --scope <name>      Exported scope binding name (default: $)
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
			extras: { type: "string", short: "x", multiple: true },
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

	const input = positionals[0]!;
	const output = values.output as string | undefined;
	if (!output) {
		console.error("error: --output is required");
		process.exit(2);
	}

	const absInput = path.resolve(input);
	const absOutput = path.resolve(output);

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
			extras.push(await loadExtras(spec, { outFile: absOutput }));
		} catch (e) {
			console.error(`error: ${(e as Error).message}`);
			process.exit(2);
		}
	}

	const code = await fileToArktypeScope(absInput, {
		scopeName: (values.scope as string) ?? "$",
		engine,
		lang,
		clangBin: values.clang as string | undefined,
		extraClangArgs: extraArgs,
		extras,
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

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
