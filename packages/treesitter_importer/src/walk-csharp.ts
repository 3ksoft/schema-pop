import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IREnumVariant, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkCSharpOptions {
	extraKnownNames?: readonly string[];
}

const CS_PRIMITIVES: Record<string, IRType> = {
	byte: { kind: "primitive", name: "u8" },
	sbyte: { kind: "primitive", name: "i8" },
	short: { kind: "primitive", name: "i16" },
	ushort: { kind: "primitive", name: "u16" },
	int: { kind: "primitive", name: "i32" },
	uint: { kind: "primitive", name: "u32" },
	long: { kind: "primitive", name: "i64" },
	ulong: { kind: "primitive", name: "u64" },
	float: { kind: "primitive", name: "f32" },
	double: { kind: "primitive", name: "f64" },
	bool: { kind: "primitive", name: "bool" },
	char: { kind: "primitive", name: "u16" },
	string: { kind: "string" },
};

export function walkCSharpFile(tree: Tree, sourcePath: string, opts: WalkCSharpOptions = {}): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let currentNamespace = "";
		let pendingDoc: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "comment") {
					const text = child.text.trim();
					if (text.startsWith("///")) {
						const content = text.replace(/^\/\/\/\s*(<[^>]+>)?/, "").replace(/(<\/[^>]+>)?$/, "").trim();
						if (content && !content.startsWith("<")) {
							pendingDoc.push(content);
						}
					} else if (text.startsWith("//")) {
						pendingDoc.push(text.replace(/^\/\/\s?/, ""));
					} else if (text.startsWith("/*")) {
						const m = text.match(/^\/\*+([\s\S]*?)\*+\/$/);
						if (m && m[1]) {
							const lines = m[1].split("\n").map(l => l.replace(/^\s*\*?\s?/, "").trim()).filter(Boolean);
							pendingDoc.push(...lines);
						}
					}
					continue;
				}

				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];

				if (child.type === "namespace_declaration" || child.type === "file_scoped_namespace_declaration") {
					const nameNode = child.childForFieldName("name") || child.namedChildren.find(c => c.type === "identifier" || c.type === "qualified_name");
					const ns = nameNode?.text ?? "";
					const body = child.childForFieldName("body") || child.namedChildren.find(c => c.type === "declaration_list");
					
					const oldNs = currentNamespace;
					currentNamespace = oldNs ? `${oldNs}.${ns}` : ns;
					
					if (body) {
						walk(body);
					} else if (child.type === "file_scoped_namespace_declaration") {
						for (let i = 0; i < child.namedChildCount; i++) {
							const c = child.namedChild(i);
							if (c && c.type !== "identifier" && c.type !== "qualified_name" && c.type !== "comment") {
								walk({ namedChildren: [c] } as any);
							}
						}
					}
					currentNamespace = oldNs;
				} else if (child.type === "class_declaration" || child.type === "struct_declaration" || child.type === "record_declaration" || child.type === "record_struct_declaration") {
					const item = handleClass(child, description, currentNamespace);
					if (item) items.push(item);
				} else if (child.type === "enum_declaration") {
					const item = handleEnum(child, description, currentNamespace);
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

function hasModifier(node: TSNode, mod: string): boolean {
	const modifiers = node.childForFieldName("modifiers") || node.namedChildren.find(n => n.type === "modifier_list");
	if (modifiers) {
		return modifiers.namedChildren.some(m => m?.text === mod);
	}
	return node.namedChildren.some(m => m?.type === "modifier" && m.text === mod);
}

function handleClass(node: TSNode, description: string | undefined, scopePrefix: string): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c.type === "identifier");
	const name = nameNode?.text;
	if (!name) return null;
	const qName = scopePrefix ? `${scopePrefix}.${name}` : name;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];

	const params = node.childForFieldName("parameters") || node.namedChildren.find(n => n.type === "parameter_list");
	if (params) {
		for (const p of params.namedChildren) {
			if (p?.type === "parameter") {
				const pName = p.childForFieldName("name") || p.namedChildren.find(n => n.type === "identifier");
				const pType = p.childForFieldName("type") || p.namedChildren.find(n => n.type !== "identifier" && n.type !== "modifier" && n.type !== "attribute_list");
				if (pName && pType) {
					fields.push({
						name: pName.text,
						type: parseCSharpType(pType),
						pub: true
					});
				}
			}
		}
	}

	const body = node.childForFieldName("body") || node.namedChildren.find(n => n.type === "declaration_list");
	if (body) {
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				fieldDoc.push(c.text.replace(/^\/\/\/?\s*(<[^>]+>)?/, "").replace(/(<\/[^>]+>)?$/, "").trim());
				continue;
			}
			if (c.type === "property_declaration") {
				if (!hasModifier(c, "public")) { fieldDoc = []; continue; }
				const tNode = c.childForFieldName("type") || c.namedChildren.find(n => n.type !== "modifier" && n.type !== "identifier" && n.type !== "accessor_list");
				const nNode = c.childForFieldName("name") || c.namedChildren.find(n => n.type === "identifier");
				if (tNode && nNode) {
					fields.push({
						name: nNode.text,
						type: parseCSharpType(tNode),
						description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
						pub: true
					});
				}
			} else if (c.type === "field_declaration") {
				if (!hasModifier(c, "public")) { fieldDoc = []; continue; }
				const decl = c.childForFieldName("declaration") || c.namedChildren.find(n => n.type === "variable_declaration");
				if (decl) {
					const tNode = decl.childForFieldName("type") || decl.namedChildren.find(n => n.type !== "variable_declarator");
					const vars = decl.namedChildren.filter(n => n.type === "variable_declarator");
					for (const v of vars) {
						const nNode = v.childForFieldName("name") || v.namedChildren.find(n => n.type === "identifier");
						if (tNode && nNode) {
							fields.push({
								name: nNode.text,
								type: parseCSharpType(tNode),
								description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
								pub: true
							});
						}
					}
				}
			}
			fieldDoc = [];
		}
	}

	return { kind: "struct", name: qName, fields, description, pub: true };
}

