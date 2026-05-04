import type { Node as TSNode, Tree } from "web-tree-sitter";
import type {
	IRField,
	IREnumVariant,
	IRItem,
	SchemaPopIR,
	IRType,
} from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkPhpOptions {
	extraKnownNames?: readonly string[];
}

const PHP_PRIMITIVES: Record<string, IRType> = {
	int: { kind: "primitive", name: "i64" },
	float: { kind: "primitive", name: "f64" },
	bool: { kind: "primitive", name: "bool" },
	string: { kind: "string" },
};

export function walkPhpFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkPhpOptions = {},
): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let currentNamespace = "";
		let pendingDoc: string[] = [];
		let pendingAttrs: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
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
				if (child.type === "attribute_list") {
					pendingAttrs.push(child.text);
					continue;
				}

				const attrs = pendingAttrs;
				const description = pendingDoc.length
					? pendingDoc.join("\n")
					: undefined;
				pendingDoc = [];
				pendingAttrs = [];

				if (child.type === "namespace_definition") {
					const nameNode = child.childForFieldName("name");
					const body = child.childForFieldName("body");
					const ns = nameNode?.text ?? "";
					if (body) {
						const oldNs = currentNamespace;
						currentNamespace = oldNs ? `${oldNs}\\${ns}` : ns;
						walk(body);
						currentNamespace = oldNs;
					} else {
						currentNamespace = currentNamespace
							? `${currentNamespace}\\${ns}`
							: ns;
					}
				} else if (child.type === "class_declaration") {
					const item = handleClass(child, attrs, description, currentNamespace);
					if (item) items.push(item);
				} else if (child.type === "enum_declaration") {
					const item = handleEnum(child, attrs, description, currentNamespace);
					if (item) items.push(item);
				} else {
					walk(child);
				}
			}
		}
		walk(node);
	}

	traverse(tree.rootNode);

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

function handleClass(
	node: TSNode,
	_attrs: string[],
	description: string | undefined,
	scopePrefix: string,
): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;
	const qName = scopePrefix ? `${scopePrefix}\\${name}` : name;

	const body = node.childForFieldName("body");
	if (!body) return null;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			if (c.text.startsWith("/**")) {
				const m = c.text.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) fieldDoc.push(stripStarLines(m[1]));
			} else if (c.text.startsWith("//")) {
				fieldDoc.push(c.text.replace(/^\/+\s?/, ""));
			}
			continue;
		}
		if (c.type === "property_declaration") {
			const isPublic = c.namedChildren.some(
				(m) =>
					m &&
					(m.type === "visibility_modifier" ||
						m.type === "readonly_modifier") &&
					m.text.includes("public"),
			);
			if (!isPublic) {
				fieldDoc = [];
				continue;
			}

			const typeNode = c.childForFieldName("type");
			const baseType = typeNode
				? parsePhpType(typeNode)
				: ({ kind: "unknown", raw: "mixed" } as IRType);

			for (const elem of c.namedChildren) {
				if (elem && elem.type === "property_element") {
					// property_element → variable_name → name (text without $)
					const varName = elem.namedChildren[0];
					const propName =
						elem.childForFieldName("name")?.text?.replace(/^\$/, "") ??
						varName?.namedChildren[0]?.text ??
						varName?.text?.replace(/^\$/, "");
					if (propName) {
						fields.push({
							name: propName,
							type: baseType,
							description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
							pub: true,
						});
					}
				}
			}
		}
		fieldDoc = [];
	}

	return {
		kind: "struct",
		name: qName,
		fields,
		description,
		pub: true,
	};
}

function handleEnum(
	node: TSNode,
	_attrs: string[],
	description: string | undefined,
	scopePrefix: string,
): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;
	const qName = scopePrefix ? `${scopePrefix}\\${name}` : name;

	const body = node.childForFieldName("body");
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	let variantDoc: string[] = [];

	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			if (c.text.startsWith("/**")) {
				const m = c.text.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) variantDoc.push(stripStarLines(m[1]));
			} else if (c.text.startsWith("//")) {
				variantDoc.push(c.text.replace(/^\/+\s?/, ""));
			}
			continue;
		}
		if (c.type === "enum_case") {
			const vname = c.childForFieldName("name")?.text;
			if (vname) {
				variants.push({
					kind: "unit",
					name: vname,
					description: variantDoc.length ? variantDoc.join("\n") : undefined,
				});
			}
		}
		variantDoc = [];
	}

	return {
		kind: "enum",
		name: qName,
		variants,
		description,
		pub: true,
	};
}

function parsePhpType(node: TSNode): IRType {
	if (node.type === "optional_type") {
		const inner = node.namedChild(0);
		return {
			kind: "optional",
			inner: inner ? parsePhpType(inner) : { kind: "unknown", raw: "mixed" },
		};
	}
	if (node.type === "union_type") {
		return { kind: "unknown", raw: node.text };
	}
	if (node.type === "named_type") {
		const text = node.text;
		const prim = PHP_PRIMITIVES[text];
		if (prim) return prim;
		return { kind: "ref", name: text };
	}
	if (node.type === "primitive_type") {
		const prim = PHP_PRIMITIVES[node.text];
		if (prim) return prim;
		return { kind: "unknown", raw: node.text };
	}
	return { kind: "unknown", raw: node.text };
}
