#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type ClangLang,
	fileToArktypeScope,
	langFromPath,
} from "./index";

const HELP = `schema-pop-clang-import — convert a C / C++ header to an arktype scope via the system clang.

Usage:
  schema-pop-clang-import <input.h> -o <output.ts> [options]
  schema-pop-clang-import <input.h> -o <output.ts> -- -I./inc -DFOO=1

Options:
  -o, --output <path>     Output .ts file (required)
  -l, --lang <lang>       Force language: c | c++ (default: infer from extension)
  -n, --scope <name>      Exported scope binding name (default: $)
      --clang <path>      Path to clang executable (default: \`clang\` on PATH)
      --no-file-filter    Walk every decl in the AST, including system headers.
                          Useful for debugging; produces huge output.
      --no-lp64           Treat \`int\`/\`long\` as platform-ambiguous (default: LP64).
      --no-auto-stdint    Disable auto-injection of \`-include stdint.h\` when the
                          source uses \`uint8_t\`/etc. without an explicit include.
  -h, --help              Show this help

Anything after \`--\` is forwarded to clang as extra flags (\`-I\`, \`-D\`,
\`-std=...\`, etc.). Without \`--\`, those flags are forwarded as well, but
\`--\` is the safe form when flags conflict with the importer's own.

Notes:
  Templates, function pointers, bitfields, and unions are skipped (with
  a list appended as a comment block to the output). Pointers in struct
  fields fall through as \`unsupported\` because schema-pop's binary
  layout has no native concept of pointer indirection.
`;

async function main() {
	const argv = process.argv.slice(2);
	// Manually split off flags after `--` and forward to clang verbatim.
	const sep = argv.indexOf("--");
	const ownArgs = sep >= 0 ? argv.slice(0, sep) : argv;
	const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

	const { values, positionals } = parseArgs({
		args: ownArgs,
		options: {
			output: { type: "string", short: "o" },
			lang: { type: "string", short: "l" },
			scope: { type: "string", short: "n" },
			clang: { type: "string" },
			"no-file-filter": { type: "boolean" },
			"no-lp64": { type: "boolean" },
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
	const lang =
		(values.lang as ClangLang | undefined) ?? langFromPath(absInput);
	if (!lang) {
		console.error(
			`error: cannot infer language from "${input}"; pass --lang c|c++`,
		);
		process.exit(2);
	}

	const autoStdint = !values["no-auto-stdint"];
	const extraArgs = await maybeInjectStdint(absInput, passthrough, autoStdint);

	const code = await fileToArktypeScope(absInput, {
		scopeName: (values.scope as string) ?? "$",
		lang,
		clangBin: values.clang as string | undefined,
		extraArgs,
		walk: {
			noFileFilter: Boolean(values["no-file-filter"]),
			lp64: !values["no-lp64"],
		},
		onDiagnostics: (stderr) => {
			// Surface only error-level lines — warnings are noisy on big
			// headers and rarely actionable for the importer.
			const errors = stderr
				.split("\n")
				.filter((l) => /\berror:/.test(l))
				.slice(0, 8);
			if (errors.length === 0) return;
			console.warn(
				"\n⚠️  clang reported errors — generated output is likely incomplete:",
			);
			for (const e of errors) console.warn("    " + e.trim());
			if (/unknown type name/.test(stderr)) {
				console.warn(
					"\n    hint: pass `-- -include stdint.h` (or `-I<dir>`) so clang can find missing types.",
				);
			}
		},
	});
	await fs.mkdir(path.dirname(absOutput), { recursive: true });
	await fs.writeFile(absOutput, code);
	console.log(
		`✅ ${path.relative(process.cwd(), absInput)} → ${path.relative(process.cwd(), absOutput)} (${lang})`,
	);
}

/**
 * Old C headers commonly use `uint32_t` / `int8_t` / etc. without an
 * explicit `#include <stdint.h>` (the build system used to handle it
 * via prefix-headers or compiler defaults). Clang then errors out with
 * `unknown type name 'uint32_t'` and falls back to `int`, which the
 * importer mis-types as `i32`. We auto-inject `-include stdint.h` when
 * we detect this pattern; user can opt out with `--no-auto-stdint`.
 */
async function maybeInjectStdint(
	inputPath: string,
	passthrough: string[],
	enabled: boolean,
): Promise<string[]> {
	if (!enabled) return passthrough;
	// User already passed `-include` explicitly — don't double up.
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
