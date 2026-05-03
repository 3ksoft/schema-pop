/**
 * `LayoutPlan` ↔ JSON-on-disk. The on-wire shape is `LayoutPlan`
 * verbatim plus a `$schemaVersion` discriminator at the root, so a
 * future format bump can route by version without sniffing fields.
 *
 * Importers (clang, tree-sitter) write `.layout.json` via
 * `writeLayoutPlan`; the build CLI (`schema-pop emit foo.layout.json`)
 * reads it back via `readLayoutPlan` and dispatches to exporters
 * without round-tripping through arktype scope source.
 *
 * Both functions live in node-only code (`fs/promises`) — keep them
 * out of the browser-safe entry (core/src/index.ts re-exports the
 * types but not these IO helpers).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LayoutPlan } from "./schema/layout";

export const LAYOUT_JSON_SCHEMA_VERSION = "1";

export interface LayoutJsonEnvelope {
	$schemaVersion: typeof LAYOUT_JSON_SCHEMA_VERSION;
	plan: LayoutPlan;
}

export async function writeLayoutPlan(
	plan: LayoutPlan,
	dest: string,
): Promise<void> {
	const envelope: LayoutJsonEnvelope = {
		$schemaVersion: LAYOUT_JSON_SCHEMA_VERSION,
		plan,
	};
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.writeFile(dest, JSON.stringify(envelope, null, 2) + "\n", "utf8");
}

export async function readLayoutPlan(src: string): Promise<LayoutPlan> {
	const raw = await fs.readFile(src, "utf8");
	const parsed = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("$schemaVersion" in parsed) ||
		!("plan" in parsed)
	) {
		throw new Error(
			`readLayoutPlan: ${src} is not a valid layout JSON (missing $schemaVersion / plan)`,
		);
	}
	const envelope = parsed as LayoutJsonEnvelope;
	if (envelope.$schemaVersion !== LAYOUT_JSON_SCHEMA_VERSION) {
		throw new Error(
			`readLayoutPlan: ${src} has $schemaVersion="${envelope.$schemaVersion}", expected "${LAYOUT_JSON_SCHEMA_VERSION}"`,
		);
	}
	return envelope.plan;
}
