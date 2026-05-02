import type { Node as TSNode, Tree } from "web-tree-sitter";
import type {
	RustField,
	RustItem,
	RustModuleIR,
	RustPrimitive,
	RustType,
	RustEnumVariant,
} from "./ir";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkCOptions {
	/** Extra type names that should resolve as `ref` (not get downgraded
	 *  to `unknown`). Pass keys of any user-supplied extras scope. */
	extraKnownNames?: readonly string[];
}

/**
 * tree-sitter-c walker. Handles three top-level shapes:
 *  1. `typedef struct { ... } Name;`   → struct named `Name`
 *  2. `struct Foo { ... };`            → struct named `Foo`
 *  3. `typedef <type> Name;`           → alias
 *  Same for enum / union (union mapped to struct for layout purposes —
 *  schema-pop doesn't model true unions; they're rare in wire formats).
 *
 * Field type resolution prefers stdint typedefs (`uint32_t`, ...) and
 * unambiguous fixed-width primitives (`float`, `double`, `_Bool`/`bool`).
 * Plain `int`/`long`/`short` are platform-dependent — emitted as
 * `unsupported` with the raw text, so the user can fix the source.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const STDINT_ALIASES: Record<string, RustPrimitive> = {
	uint8_t: "u8",
	uint16_t: "u16",
	uint32_t: "u32",
	uint64_t: "u64",
	int8_t: "i8",
	int16_t: "i16",
	int32_t: "i32",
	int64_t: "i64",
	// fast / least variants — common in headers
	uint_least8_t: "u8",
	uint_least16_t: "u16",
	uint_least32_t: "u32",
	uint_least64_t: "u64",
	uint_fast8_t: "u8",
	uint_fast16_t: "u16",
	uint_fast32_t: "u32",
	uint_fast64_t: "u64",
	int_least8_t: "i8",
	int_least16_t: "i16",
	int_least32_t: "i32",
	int_least64_t: "i64",
	int_fast8_t: "i8",
	int_fast16_t: "i16",
	int_fast32_t: "i32",
	int_fast64_t: "i64",
	float32_t: "f32",
	float64_t: "f64",
};

/**
 * Resolve a `primitive_type` or `sized_type_specifier` text to our IR
 * primitive set. Returns `null` for ambiguous platform-dependent types.
 */
function resolveCPrimitive(text: string): RustPrimitive | null {
	const t = text.replace(/\s+/g, " ").trim();
	switch (t) {
		case "char":
		case "unsigned char":
			return "u8";
		case "signed char":
			return "i8";
		case "unsigned short":
		case "unsigned short int":
			return "u16";
		case "short":
		case "short int":
		case "signed short":
		case "signed short int":
			return "i16";
		case "unsigned long long":
		case "unsigned long long int":
			return "u64";
		case "long long":
		case "long long int":
		case "signed long long":
		case "signed long long int":
			return "i64";
		case "float":
			return "f32";
		case "double":
			return "f64";
		case "_Bool":
		case "bool":
			return "bool";
		// platform-dependent: int / unsigned int / long / unsigned long
		default:
			return null;
	}
}

export function walkCFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkCOptions = {},
): RustModuleIR {
	return walkCLike(tree, sourcePath, { allowClass: false, ...opts });
}

/**
 * Internal entry shared by C and C++ walkers. The C++ walker enables
 * `class_specifier` and `namespace_definition` handling.
 */
