import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Lang, parseSource } from "./parser";
import { WalkResult } from "./toolkit";
import {
	walkCFile,
	walkCppFile,
	walkCSharpFile,
	walkDartFile,
	walkElixirFile,
	walkGoFile,
	walkJavaFile,
	walkKotlinFile,
	walkObjcFile,
	walkPhpFile,
	walkPythonFile,
	walkRustFile,
	walkScalaFile,
	walkSwiftFile,
	walkTsFile,
} from "./treesitter";

export type { Lang };
export { WalkResult };

interface LangConfig {
	extensions: string[];
	walker: (tree: any, sourcePath: string, opts?: any) => WalkResult;
	auto?: boolean;
}

const REGISTRY: Record<Lang, LangConfig> = {
	rust: { extensions: [".rs"], walker: walkRustFile, auto: true },
	c: { extensions: [".c", ".h"], walker: walkCFile, auto: true },
	cpp: {
		extensions: [".cpp", ".cc", ".hpp", ".cxx", ".hxx", ".hh"],
		walker: walkCppFile,
		auto: true,
	},
	typescript: { extensions: [".ts", ".tsx"], walker: walkTsFile, auto: true },
	php: { extensions: [".php"], walker: walkPhpFile, auto: true },
	java: { extensions: [".java"], walker: walkJavaFile, auto: true },
	python: { extensions: [".py"], walker: walkPythonFile, auto: true },
	go: { extensions: [".go"], walker: walkGoFile, auto: true },
	c_sharp: { extensions: [".cs"], walker: walkCSharpFile, auto: true },
	kotlin: { extensions: [".kt", ".kts"], walker: walkKotlinFile, auto: true },
	objc: { extensions: [".m", ".mm"], walker: walkObjcFile, auto: true },
	swift: { extensions: [".swift"], walker: walkSwiftFile, auto: true },
	dart: { extensions: [".dart"], walker: walkDartFile, auto: true },
	scala: { extensions: [".scala", ".sc"], walker: walkScalaFile, auto: true },
	elixir: { extensions: [".ex", ".exs"], walker: walkElixirFile, auto: true },
};

export function langFromPath(filePath: string): Lang | null {
	const ext = path.extname(filePath).toLowerCase();
	for (const [lang, cfg] of Object.entries(REGISTRY)) {
		if (cfg.auto && cfg.extensions.includes(ext)) return lang as Lang;
	}
	return null;
}

export interface ImportOptions {
	treeSitterWasmHook?: (name: string) => Promise<ArrayBuffer>;
	lang?: Lang;
	extraKnownNames?: readonly string[];
	sourcePath?: string;
}

export async function fromString(
	source: string,
	lang: Lang,
	opts?: ImportOptions,
): Promise<WalkResult> {
	const cfg = REGISTRY[lang];
	if (!cfg) throw new Error(`Unsupported language: ${lang}`);
	const tree = await parseSource(lang, source, opts?.treeSitterWasmHook);
	return cfg.walker(tree, opts?.sourcePath ?? "source", opts);
}

export async function fromFileName(
	filename: string,
	source: string,
	opts?: ImportOptions,
): Promise<WalkResult> {
	const lang = opts?.lang ?? langFromPath(filename);
	if (!lang) {
		throw new Error(
			`schema-pop importer: cannot infer language from ${filename}; pass an explicit lang`,
		);
	}
	return fromString(source, lang, { ...opts, sourcePath: filename });
}

export async function fromPath(
	filePath: string,
	opts?: ImportOptions,
): Promise<WalkResult> {
	const abs = path.resolve(filePath);
	const lang = opts?.lang ?? langFromPath(abs);
	if (!lang) {
		throw new Error(
			`schema-pop importer: cannot infer language from ${filePath}; pass an explicit lang`,
		);
	}
	const source = await fs.readFile(abs, "utf8");
	const rel = path.relative(process.cwd(), abs);
	return fromString(source, lang, { ...opts, sourcePath: rel });
}

export { fromPath as importFile, fromString as importSource, parseSource };
