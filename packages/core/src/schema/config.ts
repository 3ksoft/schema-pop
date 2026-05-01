import path from "node:path";
import { scope } from "arktype";
import type { ExporterPlugin } from "./exporter";
import type { BindingSpec } from "../bind";

export const $config = scope({
	BinaryVersion: {
		mode: "'binary' = 'binary'",
		version: "string",
		source: "string",
		"exportName?": "string",
	},

	RichVersion: {
		mode: "'rich'",
		version: "string",
		source: "string",
		"exportName?": "string",
	},

	VersionConfig: "BinaryVersion | RichVersion",
});

export const { BinaryVersion, RichVersion, VersionConfig } = $config.export();

export type BinaryVersion = typeof BinaryVersion.infer;
export type RichVersion = typeof RichVersion.infer;
export type VersionConfig = typeof VersionConfig.infer;

export interface SchemaConfig {
	name: string;
	versions: VersionConfig[];
	targets?: ExporterPlugin<any>[];
	/**
	 * Per-schema layout override. Lets one pop.config.ts host both
	 * binary-aligned schemas (default) and GPU-bound ones (std140 /
	 * std430) without splitting into multiple configs.
	 */
	layout?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
	/**
	 * Per-schema autoLayout override. Default (top-level) reorders
	 * fields to minimize padding; for shader buffers / FFI structs
	 * where field order is contract, set this to false to preserve
	 * the order the user wrote.
	 */
	autoLayout?: boolean;
}

export interface PopConfig {
	endian?: "le" | "be";
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layout?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
	schemas?: SchemaConfig[];
	/**
	 * Optional bind step: copies each source TS file to `dest` and appends
	 * `export const { ... } = $.export()` + matching `export type X = typeof X.infer`
	 * for every arktype scope it finds. Sources may be globs.
	 *
	 * Run as part of `schema-pop` (the build CLI) after schemas are processed,
	 * OR standalone via `schema-pop bind --config pop.config.ts`.
	 */
	bindings?: BindingSpec[];
}

export function defineConfig(config: PopConfig): PopConfig {
	return config;
}

export interface SchemasFromGlobOpts {
	targets: ExporterPlugin<any>[];
	mode?: "binary" | "rich";
	/** Default: "1.0". Used as the version label for every discovered file. */
	version?: string;
	/** Default: process.cwd(). Pattern is resolved relative to this. */
	cwd?: string;
}

/**
 * Expands a glob pattern at config-load time and returns one SchemaConfig
 * per matched file. Schema name comes from the basename (no extension);
 * each schema gets a single-version entry with `source` pointing at the
 * absolute path of the matched file.
 *
 * Useful when you have a folder of independent schemas and don't want
 * to hand-list them in pop.config.ts:
 *
 * ```ts
 * schemas: schemasFromGlob("./src/schema/*.ts", {
 *     targets: [ts({...})],
 *     mode: "rich",
 * })
 * ```
 */
export function schemasFromGlob(
	pattern: string,
	opts: SchemasFromGlobOpts,
): SchemaConfig[] {
	const cwd = opts.cwd ?? process.cwd();
	const version = opts.version ?? "1.0";
	const Bun = (globalThis as any).Bun;
	if (!Bun?.Glob) {
		throw new Error(
			"schemasFromGlob requires Bun's runtime (Bun.Glob is not available).",
		);
	}
	const glob = new Bun.Glob(pattern);
	const matches: string[] = [];
	for (const f of glob.scanSync({ cwd, absolute: true })) {
		matches.push(f as string);
	}
	matches.sort();
	return matches.map((source) => {
		const name = path.basename(source).replace(/\.[^.]+$/, "");
		const versionEntry: VersionConfig = {
			mode: opts.mode ?? "binary",
			version,
			source,
		} as VersionConfig;
		return {
			name,
			versions: [versionEntry],
			targets: opts.targets,
		};
	});
}
