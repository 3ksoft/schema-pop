import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSource, type Lang } from "./parser";
import { walkRustFile } from "./walk-rust";
import { walkCFile } from "./walk-c";
import { walkCppFile } from "./walk-cpp";
import { walkTsFile } from "./walk-ts";
import { emitArktypeScope, type EmitOptions } from "./emit";
import type { SchemaPopIR } from "schema-pop";

// Re-export IR shape from core so external consumers that import IR
// types via `@schema-pop/treesitter-importer` keep working without
// touching their imports. New code should import from `schema-pop`
// directly — this surface is a thin shim.
export type { SchemaPopIR, EmitOptions, Lang };
export type { ExtraScope } from "./emit";
export type {
	IRField,
	IRItem,
	IREnumVariant,
	IRType,
	IRPrimitive,
} from "schema-pop";

export { parseRust, parseSource, getParser } from "./parser";
export { walkRustFile } from "./walk-rust";
export { walkCFile } from "./walk-c";
export { walkCppFile } from "./walk-cpp";
export { walkTsFile } from "./walk-ts";
export { emitArktypeScope } from "./emit";
export { downgradeUnknownRefs, SCHEMA_POP_KNOWN_NAMES } from "./known-names";

/**
 * Pick the language from a file extension. Returns `null` for unknown extensions.
 *
 * `.ts` / `.tsx` are NOT auto-mapped to typescript: most `.ts` files in a
 * schema-pop project are already arktype scopes, and silently treating
 * them as importable interfaces would surprise the user. Pass
 * `--lang typescript` (or `lang: "typescript"` to `importFile`)
 * explicitly when you do want TS interface ingestion.
 */
export function langFromPath(filePath: string): Lang | null {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".rs") return "rust";
	if (ext === ".c" || ext === ".h") return "c";
	if (
		ext === ".cpp" ||
		ext === ".cxx" ||
		ext === ".cc" ||
		ext === ".hpp" ||
		ext === ".hxx" ||
		ext === ".hh"
	)
		return "cpp";
	return null;
}

export interface ImportFileOptions {
	lang?: Lang;
	/** Extra type names that should resolve as `ref` (not get downgraded
	 *  to `unknown`). Used by the unified importer to forward the user's
	 *  `--extras` scope keys into every backend. */
	extraKnownNames?: readonly string[];
}

/**
 * One-shot: read a source file, parse it with the matching grammar, return IR.
 */
export async function importFile(
	filePath: string,
	langOrOpts?: Lang | ImportFileOptions,
): Promise<SchemaPopIR> {
	const abs = path.resolve(filePath);
	const opts: ImportFileOptions =
		typeof langOrOpts === "string"
			? { lang: langOrOpts }
			: (langOrOpts ?? {});
	const resolved = opts.lang ?? langFromPath(abs);
	if (!resolved) {
		throw new Error(
			`schema-pop importer: cannot infer language from ${filePath}; pass an explicit lang`,
		);
	}
	const source = await fs.readFile(abs, "utf8");
	const tree = await parseSource(resolved, source);
	const rel = path.relative(process.cwd(), abs);
	const walkOpts = { extraKnownNames: opts.extraKnownNames };
	if (resolved === "rust") return walkRustFile(tree, rel, walkOpts);
	if (resolved === "c") return walkCFile(tree, rel, walkOpts);
	if (resolved === "cpp") return walkCppFile(tree, rel, walkOpts);
	return walkTsFile(tree, rel, walkOpts);
}

/**
 * One-shot: read source, walk, emit arktype scope source. Returns the
 * rendered string — caller writes it where they want.
 */
export async function fileToArktypeScope(
	filePath: string,
	opts?: EmitOptions & { lang?: Lang },
): Promise<string> {
	const ir = await importFile(filePath, opts?.lang);
	return emitArktypeScope(ir, opts);
}

/** @deprecated Use `importFile`. */
export const importRustFile = (filePath: string) => importFile(filePath, "rust");
/** @deprecated Use `fileToArktypeScope`. */
export const rustFileToArktypeScope = (filePath: string, opts?: EmitOptions) =>
	fileToArktypeScope(filePath, { ...opts, lang: "rust" });
