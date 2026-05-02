import path from "node:path";
import type { ExporterPlugin } from "./exporter";
import type { BindingSpec } from "../bind";

/**
 * Parse a schema filename. The `.pop` segment is a convention, not a
 * requirement — when it's there we strip it, when it isn't we accept
 * the file as-is. Whatever your discovery glob pulls in, that's what
 * gets loaded.
 *
 *   konektor.pop.ts        → name="konektor", version="1"
 *   konektor.ts            → name="konektor", version="1"
 *   konektor.1.0.pop.ts    → name="konektor", version="1.0"
 *   konektor.1.0.ts        → name="konektor", version="1.0"
 *   wire.0.0.728.pop.ts    → name="wire",     version="0.0.728"
 *
 * Default discovery glob (`**\/*.pop.ts`) keeps the convention so
 * unrelated `.ts` files in the project don't get swept in by accident.
 * Override `defineConfig.schemas` to widen (e.g. `./src/schema/*.ts`)
 * when you don't want to retype every file's extension.
 *
 * Schema name can't contain dots. Returns `null` when the basename
 * is empty or starts with a dot — caller decides whether to skip
 * the file or surface an error.
 */
export function parseSchemaFilename(
	filePath: string,
): { schemaName: string; version: string } | null {
	const base = path.basename(filePath);
	let stripped = base.replace(/\.tsx?$/, "");
	if (!stripped) return null;
	if (stripped.endsWith(".pop")) {
		stripped = stripped.slice(0, -".pop".length);
		if (!stripped) return null;
	}
	const dotIdx = stripped.indexOf(".");
	if (dotIdx === -1) return { schemaName: stripped, version: "1" };
	if (dotIdx === 0) return null;
	const schemaName = stripped.slice(0, dotIdx);
	const version = stripped.slice(dotIdx + 1);
	if (!version) return null;
	return { schemaName, version };
}

/**
 * Sort a list of version strings semver-ish: compare numeric segments
 * pairwise (longer wins ties), fall back to lexicographic when a
 * segment isn't pure-numeric. Stable enough for the builder's
 * "walk versions in order" use case without pulling in a semver dep.
 */
export function compareVersions(a: string, b: string): number {
	const sa = a.split(".");
	const sb = b.split(".");
	const max = Math.max(sa.length, sb.length);
	for (let i = 0; i < max; i++) {
		const ra = sa[i];
		const rb = sb[i];
		if (ra === undefined) return -1;
		if (rb === undefined) return 1;
		const na = Number(ra);
		const nb = Number(rb);
		if (Number.isFinite(na) && Number.isFinite(nb)) {
			if (na !== nb) return na - nb;
		} else if (ra !== rb) {
			return ra < rb ? -1 : 1;
		}
	}
	return 0;
}

export interface PopConfig {
	/**
	 * Glob patterns (or single string) for schema files to discover.
	 * Default when omitted: `./**\/*.pop.ts`. Resolved relative to the
	 * config file's directory.
	 */
	schemas?: string | string[];
	/**
	 * Output root. Per-target `dest` wins when set; otherwise the
	 * builder lands generated files at `<destDir>/<schemaName>.<ext>`.
	 */
	destDir?: string;
	/**
	 * Default exporters applied to every discovered schema. Each
	 * schema's `schemaPop({ extendsTargets: false }, ...)` wrap can
	 * replace this list; the default appends.
	 */
	targets?: ExporterPlugin<any>[];
	/**
	 * Layout / inference defaults. Schemas can override per file via
	 * `schemaPop({ ... }, scope({...}))`.
	 */
	endian?: "le" | "be";
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layout?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
	mode?: "binary" | "rich";
	/**
	 * Optional bind step: copies each source TS file to `dest` and
	 * appends `export const { ... } = $.export()` + matching
	 * `export type X = typeof X.infer` for every arktype scope it
	 * finds. Sources may be globs.
	 *
	 * Run as part of `schema-pop` (the build CLI) after schemas are
	 * processed, OR standalone via `schema-pop bind --config pop.config.ts`.
	 */
	bindings?: BindingSpec[];
}

export function defineConfig(config: PopConfig): PopConfig {
	return config;
}
