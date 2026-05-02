import path from "node:path";
import type { ExporterPlugin } from "./exporter";
import type { BindingSpec } from "../bind";

/**
 * The ground-truth shape for a schema file:
 *   `<name>.<version>.pop.ts(x)`
 *
 * Examples:
 *   konektor.1.0.pop.ts        → name="konektor", version="1.0"
 *   wire.0.0.728.pop.ts        → name="wire",     version="0.0.728"
 *   telemetry.1.pop.ts         → name="telemetry", version="1"
 *
 * Schema name can't contain dots (everything before the first `.` is
 * the name; everything between that and the `.pop.ts` suffix is the
 * version). Returns `null` when the basename doesn't match — caller
 * decides whether to skip the file or surface an error.
 */
export function parseSchemaFilename(
	filePath: string,
): { schemaName: string; version: string } | null {
	const base = path.basename(filePath);
	const stripped = base.replace(/\.tsx?$/, "");
	if (!stripped.endsWith(".pop")) return null;
	const core = stripped.slice(0, -".pop".length);
	const dotIdx = core.indexOf(".");
	if (dotIdx <= 0) return null;
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
