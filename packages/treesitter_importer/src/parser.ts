import { Parser, Language, type Tree } from "web-tree-sitter";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let initialized = false;
let rustParser: Parser | null = null;

function defaultWasmPath(): string {
	// Resolve `wasm/tree-sitter-rust.wasm` relative to this module — works for
	// both src (bun) and dist (node) layouts because the file sits one level
	// up from `src/` or `dist/`.
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.resolve(here, "../wasm/tree-sitter-rust.wasm"),
		path.resolve(here, "../../wasm/tree-sitter-rust.wasm"),
	];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	throw new Error(
		`tree-sitter-rust.wasm not found (looked in: ${candidates.join(", ")})`,
	);
}

export async function getRustParser(wasmPath?: string): Promise<Parser> {
	if (rustParser) return rustParser;
	if (!initialized) {
		await Parser.init();
		initialized = true;
	}
	const lang = await Language.load(wasmPath ?? defaultWasmPath());
	if (!lang) throw new Error("Failed to load tree-sitter-rust language");
	const p = new Parser();
	p.setLanguage(lang);
	rustParser = p;
	return p;
}

export async function parseRust(source: string): Promise<Tree> {
	const p = await getRustParser();
	const tree = p.parse(source);
	if (!tree) throw new Error("tree-sitter parse returned null");
	return tree;
}