export function walkCLike(
	tree: Tree,
	sourcePath: string,
	opts: { allowClass: boolean; extraKnownNames?: readonly string[] },
): RustModuleIR {
	const items: RustItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function visit(node: TSNode, scopePrefix: string) {
		const children = node.namedChildren;
		let pendingDoc: string[] = [];
		let pendingAttrs: string[] = [];

		for (const child of children) {
			if (!child) continue;
			if (child.type === "comment") {
				const t = child.text;
				if (t.startsWith("/**")) {
					const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
					if (m && m[1]) {
						pendingDoc.push(stripStarLines(m[1]));
					}
				} else if (t.startsWith("///")) {
					pendingDoc.push(t.replace(/^\/\/\/\s?/, ""));
				}
				continue;
			}
			if (
				child.type === "preproc_include" ||
				child.type === "preproc_def" ||
				child.type === "preproc_function_def" ||
				child.type === "preproc_if" ||
				child.type === "preproc_ifdef" ||
				child.type === "preproc_call" ||
				child.type === "linkage_specification"
			) {
				if (child.type === "linkage_specification") {
					// `extern "C" { ... }` block — descend into its body so the
					// types inside still get picked up.
					const body = child.childForFieldName("body");
					if (body) visit(body, scopePrefix);
				}
				continue;
			}
			if (child.type === "attribute_declaration") {
				pendingAttrs.push(child.text);
				continue;
			}

			const doc = pendingDoc.length ? pendingDoc.join("\n") : undefined;
			const attrs = pendingAttrs;
			pendingDoc = [];
			pendingAttrs = [];

			if (child.type === "type_definition") {
				handleTypedef(child, doc, scopePrefix, items, skipped, opts);
			} else if (child.type === "declaration") {
				handleBareDeclaration(
					child,
					doc,
					attrs,
					scopePrefix,
					items,
					skipped,
					opts,
				);
			} else if (child.type === "struct_specifier") {
				handleStructSpecifier(child, null, doc, scopePrefix, items, skipped);
			} else if (child.type === "enum_specifier") {
				handleEnumSpecifier(child, null, doc, scopePrefix, items, skipped);
			} else if (child.type === "union_specifier") {
				// Treat union as struct for layout purposes — first field "wins".
				const it = handleUnionSpecifier(
					child,
					null,
					doc,
					scopePrefix,
					skipped,
				);
				if (it) items.push(it);
			} else if (
				opts.allowClass &&
				(child.type === "class_specifier" || child.type === "struct_specifier")
			) {
				handleStructSpecifier(child, null, doc, scopePrefix, items, skipped);
			} else if (opts.allowClass && child.type === "namespace_definition") {
				const nameNode = child.childForFieldName("name");
				const body = child.childForFieldName("body");
				const ns = nameNode?.text ?? "anon";
				if (body)
					visit(body, scopePrefix ? `${scopePrefix}::${ns}` : ns);
			} else if (opts.allowClass && child.type === "alias_declaration") {
				// C++ `using Foo = bar;`
				const nameNode = child.childForFieldName("name");
				const typeNode = child.childForFieldName("type");
				const name = nameNode?.text;
				if (!name || !typeNode) continue;
				items.push({
					kind: "alias",
					name,
					type: parseCType(typeNode),
					doc,
					pub: true,
				});
			}
		}
	}

	visit(tree.rootNode, "");
	// Refs to types not declared in this file (often from `#include`d
	// headers tree-sitter doesn't expand) become `unknown` IR variants
	// preserving the original spelling — keeps the generated scope
	// loadable instead of erroring at scope() time.
	downgradeUnknownRefs(items, opts.extraKnownNames);
	return { source: sourcePath, items, skipped };
}

function stripStarLines(block: string): string {
	return block
		.split("\n")
		.map((l) => l.replace(/^\s*\*\s?/, ""))
		.join("\n")
		.trim();
}

function handleTypedef(
	node: TSNode,
	doc: string | undefined,
	scopePrefix: string,
	items: RustItem[],
	skipped: { name: string; reason: string }[],
	opts: { allowClass: boolean },
) {
	// `type_definition` shape:
	//   typedef <inner-type-spec> <declarator>;
	// The declarator carries the new name (possibly nested in pointer/array
	// declarators).
	const innerType = findFirstChild(node, [
		"struct_specifier",
		"union_specifier",
		"enum_specifier",
		"primitive_type",
		"sized_type_specifier",
		"type_identifier",
	]);
	const decl = findFirstChild(node, [
		"type_identifier",
		"identifier",
		"pointer_declarator",
		"array_declarator",
	]);
	if (!innerType) return;

	// The declarator's name: if `type_identifier`, use it directly; if
	// pointer/array, the typedef target is non-trivial → unsupported.
	let aliasName: string | undefined;
	if (decl?.type === "type_identifier" || decl?.type === "identifier") {
		aliasName = decl.text;
	} else if (decl?.type === "pointer_declarator") {
		const inner = decl.childForFieldName("declarator");
		if (inner?.type === "type_identifier") {
			skipped.push({
				name: inner.text,
				reason: "typedef of pointer type",
			});
		}
		return;
	} else {
		// Look for a type_identifier among trailing named children
		for (let i = node.namedChildCount - 1; i >= 0; i--) {
			const c = node.namedChild(i);
			if (c?.type === "type_identifier" || c?.type === "identifier") {
				aliasName = c.text;
				break;
			}
		}
	}

	if (!aliasName) return;

	// Dispatch on the inner type.
	if (
		innerType.type === "struct_specifier" ||
		(opts.allowClass && innerType.type === "class_specifier")
	) {
		handleStructSpecifier(
			innerType,
			aliasName,
			doc,
			scopePrefix,
			items,
			skipped,
		);
	} else if (innerType.type === "union_specifier") {
		const it = handleUnionSpecifier(
			innerType,
			aliasName,
			doc,
			scopePrefix,
			skipped,
		);
		if (it) items.push(it);
	} else if (innerType.type === "enum_specifier") {
		handleEnumSpecifier(innerType, aliasName, doc, scopePrefix, items, skipped);
	} else {
		// `typedef <primitive|sized|ref> Name;` → alias
		const t = parseCType(innerType);
		items.push({ kind: "alias", name: aliasName, type: t, doc, pub: true });
	}
}

