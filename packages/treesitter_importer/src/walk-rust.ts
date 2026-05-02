import type { Node as TSNode, Tree } from "web-tree-sitter";
import type {
	RustField,
	RustEnumVariant,
	RustItem,
	RustModuleIR,
	RustPrimitive,
	RustType,
} from "./ir";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkRustOptions {
	/** Extra type names that should resolve as `ref` (not get downgraded
	 *  to `unknown`). Pass keys of any user-supplied extras scope. */
	extraKnownNames?: readonly string[];
}

const PRIMITIVE_NAMES = new Set<RustPrimitive>([
	"u8",
	"u16",
	"u32",
	"u64",
	"u128",
	"i8",
	"i16",
	"i32",
	"i64",
	"i128",
	"f32",
	"f64",
	"bool",
]);

/**
 * Walk a `source_file` and emit IR. Top-level recursion only handles items
 * we care about (struct / enum / type alias). `mod_item` descends into its
 * body. Everything else is silently skipped.
 */
export function walkRustFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkRustOptions = {},
): RustModuleIR {
	const items: RustItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function visit(node: TSNode, scopePrefix: string) {
		const children = node.namedChildren;
		// Collect pending attributes and doc-comments contiguously preceding
		// the next concrete item.
		let pendingAttrs: string[] = [];
		let pendingDoc: string[] = [];

		for (const child of children) {
			if (!child) continue;
			if (child.type === "attribute_item") {
				pendingAttrs.push(child.text);
				continue;
			}
			if (child.type === "line_comment") {
				const t = child.text;
				if (t.startsWith("///")) {
					pendingDoc.push(t.replace(/^\/\/\/\s?/, ""));
				}
				continue;
			}
			if (child.type === "block_comment") {
				const t = child.text;
				const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) pendingDoc.push(m[1].trim());
				continue;
			}

			const attrs = pendingAttrs;
			const doc = pendingDoc.length ? pendingDoc.join("\n") : undefined;
			pendingAttrs = [];
			pendingDoc = [];

			if (child.type === "struct_item") {
				const item = handleStruct(child, attrs, doc, scopePrefix);
				if (item.ok) items.push(item.value);
				else skipped.push({ name: item.name, reason: item.reason });
			} else if (child.type === "enum_item") {
				const item = handleEnum(child, attrs, doc, scopePrefix);
				if (item.ok) items.push(item.value);
				else skipped.push({ name: item.name, reason: item.reason });
			} else if (child.type === "type_item") {
				const item = handleAlias(child, attrs, doc, scopePrefix);
				if (item.ok) items.push(item.value);
				else skipped.push({ name: item.name, reason: item.reason });
			} else if (
				child.type === "function_item" ||
				child.type === "function_signature_item"
			) {
				const item = handleFunction(child, doc, scopePrefix);
				if (item.ok) items.push(item.value);
				else skipped.push({ name: item.name, reason: item.reason });
			} else if (child.type === "foreign_mod_item") {
				// `extern "C" { fn foo(...); ... }` — descend into body, applying
				// the abi from the wrapper.
				const abi = findExternAbi(child);
				const body = child.childForFieldName("body");
				if (body) {
					for (const fn of body.namedChildren) {
						if (!fn) continue;
						if (fn.type !== "function_signature_item") continue;
						const r = handleFunction(fn, undefined, scopePrefix, abi);
						if (r.ok) items.push(r.value);
						else skipped.push({ name: r.name, reason: r.reason });
					}
				}
			} else if (child.type === "mod_item") {
				const nameNode = child.childForFieldName("name");
				const bodyNode = child.childForFieldName("body");
				if (bodyNode) {
					visit(
						bodyNode,
						scopePrefix
							? `${scopePrefix}::${nameNode?.text ?? "mod"}`
							: (nameNode?.text ?? "mod"),
					);
				}
			}
			// Other top-level items (use, impl, fn, trait, ...) are silently ignored.
		}
	}

	visit(tree.rootNode, "");
	// Refs to types not declared in this file (cross-module imports
	// tree-sitter doesn't follow) become `unknown` IR variants —
	// generated scope stays loadable; original spelling preserved on
	// each field's `originalType`.
	downgradeUnknownRefs(items, opts.extraKnownNames);
	return { source: sourcePath, items, skipped };
}

type Handle<T> =
	| { ok: true; value: T }
	| { ok: false; name: string; reason: string };

