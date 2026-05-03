import * as path from "node:path";
import {
	emitArktypeScope,
	type EmitOptions,
	type SchemaPopIR,
} from "@schema-pop/treesitter-importer";
import {
	type ClangLang,
	type ParseClangOptions,
	parseWithClang,
} from "./clang";
import { walkClangAst, type WalkOptions } from "./walk";

export type { ClangLang, ClangNode, ClangLoc } from "./clang";
export { resolveQualType, walkClangAst } from "./walk";
export type { WalkOptions };
export { parseWithClang };

export interface ImportOptions {
	lang?: ClangLang;
	clangBin?: string;
	extraArgs?: string[];
	walk?: WalkOptions;
	/** Called once with clang's stderr output. If clang emitted any
	 *  `error:` lines, the AST is likely missing types — the consumer
	 *  can surface these to the user (the CLI prints them as warnings). */
	onDiagnostics?: (stderr: string) => void;
}

/**
 * Pick the clang language flag from a file extension. Returns `null` for
 * unknown extensions.
 */
export function langFromPath(filePath: string): ClangLang | null {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".c" || ext === ".h") return "c";
	if (
		ext === ".cpp" ||
		ext === ".cxx" ||
		ext === ".cc" ||
		ext === ".hpp" ||
		ext === ".hxx" ||
		ext === ".hh"
	)
		return "c++";
	return null;
}

/**
 * One-shot: run clang on a file, walk the AST, return IR.
 */
export async function importFile(
	filePath: string,
	opts: ImportOptions = {},
): Promise<SchemaPopIR> {
	const abs = path.resolve(filePath);
	const lang = opts.lang ?? langFromPath(abs);
	if (!lang) {
		throw new Error(
			`schema-pop clang importer: cannot infer language from ${filePath}; pass an explicit lang ('c' or 'c++').`,
		);
	}
	const parseOpts: ParseClangOptions = {
		lang,
		clangBin: opts.clangBin,
		extraArgs: opts.extraArgs,
	};
	const { root, stderr } = await parseWithClang(abs, parseOpts);
	if (opts.onDiagnostics && stderr.trim()) opts.onDiagnostics(stderr);
	return walkClangAst(root, abs, opts.walk);
}

/**
 * One-shot: clang → IR → arktype scope source string.
 */
export async function fileToArktypeScope(
	filePath: string,
	opts: ImportOptions & EmitOptions = {},
): Promise<string> {
	const ir = await importFile(filePath, opts);
	return emitArktypeScope(ir, opts);
}