function handleBareDeclaration(
	node: TSNode,
	doc: string | undefined,
	attrs: string[],
	scopePrefix: string,
	items: RustItem[],
	skipped: { name: string; reason: string }[],
	opts: { allowClass: boolean },
) {
	// Patterns we care about: `struct Foo { ... };` or `enum Foo { ... };`
	// without a declarator (no var being declared), or function prototypes
	// like `int do_thing(uint8_t x);`.
	if (node.namedChildren.some((c) => c?.type === "init_declarator")) return;

	const fnDecl = findNestedFunctionDeclarator(node);
	if (fnDecl) {
		const fn = handleFunctionPrototype(node, fnDecl, doc, scopePrefix, skipped);
		if (fn) items.push(fn);
		return;
	}

	for (const c of node.namedChildren) {
		if (!c) continue;
		if (c.type === "struct_specifier") {
			handleStructSpecifier(c, null, doc, scopePrefix, items, skipped);
			markPacked(items, attrs);
		} else if (c.type === "enum_specifier") {
			handleEnumSpecifier(c, null, doc, scopePrefix, items, skipped);
		} else if (c.type === "union_specifier") {
			const it = handleUnionSpecifier(c, null, doc, scopePrefix, skipped);
			if (it) items.push(it);
		} else if (opts.allowClass && c.type === "class_specifier") {
			handleStructSpecifier(c, null, doc, scopePrefix, items, skipped);
		}
	}
}

/**
 * Walk inwards from a `declaration` node to find a `function_declarator`,
 * possibly wrapped in pointer/parenthesized declarators. Returns null if
 * the declaration isn't a function prototype.
 */
function findNestedFunctionDeclarator(decl: TSNode): TSNode | null {
	for (const c of decl.namedChildren) {
		if (!c) continue;
		if (c.type === "function_declarator") return c;
		if (c.type === "pointer_declarator" || c.type === "parenthesized_declarator") {
			const inner = c.childForFieldName("declarator");
			if (inner?.type === "function_declarator") return inner;
		}
	}
	return null;
}

function handleFunctionPrototype(
	declNode: TSNode,
	fnDecl: TSNode,
	doc: string | undefined,
	_scopePrefix: string,
	skipped: { name: string; reason: string }[],
): RustItem | null {
	// Skip definitions with body — we want prototypes only (typical in headers).
	// Note: `function_definition` is its own top-level node; `declaration` here
	// means just the prototype.
	const nameNode = fnDecl.childForFieldName("declarator");
	const name = nameNode?.text;
	if (!name || /[*&]/.test(name)) {
		// Function pointer typedef or pointer-to-function — skip for MVP.
		skipped.push({
			name: name ?? "<anon>",
			reason: "function pointer / complex declarator",
		});
		return null;
	}

	// Return type lives in the `type` field of the declaration node.
	const returnTypeNode = declNode.childForFieldName("type");
	const returnType: RustType = returnTypeNode
		? parseCType(returnTypeNode)
		: { kind: "unsupported", raw: "void" };

	const params = fnDecl.childForFieldName("parameters");
	const args: { name?: string; type: RustType }[] = [];
	if (params) {
		for (const p of params.namedChildren) {
			if (!p) continue;
			if (p.type !== "parameter_declaration") continue;
			const ptype = p.childForFieldName("type");
			const pdecl = p.childForFieldName("declarator");
			if (!ptype) continue;
			let argName: string | undefined;
			if (pdecl?.type === "identifier") argName = pdecl.text;
			else if (pdecl?.type === "pointer_declarator") {
				// `const char *name` — for MVP we emit the pointer as unsupported
				// but still record the arg name so it appears in docs.
				const inner = pdecl.childForFieldName("declarator");
				if (inner?.type === "identifier") argName = inner.text;
			}
			args.push({ name: argName, type: parseCType(ptype) });
		}
	}

	// `void` as a sole arg means "no args" in C — strip it.
	if (
		args.length === 1 &&
		args[0]!.type.kind === "unsupported" &&
		args[0]!.type.raw === "void" &&
		!args[0]!.name
	) {
		args.length = 0;
	}

	return {
		kind: "function",
		name,
		args,
		returnType,
		// C convention: cdecl by default; we leave abi unset and let consumers
		// assume the platform default. Future: pull from `__attribute__((stdcall))`.
		doc,
		pub: true,
	};
}

