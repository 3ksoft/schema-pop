import type { Node as TSNode, Tree } from "web-tree-sitter";
import type {
	RustEnumVariant,
	RustField,
	RustItem,
	RustModuleIR,
	RustType,
} from "./ir";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkTsOptions {
	/** Extra type names that should resolve as `ref` (not get downgraded
	 *  to `unknown`). Pass keys of any user-supplied extras scope. */
	extraKnownNames?: readonly string[];
}

/**
 * tree-sitter-typescript walker. Pulls plain interface / type alias /
 * enum declarations into our IR. Designed for TS files that hand-write
 * value shapes (config schemas, plain DTOs) — not for re-importing an
 * already-arktype scope, and not for advanced TS features like mapped
 * types, conditional types, generics, or intersection types (those
 * become `unknown` IR variants with the original spelling preserved
 * via `OriginalType` so the user can refine later).
 *
 * Mapping (best-effort, biased toward useful schema-pop output):
 *  - `number` → primitive `f64`           (TS's runtime is double)
 *  - `bigint` → primitive `i64`           (most common embedding)
 *  - `boolean` → primitive `bool`
 *  - `string` → string                    (no bound)
 *  - `'a' | 'b' | 'c'` → string union     (enum-shaped)
 *  - `T[]` / `Array<T>` → unbounded vec
 *  - `[T, N]` tuple → unsupported (no schema-pop tuple); skipped
 *  - `Record<K, V>` / `Map<>` / `Set<>` → unsupported
 *  - `interface I { ... }` / `type I = { ... }` → struct
 *  - `type I = T | U | ...` of refs → arktype string union
 *  - `enum E { A, B }` → unit enum
 *  - Everything else → IR `unknown` with original source text
 *    (lifts to `OriginalType<unknown, '...'>` at emit time).
 */

const TS_PRIMITIVE_KEYWORDS: Record<string, RustType> = {
	number: { kind: "primitive", name: "f64" },
	bigint: { kind: "primitive", name: "i64" },
	boolean: { kind: "primitive", name: "bool" },
	string: { kind: "string" },
};

export function walkTsFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkTsOptions = {},
): RustModuleIR {
	const items: RustItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function visit(node: TSNode) {
		const children = node.namedChildren;
		let pendingDoc: string[] = [];

		for (const child of children) {
			if (!child) continue;

			if (child.type === "comment") {
				const t = child.text;
				if (t.startsWith("/**")) {
					const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
					if (m && m[1]) pendingDoc.push(stripStarLines(m[1]));
				} else if (t.startsWith("//")) {
					pendingDoc.push(t.replace(/^\/+\s?/, ""));
				}
				continue;
			}
			// `export interface X {...}` is wrapped in `export_statement`.
			if (child.type === "export_statement") {
				const inner = child.namedChildren.find((c) => c && c.type !== "comment");
				if (inner) {
					const doc = pendingDoc.length ? pendingDoc.join("\n") : undefined;
					handleDecl(inner, doc, items, skipped);
				}
				pendingDoc = [];
				continue;
			}
			const doc = pendingDoc.length ? pendingDoc.join("\n") : undefined;
			pendingDoc = [];
			handleDecl(child, doc, items, skipped);
		}
	}

	visit(tree.rootNode);
	// Refs to types not declared in this file (cross-module imports,
	// referenced-but-undefined names) become `unknown` so the generated
	// scope stays loadable.
	downgradeUnknownRefs(items, opts.extraKnownNames);
	return { source: sourcePath, items, skipped };
}

function handleDecl(
	node: TSNode,
	doc: string | undefined,
	items: RustItem[],
	skipped: { name: string; reason: string }[],
): void {
	switch (node.type) {
		case "interface_declaration":
			handleInterface(node, doc, items, skipped);
			break;
		case "type_alias_declaration":
			handleTypeAlias(node, doc, items, skipped);
			break;
		case "enum_declaration":
			handleEnum(node, doc, items);
			break;
		default:
			// Imports, statements, generics-only types, etc. — silently ignored.
			break;
	}
}

function handleInterface(
	node: TSNode,
	doc: string | undefined,
	items: RustItem[],
	skipped: { name: string; reason: string }[],
): void {
	const name = node.childForFieldName("name")?.text;
	if (!name) return;
	if (node.childForFieldName("type_parameters")) {
		skipped.push({ name, reason: "generic interface" });
		return;
	}
	const body = node.childForFieldName("body");
	if (!body) return;
	const fields = collectStructFields(body, skipped, name);
	items.push({ kind: "struct", name, fields, doc, pub: true });
}

function handleTypeAlias(
	node: TSNode,
	doc: string | undefined,
	items: RustItem[],
	skipped: { name: string; reason: string }[],
): void {
	const name = node.childForFieldName("name")?.text;
	if (!name) return;
	if (node.childForFieldName("type_parameters")) {
		skipped.push({ name, reason: "generic type alias" });
		return;
	}
	const value = node.childForFieldName("value");
	if (!value) return;

	// `type X = { ... }` → struct
	if (value.type === "object_type") {
		const fields = collectStructFields(value, skipped, name);
		items.push({ kind: "struct", name, fields, doc, pub: true });
		return;
	}

	// `type X = 'a' | 'b' | 'c'` → unit enum (string literal union)
	if (value.type === "union_type") {
		const lits = collectStringLiterals(value);
		if (lits) {
			items.push({
				kind: "enum",
				name,
				variants: lits.map((l) => ({ kind: "unit", name: l })),
				doc,
				pub: true,
			});
			return;
		}
		// Mixed / non-literal union — emit as alias with raw expression
		items.push({
			kind: "alias",
			name,
			type: { kind: "unknown", raw: value.text },
			doc,
			pub: true,
		});
		return;
	}

	// `type X = T` for any other RHS → alias
	const t = parseTsType(value);
	items.push({ kind: "alias", name, type: t, doc, pub: true });
}