function handleEnum(node: TSNode, description: string | undefined, scopePrefix: string): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c.type === "identifier");
	const name = nameNode?.text;
	if (!name) return null;
	const qName = scopePrefix ? `${scopePrefix}.${name}` : name;

	const body = node.childForFieldName("body") || node.namedChildren.find(n => n.type === "enum_member_declaration_list");
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	let variantDoc: string[] = [];
	
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			variantDoc.push(c.text.replace(/^\/\/\/?\s*(<[^>]+>)?/, "").replace(/(<\/[^>]+>)?$/, "").trim());
			continue;
		}
		if (c.type === "enum_member_declaration") {
			const mName = c.childForFieldName("name") || c.namedChildren.find(n => n.type === "identifier");
			if (mName) {
				variants.push({
					kind: "unit",
					name: mName.text,
					description: variantDoc.length ? variantDoc.join("\n") : undefined
				});
			}
		}
		variantDoc = [];
	}

	return { kind: "enum", name: qName, variants, description, pub: true };
}

function parseCSharpType(node: TSNode): IRType {
	if (node.type === "nullable_type") {
		const inner = node.childForFieldName("type") || node.namedChildren[0];
		return { kind: "optional", inner: inner ? parseCSharpType(inner) : { kind: "unknown", raw: "any" } };
	}
	if (node.type === "array_type") {
		const inner = node.childForFieldName("type") || node.namedChildren[0];
		return { kind: "array", item: inner ? parseCSharpType(inner) : { kind: "unknown", raw: "any" } };
	}
	if (node.type === "generic_name") {
		const name = node.namedChildren.find(c => c.type === "identifier")?.text;
		const args = node.childForFieldName("type_arguments") || node.namedChildren.find(c => c.type === "type_argument_list");
		if (args && (name === "List" || name === "IEnumerable" || name === "IReadOnlyList" || name === "IList")) {
			const inner = args.namedChildren.find(c => c.type !== "comment" && c.type !== "punctuation");
			if (inner) return { kind: "array", item: parseCSharpType(inner) };
		}
		return { kind: "unknown", raw: node.text };
	}
	if (node.type === "predefined_type" || node.type === "identifier" || node.type === "qualified_name") {
		const text = node.text.split(".").pop()!;
		const prim = CS_PRIMITIVES[text];
		if (prim) return prim;
		return { kind: "ref", name: node.text };
	}
	return { kind: "unknown", raw: node.text };
}