function markPacked(items: RustItem[], attrs: string[]) {
	if (attrs.length === 0 || items.length === 0) return;
	const last = items[items.length - 1];
	if (!last) return;
	if (last.kind !== "struct" && last.kind !== "enum") return;
	if (attrs.some((a) => /\bpacked\b/.test(a))) {
		last.repr = [...(last.repr ?? []), "packed"];
	}
}

function handleStructSpecifier(
	node: TSNode,
	typedefName: string | null,
	doc: string | undefined,
	scopePrefix: string,
	items: RustItem[],
	skipped: { name: string; reason: string }[],
) {
	// Templates → skipped (C++).
	if (node.parent?.type === "template_declaration") {
		skipped.push({
			name: typedefName ?? node.childForFieldName("name")?.text ?? "<anon>",
			reason: "template type",
		});
		return;
	}
	const tagName = node.childForFieldName("name")?.text;
	const name = typedefName ?? tagName;
	if (!name) return; // anonymous, no typedef name → can't address

	// `struct Foo;` (forward-decl, no body) — skip silently.
	const body = node.childForFieldName("body");
	if (!body) return;

	const qName = scopePrefix ? `${scopePrefix}::${name}` : name;
	const fields: RustField[] = [];
	let fieldDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			const t = c.text;
			if (t.startsWith("/**")) {
				const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) fieldDoc.push(stripStarLines(m[1]));
			} else if (t.startsWith("///")) {
				fieldDoc.push(t.replace(/^\/\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type === "access_specifier") {
			// In C++ classes/structs — we treat the access kind as a soft
			// filter: stop emitting once we hit `private:` / `protected:`.
			// Actual heuristic: we skip non-`public:` regions until next
			// access flips back. For simplicity: if private/protected → bail.
			const access = c.text.replace(":", "").trim();
			if (access === "private" || access === "protected") {
				// Stop processing fields: subsequent fields are private.
				break;
			}
			continue;
		}
		if (c.type !== "field_declaration") continue;
		const f = parseFieldDeclaration(c);
		if (f) {
			f.doc = fieldDoc.length ? fieldDoc.join("\n") : f.doc;
			fields.push(f);
		} else {
			// Bitfield, function pointer, or other unsupported shape.
			const fname = c.childForFieldName("declarator")?.text ?? "<unknown>";
			skipped.push({
				name: `${qName}.${fname}`,
				reason: "unsupported field shape",
			});
		}
		fieldDoc = [];
	}

	items.push({
		kind: "struct",
		name,
		fields,
		doc,
		pub: true,
	});
}

function handleEnumSpecifier(
	node: TSNode,
	typedefName: string | null,
	doc: string | undefined,
	_scopePrefix: string,
	items: RustItem[],
	_skipped: { name: string; reason: string }[],
) {
	const tagName = node.childForFieldName("name")?.text;
	const name = typedefName ?? tagName;
	const body = node.childForFieldName("body");
	if (!name || !body) return;

	const variants: RustEnumVariant[] = [];
	let pendingDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			const t = c.text;
			if (t.startsWith("/**")) {
				const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) pendingDoc.push(stripStarLines(m[1]));
			} else if (t.startsWith("///")) {
				pendingDoc.push(t.replace(/^\/\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type !== "enumerator") continue;
		const vname = c.childForFieldName("name")?.text ?? c.text.split("=")[0]!.trim();
		variants.push({
			kind: "unit",
			name: vname,
			doc: pendingDoc.length ? pendingDoc.join("\n") : undefined,
		});
		pendingDoc = [];
	}

	items.push({
		kind: "enum",
		name,
		variants,
		doc,
		pub: true,
	});
}