function handleEnum(
	node: TSNode,
	doc: string | undefined,
	items: RustItem[],
): void {
	const name = node.childForFieldName("name")?.text;
	const body = node.childForFieldName("body");
	if (!name || !body) return;
	const variants: RustEnumVariant[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type !== "property_identifier" && c.type !== "enum_assignment") continue;
		const variantName =
			c.type === "property_identifier"
				? c.text
				: (c.childForFieldName("name")?.text ?? c.text);
		if (variantName) variants.push({ kind: "unit", name: variantName });
	}
	items.push({ kind: "enum", name, variants, doc, pub: true });
}

function collectStructFields(
	body: TSNode,
	skipped: { name: string; reason: string }[],
	parentName: string,
): RustField[] {
	const fields: RustField[] = [];
	let pendingDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			const t = c.text;
			if (t.startsWith("/**")) {
				const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) pendingDoc.push(stripStarLines(m[1]));
			} else if (t.startsWith("//")) {
				pendingDoc.push(t.replace(/^\/+\s?/, ""));
			}
			continue;
		}
		if (c.type !== "property_signature") continue;
		const f = parseProperty(c);
		if (!f) {
			const fname = c.childForFieldName("name")?.text ?? "<unknown>";
			skipped.push({
				name: `${parentName}.${fname}`,
				reason: "unsupported field shape",
			});
			pendingDoc = [];
			continue;
		}
		if (pendingDoc.length) {
			f.doc = pendingDoc.join("\n");
			pendingDoc = [];
		}
		fields.push(f);
	}
	return fields;
}

function parseProperty(node: TSNode): RustField | null {
	const nameNode = node.childForFieldName("name");
	const typeAnnot = node.namedChildren.find(
		(c) => c && c.type === "type_annotation",
	);
	if (!nameNode) return null;
	const name = nameNode.text;
	// `?` mark on name means optional.
	const optional = node.text.includes(`${name}?:`);
	const typeNode = typeAnnot?.namedChildren.find((c) => c && c.type !== "comment");
	if (!typeNode) return null;
	let t = parseTsType(typeNode);
	if (optional) t = { kind: "option", inner: t };
	return { name, type: t, pub: true };
}

function collectStringLiterals(unionNode: TSNode): string[] | null {
	// tree-sitter-typescript parses `A | B | C | D` left-associatively as
	// `union_type(union_type(union_type(A, B), C), D)`. Flatten left-to-
	// right so the collected order matches the source. Anything that
	// isn't a string `literal_type` aborts the "is this a clean
	// string-literal union?" check.
	const lits: string[] = [];
	const ok = (function walk(n: TSNode): boolean {
		for (const c of n.namedChildren) {
			if (!c) continue;
			if (c.type === "union_type") {
				if (!walk(c)) return false;
				continue;
			}
			if (c.type !== "literal_type") return false;
			const inner = c.namedChild(0);
			if (!inner || inner.type !== "string") return false;
			const raw = inner.text;
			const m = raw.match(/^['"`](.*)['"`]$/);
			lits.push(m ? m[1]! : raw);
		}
		return true;
	})(unionNode);
	if (!ok) return null;
	return lits.length ? lits : null;
}

function parseTsType(node: TSNode): RustType {
	switch (node.type) {
		case "predefined_type": {
			const t = TS_PRIMITIVE_KEYWORDS[node.text];
			if (t) return t;
			return { kind: "unknown", raw: node.text };
		}
		case "type_identifier":
			return { kind: "ref", name: node.text };
		case "array_type": {
			// `T[]` — child is the element type.
			const elem = node.namedChild(0);
			if (elem) return { kind: "vec", item: parseTsType(elem) };
			return { kind: "unknown", raw: node.text };
		}
		case "generic_type": {
			// `Array<T>` → vec; everything else → unknown.
			const ident = node.childForFieldName("name")?.text;
			const args = node.childForFieldName("type_arguments");
			if (ident === "Array" && args) {
				const inner = args.namedChild(0);
				if (inner) return { kind: "vec", item: parseTsType(inner) };
			}
			return { kind: "unknown", raw: node.text };
		}
		case "literal_type": {
			// Single literal (`'a'`) used as a type — collapses to string-literal.
			const inner = node.namedChild(0);
			if (inner?.type === "string") {
				const m = inner.text.match(/^['"`](.*)['"`]$/);
				return { kind: "ref", name: `'${m ? m[1] : inner.text}'` };
			}
			return { kind: "unknown", raw: node.text };
		}
		case "union_type": {
			// In TS field position; collect string literals only — anything
			// else needs synthesised tagged-union plumbing we don't do here.
			const lits = collectStringLiterals(node);
			if (lits) {
				return { kind: "ref", name: lits.map((l) => `'${l}'`).join(" | ") };
			}
			return { kind: "unknown", raw: node.text };
		}
		case "object_type":
			// Inline object as field type. schema-pop has no anonymous structs
			// at this level — ask user to lift to a top-level interface.
			return { kind: "unknown", raw: node.text };
		default:
			return { kind: "unknown", raw: node.text };
	}
}

function stripStarLines(block: string): string {
	return block
		.split("\n")
		.map((l) => l.replace(/^\s*\*\s?/, ""))
		.join("\n")
		.trim();
}
