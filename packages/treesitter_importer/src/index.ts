import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSource, type Lang } from "./parser";
import { walkRustFile } from "./walk-rust";
import { walkCFile } from "./walk-c";
import { walkCppFile } from "./walk-cpp";
import { emitArktypeScope, type EmitOptions } from "./emit";
import type { RustModuleIR } from "./ir";

export type { RustModuleIR, EmitOptions, Lang };
export type { ExtraScope } from "./emit";
export type {
	RustField,
	RustItem,
	RustEnumVariant,
	RustType,
	RustPrimitive,
} from "./ir";

export { parseRust, parseSource, getParser } from "./parser";
export { walkRustFile } from "./walk-rust";
export { walkCFile } from "./walk-c";
export { walkCppFile } from "./walk-cpp";
export { emitArktypeScope } from "./emit";

/**
 * Pick the language from a file extension. Returns `null` for unknown extensions.
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

/**
 * One-shot: read a source file, parse it with the matching grammar, return IR.
 */
export async function importFile(
	filePath: string,
	lang?: Lang,
): Promise<RustModuleIR> {
	const abs = path.resolve(filePath);
	const resolved = lang ?? langFromPath(abs);
	if (!resolved) {
		throw new Error(
			`schema-pop importer: cannot infer language from ${filePath}; pass an explicit lang`,
		);
	}
	const source = await fs.readFile(abs, "utf8");
	const tree = await parseSource(resolved, source);
	const rel = path.relative(process.cwd(), abs);
	if (resolved === "rust") return walkRustFile(tree, rel);
	if (resolved === "c") return walkCFile(tree, rel);
	return walkCppFile(tree, rel);
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
