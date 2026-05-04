import { Parser, Language, type Tree } from "web-tree-sitter";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type Lang = "rust" | "c" | "cpp" | "typescript" | "php" | "java" | "python" | "go" | "c_sharp" | "kotlin" | "objc" | "swift" | "dart" | "scala" | "elixir";

let initialized = false;
const parsers = new Map<Lang, Parser>();

function defaultWasmPath(lang: Lang): string {
	const file = `tree-sitter-${lang}.wasm`;
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.resolve(here, "../wasm", file),
		path.resolve(here, "../../wasm", file),
	];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	throw new Error(
		`${file} not found (looked in: ${candidates.join(", ")})`,
	);
}

export async function getParser(
	lang: Lang,
	wasmPath?: string,
): Promise<Parser> {
	const cached = parsers.get(lang);
	if (cached) return cached;
	if (!initialized) {
		await Parser.init();
		initialized = true;
	}
	const language = await Language.load(wasmPath ?? defaultWasmPath(lang));
	if (!language) throw new Error(`Failed to load tree-sitter-${lang} language`);
	const p = new Parser();
	p.setLanguage(language);
	parsers.set(lang, p);
	return p;
}

export async function parseSource(lang: Lang, source: string): Promise<Tree> {
	const p = await getParser(lang);
	const tree = p.parse(source);
	if (!tree) throw new Error(`tree-sitter parse returned null (${lang})`);
	return tree;
}

// Back-compat wrappers used by the original Rust importer code.
export const getRustParser = (wasmPath?: string) => getParser("rust", wasmPath);
export const parseRust = (source: string) => parseSource("rust", source);
