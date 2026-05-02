import { spawn } from "node:child_process";

/**
 * Minimal subset of clang's `-ast-dump=json` JSON node shape that we care
 * about. The full schema is huge; we type only the fields we read.
 */
export interface ClangNode {
	id?: string;
	kind: string;
	name?: string;
	mangledName?: string;
	loc?: ClangLoc;
	range?: { begin?: ClangLoc; end?: ClangLoc };
	type?: { qualType?: string; desugaredQualType?: string };
	storageClass?: string;
	tagUsed?: "struct" | "union" | "class";
	completeDefinition?: boolean;
	scopedEnumTag?: "struct" | "class";
	fixedUnderlyingType?: { qualType?: string };
	isImplicit?: boolean;
	implicit?: boolean;
	isReferenced?: boolean;
	previousDecl?: string;
	value?: number | string;
	inner?: ClangNode[];
	[k: string]: unknown;
}

export interface ClangLoc {
	offset?: number;
	file?: string;
	line?: number;
	col?: number;
	tokLen?: number;
	includedFrom?: { file?: string; [k: string]: unknown };
	expansionLoc?: ClangLoc;
	spellingLoc?: ClangLoc;
	[k: string]: unknown;
}

export type ClangLang = "c" | "c++";

export interface ParseClangOptions {
	lang: ClangLang;
	/** Extra flags forwarded to clang (e.g., `-I`, `-D`, `-std=c11`). */
	extraArgs?: string[];
	/** Override clang executable. Defaults to `clang` on PATH. */
	clangBin?: string;
	/** Stderr capture limit (bytes). Default 64KB. */
	stderrLimit?: number;
}

export interface ParseClangResult {
	root: ClangNode;
	stderr: string;
}

/**
 * Spawn clang and capture its JSON AST. Returns the parsed root node.
 *
 * Throws if clang exits non-zero AND no JSON could be parsed. (Clang
 * routinely emits warnings to stderr while still producing a usable AST,
 * so partial errors are tolerated.)
 */
export async function parseWithClang(
	filePath: string,
	opts: ParseClangOptions,
): Promise<ParseClangResult> {
	const bin = opts.clangBin ?? "clang";
	const args = [
		"-Xclang",
		"-ast-dump=json",
		"-fsyntax-only",
		"-fparse-all-comments",
		"-x",
		opts.lang,
		...(opts.extraArgs ?? []),
		filePath,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const stderrLimit = opts.stderrLimit ?? 64 * 1024;
		let stderrSize = 0;

		proc.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
		proc.stderr.on("data", (b: Buffer) => {
			if (stderrSize < stderrLimit) {
				stderrChunks.push(b);
				stderrSize += b.length;
			}
		});
		proc.on("error", (err) => reject(err));
		proc.on("close", (code) => {
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			if (!stdout) {
				reject(
					new Error(
						`clang produced no output (exit ${code}).\n${stderr}`,
					),
				);
				return;
			}
			let root: ClangNode;
			try {
				root = JSON.parse(stdout) as ClangNode;
			} catch (e) {
				reject(
					new Error(
						`failed to parse clang JSON (exit ${code}): ${(e as Error).message}\n${stderr.slice(0, 1024)}`,
					),
				);
				return;
			}
			resolve({ root, stderr });
		});
	});
}

/**
 * Walk a location chain and return the first concrete `file` we find — or
 * `null` if none is set. Used to determine if a decl came from the input
 * file vs an `#include`d header.
 */
export function locFile(loc: ClangLoc | undefined): string | null {
	if (!loc) return null;
	if (loc.includedFrom?.file) return loc.includedFrom.file;
	if (loc.file) return loc.file;
	if (loc.expansionLoc) return locFile(loc.expansionLoc);
	if (loc.spellingLoc) return locFile(loc.spellingLoc);
	return null;
}

/**
 * True if a decl came from a system / included header (anything outside
 * the input file we passed to clang).
 */
export function isFromInclude(node: ClangNode): boolean {
	const r = node.range?.begin;
	const l = node.loc;
	return Boolean(r?.includedFrom || l?.includedFrom);
}

export function isImplicit(node: ClangNode): boolean {
	return node.isImplicit === true || node.implicit === true;
}