function parseAttrs(attrs: string[]): { repr?: string[] } {
	for (const a of attrs) {
		const m = a.match(/^#\[\s*repr\s*\(([^)]*)\)\s*\]$/);
		if (m) {
			const args = m[1]!
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			return { repr: args };
		}
	}
	return {};
}

function isPub(node: TSNode): boolean {
	for (const c of node.namedChildren) {
		if (c?.type === "visibility_modifier") return true;
	}
	return false;
}

function handleStruct(
	node: TSNode,
	attrs: string[],
	doc: string | undefined,
	scopePrefix: string,
): Handle<RustItem> {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return { ok: false, name: "<anon>", reason: "no name" };
	const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

	// Generics → unsupported in MVP.
	if (node.childForFieldName("type_parameters")) {
		return { ok: false, name: qName, reason: "generic struct" };
	}

	const body = node.childForFieldName("body");
	if (!body) {
		// Unit struct — treat as empty struct.
		return {
			ok: true,
			value: {
				kind: "struct",
				name,
				fields: [],
				...parseAttrs(attrs),
				doc,
				pub: isPub(node),
			},
		};
	}
	if (body.type !== "field_declaration_list") {
		return { ok: false, name: qName, reason: `tuple struct (${body.type})` };
	}

	const fields: RustField[] = [];
	let fieldDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "line_comment") {
			if (c.text.startsWith("///")) {
				fieldDoc.push(c.text.replace(/^\/\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type === "attribute_item") {
			// Per-field attrs (e.g., `#[serde(...)]`) — silently ignored for now.
			continue;
		}
		if (c.type !== "field_declaration") continue;
		const fnameNode = c.childForFieldName("name");
		const ftypeNode = c.childForFieldName("type");
		const fname = fnameNode?.text;
		if (!fname || !ftypeNode) {
			continue;
		}
		const t = parseRustType(ftypeNode);
		fields.push({
			name: fname,
			type: t,
			doc: fieldDoc.length ? fieldDoc.join("\n") : undefined,
			pub: isPub(c),
		});
		fieldDoc = [];
	}

	return {
		ok: true,
		value: {
			kind: "struct",
			name,
			fields,
			...parseAttrs(attrs),
			doc,
			pub: isPub(node),
		},
	};
}

function handleEnum(
	node: TSNode,
	attrs: string[],
	doc: string | undefined,
	scopePrefix: string,
): Handle<RustItem> {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return { ok: false, name: "<anon>", reason: "no name" };
	const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

	if (node.childForFieldName("type_parameters")) {
		return { ok: false, name: qName, reason: "generic enum" };
	}

	const body = node.childForFieldName("body");
	if (!body) return { ok: false, name: qName, reason: "no body" };

	const variants: RustEnumVariant[] = [];
	let variantDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "line_comment") {
			if (c.text.startsWith("///")) {
				variantDoc.push(c.text.replace(/^\/\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type !== "enum_variant") continue;
		const vnameNode = c.childForFieldName("name");
		const vname = vnameNode?.text;
		if (!vname) continue;
		const vbody = c.childForFieldName("body");
		const vDoc = variantDoc.length ? variantDoc.join("\n") : undefined;
		variantDoc = [];
		if (!vbody) {
			variants.push({ kind: "unit", name: vname, doc: vDoc });
			continue;
		}
		if (vbody.type === "ordered_field_declaration_list") {
			const types: RustType[] = [];
			for (const t of vbody.namedChildren) {
				if (!t) continue;
				if (
					t.type === "line_comment" ||
					t.type === "block_comment" ||
					t.type === "attribute_item" ||
					t.type === "visibility_modifier"
				)
					continue;
				types.push(parseRustType(t));
			}
			variants.push({ kind: "tuple", name: vname, types, doc: vDoc });
		} else if (vbody.type === "field_declaration_list") {
			const fields: RustField[] = [];
			for (const f of vbody.namedChildren) {
				if (!f || f.type !== "field_declaration") continue;
				const fnameNode = f.childForFieldName("name");
				const ftypeNode = f.childForFieldName("type");
				const fname = fnameNode?.text;
				if (!fname || !ftypeNode) continue;
				fields.push({
					name: fname,
					type: parseRustType(ftypeNode),
					pub: isPub(f),
				});
			}
			variants.push({ kind: "struct", name: vname, fields, doc: vDoc });
		} else {
			variants.push({ kind: "unit", name: vname, doc: vDoc });
		}
	}

	return {
		ok: true,
		value: {
			kind: "enum",
			name,
			variants,
			...parseAttrs(attrs),
			doc,
			pub: isPub(node),
		},
	};
}

/**
 * Find the abi string from an `extern_modifier` descendant. Returns the
 * literal value (e.g., `"C"`, `"system"`), or `"C"` for a bare `extern`
 * (no string), or undefined if no extern modifier is present.
 */
function findExternAbi(node: TSNode): string | undefined {
	function walk(n: TSNode): string | undefined {
		if (n.type === "extern_modifier") {
			for (const cc of n.namedChildren) {
				if (cc?.type === "string_literal") {
					return cc.text.replace(/^"|"$/g, "");
				}
			}
			return "C"; // bare `extern fn` defaults to ABI "C"
		}
		for (const c of n.namedChildren) {
			if (!c) continue;
			// Only descend into modifier-related nodes to keep this cheap.
			if (
				c.type === "function_modifiers" ||
				c.type === "extern_modifier" ||
				c.type === "foreign_mod_item"
			) {
				const r = walk(c);
				if (r) return r;
			}
		}
		return undefined;
	}
	return walk(node);
}

function handleFunction(
	node: TSNode,
	doc: string | undefined,
	scopePrefix: string,
	overrideAbi?: string,
): Handle<RustItem> {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return { ok: false, name: "<anon>", reason: "no name" };
	const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

	if (node.childForFieldName("type_parameters")) {
		return { ok: false, name: qName, reason: "generic function" };
	}

	// Detect `extern "C"` (or other ABI) modifier directly on the function
	// (not just on a surrounding foreign_mod_item). Tree-sitter exposes it
	// nested as: `function_modifiers > extern_modifier > string_literal`.
	const abi = overrideAbi ?? findExternAbi(node);

	const params = node.childForFieldName("parameters");
	const args: { name?: string; type: RustType }[] = [];
	if (params) {
		for (const p of params.namedChildren) {
			if (!p) continue;
			if (p.type !== "parameter") continue;
			const nameNode = p.childForFieldName("pattern");
			const typeNode = p.childForFieldName("type");
			if (!typeNode) continue;
			const argName =
				nameNode && nameNode.type === "identifier"
					? nameNode.text
					: undefined;
			args.push({ name: argName, type: parseRustType(typeNode) });
		}
	}

	// Missing `-> Type` in Rust means unit `()`. Map to `{ unsupported, raw: "()" }`
	// at IR level — the emitter normalizes that to schema-pop's `Field { kind: "unit" }`.
	const returnTypeNode = node.childForFieldName("return_type");
	const returnType: RustType = returnTypeNode
		? parseRustType(returnTypeNode)
		: { kind: "unsupported", raw: "()" };

	return {
		ok: true,
		value: {
			kind: "function",
			name,
			args,
			returnType,
			abi,
			doc,
			pub: isPub(node),
		},
	};
}

function handleAlias(
	node: TSNode,
	_attrs: string[],
	doc: string | undefined,
	scopePrefix: string,
): Handle<RustItem> {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return { ok: false, name: "<anon>", reason: "no name" };
	const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

	if (node.childForFieldName("type_parameters")) {
		return { ok: false, name: qName, reason: "generic alias" };
	}

	const typeNode = node.childForFieldName("type");
	if (!typeNode) return { ok: false, name: qName, reason: "no type" };
	const t = parseRustType(typeNode);
	return {
		ok: true,
		value: { kind: "alias", name, type: t, doc, pub: isPub(node) },
	};
}

function parseRustType(node: TSNode): RustType {
	switch (node.type) {
		case "primitive_type": {
			const n = node.text;
			if (PRIMITIVE_NAMES.has(n as RustPrimitive)) {
				return { kind: "primitive", name: n as RustPrimitive };
			}
			// usize/isize/char/str — not part of our binary subset.
			return { kind: "unsupported", raw: n };
		}
		case "type_identifier": {
			const n = node.text;
			if (n === "String") return { kind: "string" };
			return { kind: "ref", name: n };
		}
		case "array_type": {
			const itemNode = node.childForFieldName("element");
			const lenNode = node.childForFieldName("length");
			if (!itemNode || !lenNode) {
				return { kind: "unsupported", raw: node.text };
			}
			const item = parseRustType(itemNode);
			const lenText = lenNode.text;
			const len = parseInt(lenText, 10);
			if (Number.isNaN(len)) {
				return { kind: "unsupported", raw: node.text };
			}
			return { kind: "array", item, len };
		}
		case "generic_type": {
			const typeNode = node.childForFieldName("type");
			const argsNode = node.childForFieldName("type_arguments");
			const baseName = typeNode?.text ?? "";
			const args = argsNode
				? argsNode.namedChildren.filter((c) => c && c.type !== "lifetime")
				: [];
			if (baseName === "Option" && args.length === 1) {
				return { kind: "option", inner: parseRustType(args[0]!) };
			}
			if (baseName === "Vec" && args.length === 1) {
				return { kind: "vec", item: parseRustType(args[0]!) };
			}
			return { kind: "unsupported", raw: node.text };
		}
		case "reference_type":
		case "pointer_type":
		case "tuple_type":
		case "function_type":
		case "dynamic_type":
			return { kind: "unsupported", raw: node.text };
		default:
			return { kind: "unsupported", raw: node.text };
	}
}
