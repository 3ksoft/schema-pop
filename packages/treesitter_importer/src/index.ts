import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSource, type Lang } from "./parser";
import { walkRustFile } from "./walk-rust";
import { walkCFile } from "./walk-c";
import { walkCppFile } from "./walk-cpp";
import { walkTsFile } from "./walk-ts";
import { walkPhpFile } from "./walk-php";
import { walkJavaFile } from "./walk-java";
import { walkPythonFile } from "./walk-python";
import { walkGoFile } from "./walk-go";
import { walkCSharpFile } from "./walk-csharp";
import { walkKotlinFile } from "./walk-kotlin";
import { walkObjcFile } from "./walk-objc";
import { walkSwiftFile } from "./walk-swift";
import { walkDartFile } from "./walk-dart";
import { walkScalaFile } from "./walk-scala";
import { walkElixirFile } from "./walk-elixir";
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
export { walkPhpFile } from "./walk-php";
export { walkJavaFile } from "./walk-java";
export { walkPythonFile } from "./walk-python";
export { walkGoFile } from "./walk-go";
export { walkCSharpFile } from "./walk-csharp";
export { walkKotlinFile } from "./walk-kotlin";
export { walkObjcFile } from "./walk-objc";
export { walkSwiftFile } from "./walk-swift";
export { walkDartFile } from "./walk-dart";
export { walkScalaFile } from "./walk-scala";
export { walkElixirFile } from "./walk-elixir";
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
	if (ext === ".php") return "php";
	if (ext === ".java") return "java";
	if (ext === ".py") return "python";
	if (ext === ".go") return "go";
	if (ext === ".cs") return "c_sharp";
	if (ext === ".kt" || ext === ".kts") return "kotlin";
	if (ext === ".m" || ext === ".mm") return "objc";
	if (ext === ".swift") return "swift";
	if (ext === ".dart") return "dart";
	if (ext === ".scala" || ext === ".sc") return "scala";
	if (ext === ".ex" || ext === ".exs") return "elixir";
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
		typeof langOrOpts === "string" ? { lang: langOrOpts } : (langOrOpts ?? {});
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
	if (resolved === "php") return walkPhpFile(tree, rel, walkOpts);
	if (resolved === "java") return walkJavaFile(tree, rel, walkOpts);
	if (resolved === "python") return walkPythonFile(tree, rel, walkOpts);
	if (resolved === "go") return walkGoFile(tree, rel, walkOpts);
	if (resolved === "c_sharp") return walkCSharpFile(tree, rel, walkOpts);
	if (resolved === "kotlin") return walkKotlinFile(tree, rel, walkOpts);
	if (resolved === "objc") return walkObjcFile(tree, rel, walkOpts);
	if (resolved === "swift") return walkSwiftFile(tree, rel, walkOpts);
	if (resolved === "dart") return walkDartFile(tree, rel, walkOpts);
	if (resolved === "scala") return walkScalaFile(tree, rel, walkOpts);
	if (resolved === "elixir") return walkElixirFile(tree, rel, walkOpts);
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
export const importRustFile = (filePath: string) =>
	importFile(filePath, "rust");
/** @deprecated Use `fileToArktypeScope`. */
export const rustFileToArktypeScope = (filePath: string, opts?: EmitOptions) =>
	fileToArktypeScope(filePath, { ...opts, lang: "rust" });
