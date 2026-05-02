import * as path from "node:path";
import { createJiti } from "jiti";
import {
	emitArktypeScope,
	type EmitOptions,
	type ExtraScope,
	type RustModuleIR,
} from "@schema-pop/treesitter-importer";
import {
	importFile as treesitterImport,
	langFromPath as treesitterLangFromPath,
} from "@schema-pop/treesitter-importer";
import {
	importFile as clangImport,
	langFromPath as clangLangFromPath,
	type ClangLang,
} from "@schema-pop/clang-importer";

export type Engine = "treesitter" | "clang";
export type Lang = "rust" | "c" | "c++";
export type { ExtraScope };

/**
 * Pick a sensible default engine + language given the input file. Rust
 * always goes through tree-sitter (no clang Rust frontend in the wild).
 * C / C++ default to clang when available, since clang resolves
 * includes / macros / `#define` constants whereas the tree-sitter walker
 * is purely syntactic.
 */
export function pickEngine(
	filePath: string,
	overrides: { engine?: Engine; lang?: Lang } = {},
): { engine: Engine; lang: Lang } {
	const tsLang = treesitterLangFromPath(filePath);
	const clLang = clangLangFromPath(filePath);
	const lang =
		overrides.lang ??
		(tsLang === "rust"
			? "rust"
			: tsLang === "cpp" || clLang === "c++"
				? "c++"
				: tsLang === "c" || clLang === "c"
					? "c"
					: null);
	if (!lang) {
		throw new Error(
			`schema-pop importer: cannot infer language from "${filePath}"; pass --lang rust|c|c++`,
		);
	}
	if (overrides.engine) return { engine: overrides.engine, lang };
	const engine: Engine = lang === "rust" ? "treesitter" : "clang";
	return { engine, lang };
}

export interface ImportOptions {
	engine?: Engine;
	lang?: Lang;
	clangBin?: string;
	extraClangArgs?: string[];
	/**
	 * User-provided extras spliced into the generated scope. Each entry
	 * declares an import path + scope export name; the resolved alias
	 * keys come from `loadExtras()` (or the user can fill them in by
	 * hand). Treated by the walker as additional known names so refs
	 * like `u9` / `fp16` aren't downgraded to `unknown`.
	 */
	extras?: ExtraScope[];
}

/**
 * Parse a `<path>[#exportName]` spec, dynamically import the file, find
 * the arktype Scope export (either named or via duck-typing), and
 * return its keys + the resolved import metadata for the emitter.
 *
 * Used by the unified CLI to turn `--extras path/to/extras.ts#myExtras`
 * into a fully-populated `ExtraScope` entry.
 */
export async function loadExtras(
	spec: string,
	opts: { fromDir?: string; outFile?: string } = {},
): Promise<ExtraScope> {
	const fromDir = opts.fromDir ?? process.cwd();
	const [pathPart, exportName] = spec.split("#");
	const abs = path.resolve(fromDir, pathPart!);

	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const mod = (await jiti.import(abs)) as Record<string, unknown>;

	let chosenName = exportName;
	let chosenScope: { export: () => Record<string, unknown> } | undefined;

	if (chosenName) {
		const v = mod[chosenName];
		if (!isArktypeScope(v)) {
			throw new Error(
				`extras "${spec}": export "${chosenName}" is not an arktype scope`,
			);
		}
		chosenScope = v;
	} else {
		// Duck-type: pick the first export that looks like an arktype scope.
		for (const [name, v] of Object.entries(mod)) {
			if (isArktypeScope(v)) {
				chosenName = name;
				chosenScope = v;
				break;
			}
		}
		if (!chosenScope) {
			throw new Error(
				`extras "${spec}": no arktype scope export found in ${abs}`,
			);
		}
	}

	const aliases = Object.keys(chosenScope.export());

	// Render the import path relative to the output file's directory so
	// the generated TS resolves the user's extras file from wherever it
	// ends up. Absolute paths stay absolute when no outFile is supplied.
	const importPath = opts.outFile
		? toRelativeImport(abs, path.dirname(path.resolve(opts.outFile)))
		: abs;

	return { importPath, importName: chosenName!, aliases };
}

function isArktypeScope(
	v: unknown,
): v is { export: () => Record<string, unknown> } {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as { export?: unknown }).export === "function" &&
		typeof (v as { import?: unknown }).import === "function"
	);
}

/** Convert an absolute file path to a `./...` import specifier from a base directory. */
function toRelativeImport(target: string, fromDir: string): string {
	let rel = path.relative(fromDir, target);
	if (!rel.startsWith(".") && !rel.startsWith("/")) rel = "./" + rel;
	return rel.replace(/\\/g, "/");
}

/**
 * One-shot dispatch: pick the right backend and produce IR.
 */
export async function importFile(
	filePath: string,
	opts: ImportOptions = {},
): Promise<RustModuleIR> {
	const abs = path.resolve(filePath);
	const { engine, lang } = pickEngine(abs, opts);
	const extraKnownNames = (opts.extras ?? []).flatMap((e) => e.aliases);
	if (engine === "clang") {
		const clLang: ClangLang = lang === "c++" ? "c++" : "c";
		return clangImport(abs, {
			lang: clLang,
			clangBin: opts.clangBin,
			extraArgs: opts.extraClangArgs,
			walk: extraKnownNames.length ? { extraKnownNames } : undefined,
		});
	}
	const tsLang =
		lang === "rust" ? "rust" : lang === "c++" ? "cpp" : "c";
	return treesitterImport(abs, tsLang);
}

/**
 * One-shot: dispatch → IR → arktype scope source string.
 */
export async function fileToArktypeScope(
	filePath: string,
	opts: ImportOptions & EmitOptions = {},
): Promise<string> {
	const ir = await importFile(filePath, opts);
	return emitArktypeScope(ir, opts);
}
