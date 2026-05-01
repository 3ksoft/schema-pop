#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { rustFileToArktypeScope } from "./index";

const HELP = `schema-pop-import-rust — convert a Rust source file to arktype scope

Usage:
  schema-pop-import-rust <input.rs> -o <output.ts> [options]

Options:
  -o, --output <path>   Output .ts file (required)
  -n, --scope <name>    Exported scope binding name (default: $)
  -h, --help            Show this help

Notes:
  Only struct / enum / type-alias items are extracted. Generics, lifetimes,
  trait impls, and macro-generated types are silently skipped (with a list
  of skipped names appended to the output as a comment).
`;

async function main() {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			output: { type: "string", short: "o" },
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

	const code = await rustFileToArktypeScope(absInput, {
		scopeName: (values.scope as string) ?? "$",
	});
	await fs.mkdir(path.dirname(absOutput), { recursive: true });
	await fs.writeFile(absOutput, code);
	console.log(
		`✅ ${path.relative(process.cwd(), absInput)} → ${path.relative(process.cwd(), absOutput)}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
