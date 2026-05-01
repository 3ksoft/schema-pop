import { applyNaming } from "./utils/naming";
import type { Field, TypePlan } from "./schema/layout";
import type { NamingStrategy } from "./schema/exporter";

const INDENT = (num = 1): string => "\t".repeat(num);

function toSafeVersionIdentifier(version: string): string {
	let slug = version.replace(/[.-]/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
	if (/^[0-9]/.test(slug)) slug = `v${slug}`;
	return slug;
}

function indentBlock(code: string, indent = "\t"): string {
	return code
		.split("\n")
		.map((l) => (l ? `${indent}${l}` : l))
		.join("\n");
}

export interface NamespaceWrapper {
	open: (mod: string) => string;
	close: string;
	indent?: string;
}

function wrapNamespace(
	version: string,
	body: string,
	w: NamespaceWrapper,
): string {
	const mod = toSafeVersionIdentifier(version);
	return `${w.open(mod)}\n${indentBlock(body, w.indent ?? "\t")}${w.close}\n`;
}

/**
 * Resolves the target-language type name for a primitive or reference field.
 * Returns undefined for kinds that need recursion (array, optional, string, inlineStruct, unit).
 */
function mapScalarField(
	field: Field,
	primitives: Record<string, string>,
	refName: (n: string) => string,
	fallback?: string,
): string | undefined {
	if (field.kind === "primitive") return primitives[field.name] ?? fallback;
	if (field.kind === "reference") return refName(field.name);
	return undefined;
}

/**
 * True if a Field carries no fixed memory layout (rich-tier). Recursive:
 * an array of unbounded items is rich, an optional<rich> is rich, etc.
 * Binary-tier exporters use this to skip types they can't honestly emit.
 */
function isRichField(f: Field): boolean {
	if (f.kind === "map" || f.kind === "any") return true;
	if (f.kind === "primitive" && (f as any).popKind === "rich") return true;
	if (f.kind === "array") return isRichField(f.item);
	if (f.kind === "optional") return isRichField(f.inner);
	if (f.kind === "inlineStruct")
		return f.fields.some((fp) => isRichField(fp.type));
	return false;
}

/**
 * True if a TypePlan is binary-emittable. Wraps `isRichField` over all
 * fields/variants so an exporter can decide to skip the whole type with a
 * single check.
 */
function isRichType(t: TypePlan): boolean {
	if (t.kind === "struct") return t.fields.some((f) => isRichField(f.type));
	if (t.kind === "union")
		return t.variants.some((v) => isRichField(v.type as Field));
	if (t.kind === "alias") return isRichField(t.type);
	return false;
}

export interface ExporterToolsKit {
	INDENT: typeof INDENT;
	indentBlock: typeof indentBlock;
	wrapNamespace: typeof wrapNamespace;
	toSafeVersionIdentifier: typeof toSafeVersionIdentifier;
	mapScalarField: typeof mapScalarField;
	isRichField: typeof isRichField;
	isRichType: typeof isRichType;
	typeName: (n: string) => string;
	fieldName: (n: string) => string;
}

/**
 * Build a per-exporter helper kit. Naming functions are pre-bound to the exporter's config.
 * Usage: `const { typeName, fieldName, INDENT, mapScalarField, wrapNamespace } = ExporterTools(cfg);`
 */
export function ExporterTools(cfg: {
	typeNaming?: NamingStrategy;
	fieldNaming?: NamingStrategy;
}): ExporterToolsKit {
	return {
		INDENT,
		indentBlock,
		wrapNamespace,
		toSafeVersionIdentifier,
		mapScalarField,
		isRichField,
		isRichType,
		typeName: (n: string) => applyNaming(n, cfg.typeNaming ?? "original"),
		fieldName: (n: string) => applyNaming(n, cfg.fieldNaming ?? "original"),
	};
}
