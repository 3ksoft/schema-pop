// Schema-pop-aware emitter: dzielnia Field → arktype source string using
// schema-pop's primitive aliases (u8..u128, i8..i128, f32/f64, bool, u1..u7)
// and meta-wrapping generics (Describe, Scale, Obsolete, Reserved, At, Bit).
//
// Mirror of schema-pop/packages/core/src/schema/{binary,bitwise,core}.ts.
// Pure string building — no schema-pop runtime dep.

import type { FormField as Field } from "schema-pop";

type FunctionArg = {
	name?: string;
	type: Field;
	variadic?: boolean;
};

type FunctionPlan = {
	name: string;
	symbol?: string;
	returnType: Field;
	args: FunctionArg[];
	abi?: string;
	async?: boolean;
	throws?: boolean;
	description?: string;
	obsolete?: boolean;
	obsoleteReason?: string;
	renamedFrom?: string;
};

const BIN_PRIMS = [
	"u8", "i8", "u16", "i16", "u32", "i32",
	"u64", "i64", "u128", "i128", "f32", "f64", "bool",
] as const;

/** Renders a Field as a single arktype-syntax string. */
export function fieldToSchemaPopExpr(f: Field): string {
	if (!f) return "unknown";
	let s = baseExpr(f);

	// Wrappers ordered so the source mirrors schema-pop convention:
	// base → Reserved (replaces underlying size) → At (fixed offset) →
	// Scale (numeric) → Obsolete (deprecation) → Describe (outermost label).
	const popKind = (f as any).popKind;
	const size = (f as any).size;
	const addr = (f as any).addr;
	const scale = (f as any).scale;
	const obsolete = (f as any).obsolete;
	const obsoleteReason = (f as any).obsoleteReason;
	const description = (f as any).description;

	if (popKind === "reserved" && typeof size === "number") {
		s = `Reserved<${s}, ${size}>`;
	}
	if (typeof addr === "number") s = `At<${s}, ${addr}>`;
	if (typeof scale === "number") s = `Scale<${s}, ${scale}>`;
	if (obsolete) {
		s = obsoleteReason
			? `Obsolete<${s}, ${quote(obsoleteReason)}>`
			: `Obsolete<${s}, ''>`;
	}
	if (typeof description === "string" && description.length > 0) {
		// Skip the synthetic note we attach to lossy struct-union decoding.
		if (!description.startsWith("union of ")) {
			s = `Describe<${s}, ${quote(description)}>`;
		}
	}
	return s;
}

function baseExpr(f: Field): string {
	switch (f.type) {
		case "link": {
			// Strip "#/schemas/<sid>/" prefix; emit the bare alias name.
			const target = (f as any).target as string | undefined;
			if (!target) return "unknown";
			const parts = target.split("/");
			return parts[parts.length - 1] || target;
		}
		case "boolean": {
			const bt = (f as any).binaryType;
			return bt === "bool" ? "bool" : "boolean";
		}
		case "number": {
			const bt = (f as any).binaryType as string | undefined;
			const popKind = (f as any).popKind as string | undefined;
			const size = (f as any).size as number | undefined;
			if (popKind === "bitwise" && typeof size === "number" && size >= 1 && size <= 7) {
				return `u${size}`;
			}
			if (bt && (BIN_PRIMS as readonly string[]).includes(bt)) return bt;
			// Vanilla number with optional constraints.
			let s = "number";
			const min = (f as any).min as number | undefined;
			const max = (f as any).max as number | undefined;
			if (typeof min === "number" && typeof max === "number") {
				s = `${min} <= number <= ${max}`;
			} else if (typeof min === "number") {
				s = `number >= ${min}`;
			} else if (typeof max === "number") {
				s = `number <= ${max}`;
			}
			return s;
		}
		case "string":
		case "text": {
			let s = "string";
			const min = (f as any).minLength as number | undefined;
			const max = (f as any).maxLength as number | undefined;
			const pat = (f as any).pattern as string | undefined;
			if (pat) s = `/${pat}/`;
			if (typeof min === "number") s += ` >= ${min}`;
			if (typeof max === "number") s += ` <= ${max}`;
			return s;
		}
		case "any":
			return "unknown";
		case "enum": {
			const options = ((f as any).options ?? []) as Array<string | { value: string | number }>;
			const lits = options.map((o) =>
				typeof o === "string" ? quote(o) : quote(String(o.value)),
			);
			if (lits.length === 0) return "string";
			return lits.join(" | ");
		}
		case "array": {
			const item = (f as any).item as Field | undefined;
			let inner = item ? fieldToSchemaPopExpr(item) : "unknown";
			// Wrap precedence: complex expressions parenthesized for clarity.
			if (needsParens(inner)) inner = `(${inner})`;
			let s = `${inner}[]`;
			const min = (f as any).minItems as number | undefined;
			const max = (f as any).maxItems as number | undefined;
			if (typeof min === "number" && typeof max === "number") {
				s += ` >= ${min} & <= ${max}`;
			} else if (typeof min === "number") {
				s += `>= ${min}`;
			} else if (typeof max === "number") {
				s += `<= ${max}`;
			}
			return s;
		}
		case "object": {
			// Nested object literal serialized inline. Top-level objects in a
			// scope are usually object literals (not strings); for nested or
			// inside-array objects, the string form lets us stay in one
			// expression. arktype accepts either.
			const fields = (f as any).fields as Record<string, Field> | undefined;
			if (!fields || Object.keys(fields).length === 0) return "object";
			const parts: string[] = [];
			for (const [k, v] of Object.entries(fields)) {
				const inner = fieldToSchemaPopExpr(v);
				const opt = (v as any).required === false ? "?" : "";
				parts.push(`${k}${opt}: ${inner}`);
			}
			return `{ ${parts.join(", ")} }`;
		}
		default:
			return "unknown";
	}
}