function handleUnionSpecifier(
	node: TSNode,
	typedefName: string | null,
	_doc: string | undefined,
	_scopePrefix: string,
	skipped: { name: string; reason: string }[],
): RustItem | null {
	const tagName = node.childForFieldName("name")?.text;
	const name = typedefName ?? tagName;
	if (!name) return null;
	skipped.push({
		name,
		reason: "C union (raw — schema-pop has no native union mapping)",
	});
	// Optional: emit as struct with all fields anyway? For MVP skip emitting
	// to avoid silently mis-modelling overlapping memory.
	return null;
}

function parseFieldDeclaration(node: TSNode): RustField | null {
	// Skip if this is a function pointer declarator or has bitfield_clause.
	if (
		node.namedChildren.some(
			(c) =>
				c?.type === "function_declarator" || c?.type === "bitfield_clause",
		)
	) {
		return null;
	}

	const typeNode = node.childForFieldName("type");
	const declNode = node.childForFieldName("declarator");
	if (!typeNode || !declNode) return null;

	// Pointer → unsupported in binary mode.
	if (declNode.type === "pointer_declarator") {
		return null;
	}

	let baseType = parseCType(typeNode);

	let name: string | undefined;
	if (declNode.type === "field_identifier") {
		name = declNode.text;
	} else if (declNode.type === "array_declarator") {
		const r = parseArrayDeclarator(declNode, baseType);
		if (!r) return null;
		baseType = r.type;
		name = r.name;
	}
	if (!name) return null;

	return { name, type: baseType, pub: true };
}

function parseArrayDeclarator(
	node: TSNode,
	baseType: RustType,
): { name: string; type: RustType } | null {
	// Possibly nested for multi-dim arrays: int x[3][4]; we read inside-out.
	const inner = node.childForFieldName("declarator");
	const sizeNode = node.childForFieldName("size");
	if (!inner || !sizeNode) return null;
	const sizeText = sizeNode.text;
	const len = parseInt(sizeText, 10);
	if (Number.isNaN(len)) return null;

	if (inner.type === "field_identifier" || inner.type === "identifier") {
		return { name: inner.text, type: { kind: "array", item: baseType, len } };
	}
	if (inner.type === "array_declarator") {
		const sub = parseArrayDeclarator(inner, baseType);
		if (!sub) return null;
		return { name: sub.name, type: { kind: "array", item: sub.type, len } };
	}
	return null;
}

/** Map a textual type name to a known primitive, or `null` if not known. */
function resolveTextToPrimitive(text: string): RustPrimitive | null {
	return STDINT_ALIASES[text] ?? resolveCPrimitive(text) ?? null;
}

function parseCType(node: TSNode): RustType {
	switch (node.type) {
		case "type_descriptor": {
			// C++ wraps the type in `type_descriptor` for `using ... = T`. Unwrap.
			const inner =
				node.childForFieldName("type") ??
				node.namedChildren.find((c): c is TSNode => !!c && c.type !== "type_qualifier") ??
				null;
			if (inner) return parseCType(inner);
			return { kind: "unsupported", raw: node.text };
		}
		case "primitive_type":
		case "sized_type_specifier": {
			const text = node.text;
			const prim = resolveTextToPrimitive(text);
			if (prim) return { kind: "primitive", name: prim };
			return { kind: "unsupported", raw: text };
		}
		case "type_identifier": {
			// Tree-sitter classifies some names (`_Bool`, custom typedefs) as
			// type_identifier; check the primitive table here too before
			// treating it as a user type reference.
			const text = node.text;
			const prim = resolveTextToPrimitive(text);
			if (prim) return { kind: "primitive", name: prim };
			return { kind: "ref", name: text };
		}
		case "struct_specifier":
		case "enum_specifier":
		case "union_specifier": {
			// Inline anonymous → unsupported (we don't emit anonymous types).
			const tag = node.childForFieldName("name")?.text;
			if (tag) return { kind: "ref", name: tag };
			return { kind: "unsupported", raw: node.text };
		}
		case "qualified_identifier": {
			// C++: `ns::Foo` — keep last segment for now (schema-pop output is
			// flat at scope level).
			const parts = node.text.split("::");
			const last = parts[parts.length - 1]!;
			const stdint = STDINT_ALIASES[last];
			if (stdint) return { kind: "primitive", name: stdint };
			return { kind: "ref", name: last };
		}
		default:
			return { kind: "unsupported", raw: node.text };
	}
}

function findFirstChild(node: TSNode, types: string[]): TSNode | null {
	for (const c of node.namedChildren) {
		if (c && types.includes(c.type)) return c;
	}
	return null;
}
