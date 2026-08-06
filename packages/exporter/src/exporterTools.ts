import type {
	Field,
	TypePlan,
} from "@schema-pop/schema";
import type {
	NamingStrategy,
	CommentStyle
} from "./api"

function indent(n: number = 1, text: string = ""): string {
	return text
		.split("\n")
		.map((l) => Array(n).fill("\t").join("") + l)
		.join("\n");
}

function toSafeVersionIdentifier(version?: string): string {
	let slug = (version ?? "1.0.0")
		.replace(/[.-]/g, "_")
		.replace(/[^a-zA-Z0-9_]/g, "");
	if (/^[0-9]/.test(slug)) slug = `v${slug}`;
	return slug;
}

export interface NamespaceWrapper {
	open: (mod: string) => string;
	close: string;
	indent?: number;
}

function wrapNamespace(
	version: string,
	body: string,
	w: NamespaceWrapper,
): string {
	const mod = toSafeVersionIdentifier(version);
	return `${w.open(mod)}\n${indent(w.indent, body)}${w.close}\n`;
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

export interface RichTierOptions {
	/**
	 * Treat `kind: "any"` fields as non-rich when they carry an
	 * `originalType` spelling. Used by binary-language exporters that
	 * opt into the "splat the original type verbatim" cheat path
	 * (c / cpp / rust with `useOriginalType: true`) — those exporters
	 * can still emit the field meaningfully, just without round-trip
	 * through schema-pop's binary codec.
	 */
	allowOriginalType?: boolean;
}

/**
 * True if a Field carries no fixed memory layout (rich-tier). Recursive:
 * an array of unbounded items is rich, an optional<rich> is rich, etc.
 * Binary-tier exporters use this to skip types they can't honestly emit.
 */
function isRichField(f: Field, opts: RichTierOptions = {}): boolean {
	if (f.kind === "any") {
		if (opts.allowOriginalType && (f as any).originalType) return false;
		return true;
	}
	if (f.kind === "map") return true;
	if (f.kind === "primitive" && !f.size) return true;
	if (f.kind === "array") return isRichField(f.item, opts);
	if (f.kind === "optional") return isRichField(f.inner, opts);
	if (f.kind === "inlineStruct")
		return f.fields.some((fp) => isRichField(fp.type, opts));
	return false;
}

/**
 * True if a TypePlan is binary-emittable. Wraps `isRichField` over all
 * fields/variants so an exporter can decide to skip the whole type with a
 * single check.
 */
function isRichType(t: TypePlan, opts: RichTierOptions = {}): boolean {
	if (t.kind === "struct")
		return t.fields.some((f) => isRichField(f.type, opts));
	if (t.kind === "union")
		return t.variants.some((v) => isRichField(v.type as Field, opts));
	if (t.kind === "alias") return isRichField(t.type, opts);
	return false;
}

export interface ExporterToolsKit {
	indent: typeof indent;
	wrapNamespace: typeof wrapNamespace;
	toSafeVersionIdentifier: typeof toSafeVersionIdentifier;
	mapScalarField: typeof mapScalarField;
	isRichField: typeof isRichField;
	isRichType: typeof isRichType;
	typeName: (n: string) => string;
	fieldName: (n: string) => string;
	wrapBlock: (code: string) => string;
}

/**
 * Build a per-exporter helper kit. Naming functions are pre-bound to the exporter's config.
 * Usage: `const { typeName, fieldName, indent, mapScalarField, wrapNamespace } = ExporterTools(cfg);`
 */
export function ExporterTools(cfg: {
	typeNaming?: NamingStrategy;
	fieldNaming?: NamingStrategy;
}): ExporterToolsKit {
	return {
		indent,
		wrapNamespace,
		toSafeVersionIdentifier,
		mapScalarField,
		isRichField,
		isRichType,
		typeName: (n: string) => applyNaming(n, cfg.typeNaming ?? "original"),
		fieldName: (n: string) => applyNaming(n, cfg.fieldNaming ?? "original"),
		wrapBlock: (code: string) => `{\n${indent(1, code)}\n}`,
	};
}

export interface CommentOptions {
	isDoc?: boolean;
	indent?: string;
}

/**
 * Renders a string as a comment block based on the language style.
 * Handles multi-line strings automatically.
 */
export function renderComment(
	style: CommentStyle,
	text: string,
	opts: CommentOptions = {},
): string {
	if (style === "none" || !text.trim()) return "";

	const lines = text.trim().split("\n");
	const indent = opts.indent || "";

	switch (style) {
		case "slash": {
			const prefix = opts.isDoc ? "/// " : "// ";
			return lines.map((l) => `${indent}${prefix}${l}`).join("\n");
		}
		case "star": {
			if (lines.length === 1 && !opts.isDoc) {
				return `${indent}/* ${lines[0]} */`;
			}
			const start = opts.isDoc ? "/**" : "/*";
			const body = lines.map((l) => `${indent} * ${l}`).join("\n");
			return `${indent}${start}\n${body}\n${indent} */`;
		}
		case "hash": {
			return lines.map((l) => `${indent}# ${l}`).join("\n");
		}
		case "xml": {
			if (lines.length === 1) return `${indent}<!-- ${lines[0]} -->`;
			return `${indent}<!--\n${lines.map((l) => `${indent}  ${l}`).join("\n")}\n${indent}-->`;
		}
		default:
			return "";
	}
}

export function toSnakeCase(str: string): string {
	return str
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[-\s]+/g, "_")
		.toLowerCase();
}

export function toCamelCase(str: string): string {
	if (!str) return str;
	const s = toPascalCase(str);
	return s.charAt(0).toLowerCase() + s.slice(1);
}

export function toPascalCase(str: string): string {
	if (!str) return str;
	return toSnakeCase(str)
		.split("_")
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
}

export function applyNaming(name: string, strategy: NamingStrategy): string {
	if (strategy === "original" || !name) return name;
	switch (strategy) {
		case "snake_case":
			return toSnakeCase(name);
		case "camelCase":
			return toCamelCase(name);
		case "PascalCase":
			return toPascalCase(name);
		default:
			return name;
	}
}
