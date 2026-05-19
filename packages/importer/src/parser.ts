/// <reference types="node" />

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

export type Lang =
	| "rust"
	| "c"
	| "cpp"
	| "typescript"
	| "php"
	| "java"
	| "python"
	| "go"
	| "c_sharp"
	| "kotlin"
	| "objc"
	| "swift"
	| "dart"
	| "scala"
	| "elixir";

let initialized = false;
const parsers = new Map<Lang, Parser>();

function getWasmPath(lang: Lang): string {
	const file = `tree-sitter-${lang}.wasm`;
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.resolve(here, "../wasm", file),
		path.resolve(here, "../../wasm", file),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	throw new Error(`${file} not found. Searched in: ${candidates.join(", ")}`);
}

export async function getParser(
	lang: Lang,
	hook?: (name: string) => Promise<ArrayBuffer>,
): Promise<Parser> {
	const cached = parsers.get(lang);
	if (cached) return cached;

	if (!initialized) {
		const initOpts: any = {};
		if (hook) {
			try {
				const wasmBinary = await hook("tree-sitter.wasm");
				initOpts.wasmBinary = wasmBinary;
			} catch (e) {
				// Fallback to default loading if hook doesn't provide it
			}
		}
		await Parser.init(initOpts);
		initialized = true;
	}

	let langData: string | Uint8Array;
	if (hook) {
		const buffer = await hook(`tree-sitter-${lang}.wasm`);
		langData = new Uint8Array(buffer);
	} else {
		langData = getWasmPath(lang);
	}

	const language = await Language.load(langData);
	const p = new Parser();
	p.setLanguage(language);
	parsers.set(lang, p);
	return p;
}

export async function parseSource(
	lang: Lang,
	source: string,
	hook?: (name: string) => Promise<ArrayBuffer>,
): Promise<Tree> {
	const p = await getParser(lang, hook);
	const tree = p.parse(source);
	if (!tree) throw new Error(`tree-sitter parse returned null (${lang})`);
	return tree;
}
