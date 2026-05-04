#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileToArktypeScope, langFromPath, type Lang } from "./index";

const HELP = `schema-pop-import — convert a Rust / C / C++ source file to arktype scope

Usage:
  schema-pop-import <input> -o <output.ts> [options]

Options:
  -o, --output <path>   Output .ts file (required)
  -l, --lang <lang>     Force language: rust | c | cpp | typescript | php | java | python | go | c_sharp | kotlin | objc | swift | dart | scala | elixir (default: infer from
                        extension — .rs / .c .h / .cpp .hpp .cc .hxx / .ts / .php / .java / .py / .go / .cs / .kt / .m / .swift / .dart / .scala / .ex)
  -n, --scope <name>    Exported scope binding name (default: $)
  -h, --help            Show this help

Notes:
  Only struct / enum / type-alias items are extracted. Generics, lifetimes,
  trait impls, templates, macros, function pointers, and bitfields are
  silently skipped (with a list appended as a comment block to the output).
`;

async function main() {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			output: { type: "string", short: "o" },
			lang: { type: "string", short: "l" },
			scope: { type: "string", short: "n" },
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
	const lang = (values.lang as Lang | undefined) ?? langFromPath(absInput);
	if (!lang) {
		console.error(
			`error: cannot infer language from "${input}"; pass --lang rust|c|cpp|typescript|php|java|python|go|c_sharp|kotlin|objc|swift|dart|scala|elixir`,
		);
		process.exit(2);
	}

	const code = await fileToArktypeScope(absInput, {
		scopeName: (values.scope as string) ?? "$",
		lang,
	});
	await fs.mkdir(path.dirname(absOutput), { recursive: true });
	await fs.writeFile(absOutput, code);
	console.log(
		`✅ ${path.relative(process.cwd(), absInput)} → ${path.relative(process.cwd(), absOutput)} (${lang})`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
