import path from "node:path";
import type { ExporterPlugin } from "./exporter";
import type { BindingSpec } from "../bind";

/**
 * The ground-truth shape for a schema file:
 *   `<name>.pop.ts(x)`           → version defaults to "1"
 *   `<name>.<version>.pop.ts(x)` → version explicit
 *
 * Examples:
 *   konektor.pop.ts            → name="konektor", version="1"
 *   konektor.1.0.pop.ts        → name="konektor", version="1.0"
 *   konektor.2.0.pop.ts        → name="konektor", version="2.0"
 *   wire.0.0.728.pop.ts        → name="wire",     version="0.0.728"
 *
 * Single-version schemas don't need to type the version in the
 * filename — it stays `<name>.pop.ts` until a second version is
 * added (at which point the user renames v1 to `<name>.1.pop.ts`
 * and adds `<name>.2.pop.ts`).
 *
 * Schema name can't contain dots. Returns `null` when the basename
 * doesn't match — caller decides whether to skip the file or
 * surface an error.
 */
export function parseSchemaFilename(
	filePath: string,
): { schemaName: string; version: string } | null {
	const base = path.basename(filePath);
	const stripped = base.replace(/\.tsx?$/, "");
	if (!stripped.endsWith(".pop")) return null;
	const core = stripped.slice(0, -".pop".length);
	if (!core) return null;
	const dotIdx = core.indexOf(".");
	if (dotIdx === -1) return { schemaName: core, version: "1" };
	if (dotIdx === 0) return null;
	const schemaName = core.slice(0, dotIdx);
	const version = core.slice(dotIdx + 1);
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