function needsParens(expr: string): boolean {
	// `Foo | Bar`, `a >= b`, etc. — anything with top-level union/constraint
	// operators needs parens before suffixing `[]`.
	return /[ |&]/.test(expr);
}

function quote(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	if (!s.includes('"')) return `"${s}"`;
	return `'${s.replace(/'/g, "\\'")}'`;
}

/** Options for a full-source emitter. */
export type EmitSourceOpts = {
	scopeVar?: string; // default: "$"
	importPath?: string; // default: "schema-pop"
	includeSchemaPopSpread?: boolean; // default: true
	header?: string; // optional comment block prepended after imports
	functions?: FunctionPlan[]; // optional FFI declarations emitted alongside the scope
	functionsVar?: string; // default: "functions"
};

/**
 * Emits a full TS source file with `scope({...})` body. Top-level Field of
 * type "object" become inline object literals; everything else becomes a
 * string entry. The result should parse with the schema-pop scope at runtime.
 *
 * If `opts.functions` is provided, an additional `export const functions:
 * FunctionPlan[] = [...]` block is appended. Each function's arg `type` and
 * `returnType` are rendered as arktype-syntax strings via fieldToSchemaPopExpr,
 * so they parse against the same scope at runtime.
 */
export function fieldsToSchemaPopSource(
	fields: Record<string, Field>,
	opts: EmitSourceOpts = {},
): string {
	const scopeVar = opts.scopeVar ?? "$";
	const importPath = opts.importPath ?? "schema-pop";
	const includeSpread = opts.includeSchemaPopSpread ?? true;
	const functions = opts.functions ?? [];
	const functionsVar = opts.functionsVar ?? "functions";

	const lines: string[] = [];
	lines.push(`import { schemaPop, scope } from ${quote(importPath)};`);
	if (functions.length > 0) {
		lines.push(`import type { FunctionPlan } from ${quote(importPath)};`);
	}
	lines.push("");
	if (opts.header) {
		lines.push(opts.header);
		lines.push("");
	}
	lines.push(`export const ${scopeVar} = scope({`);
	if (includeSpread) lines.push(`\t...schemaPop,`);
	for (const [name, field] of Object.entries(fields)) {
		lines.push(`\t${name}: ${topLevelEntry(field)},`);
	}
	lines.push(`});`);

	if (functions.length > 0) {
		lines.push("");
		lines.push(`export const ${functionsVar}: FunctionPlan[] = [`);
		for (const fn of functions) {
			lines.push(emitFunction(fn));
		}
		lines.push(`];`);
	}
	return lines.join("\n") + "\n";
}

function emitFunction(fn: FunctionPlan): string {
	const lines: string[] = [`\t{`];
	lines.push(`\t\tname: ${quote(fn.name)},`);
	if (fn.symbol) lines.push(`\t\tsymbol: ${quote(fn.symbol)},`);
	lines.push(`\t\treturnType: ${JSON.stringify(fieldToSchemaPopExpr(fn.returnType))},`);
	lines.push(`\t\targs: [${fn.args.map(emitArg).join(", ")}],`);
	if (fn.abi) lines.push(`\t\tabi: ${quote(fn.abi)},`);
	if (fn.async) lines.push(`\t\tasync: true,`);
	if (fn.throws) lines.push(`\t\tthrows: true,`);
	if (fn.description) lines.push(`\t\tdescription: ${quote(fn.description)},`);
	if (fn.obsolete) lines.push(`\t\tobsolete: true,`);
	if (fn.obsoleteReason) lines.push(`\t\tobsoleteReason: ${quote(fn.obsoleteReason)},`);
	if (fn.renamedFrom) lines.push(`\t\trenamedFrom: ${quote(fn.renamedFrom)},`);
	lines.push(`\t},`);
	return lines.join("\n");
}

function emitArg(a: FunctionArg): string {
	const typeExpr = JSON.stringify(fieldToSchemaPopExpr(a.type));
	const parts: string[] = [];
	if (a.name) parts.push(`name: ${quote(a.name)}`);
	parts.push(`type: ${typeExpr}`);
	if (a.variadic) parts.push(`variadic: true`);
	return `{ ${parts.join(", ")} }`;
}

// Top-level objects emit as object literals; everything else as a quoted string.
function topLevelEntry(f: Field): string {
	if (f.type === "object") {
		const fields = (f as any).fields as Record<string, Field>;
		if (!fields || Object.keys(fields).length === 0) return `"object"`;
		const parts: string[] = [];
		for (const [k, v] of Object.entries(fields)) {
			const opt = (v as any).required === false ? "?" : "";
			const expr = fieldToSchemaPopExpr(v);
			parts.push(`\t\t${quote(`${k}${opt}`).replace(/^'(.*)'$/, '"$1"')}: ${quote(expr).replace(/^'(.*)'$/, '"$1"').replace(/\\'/g, "'")},`);
		}
		// Use double-quoted keys + values for safety; rough but parseable.
		return `{\n${parts.join("\n")}\n\t}`;
	}
	const expr = fieldToSchemaPopExpr(f);
	return `"${expr.replace(/"/g, '\\"')}"`;
}
