import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IREnumVariant, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkDartOptions {
	extraKnownNames?: readonly string[];
}

const DART_PRIMITIVES: Record<string, IRType> = {
	int: { kind: "primitive", name: "i64" },
	double: { kind: "primitive", name: "f64" },
	bool: { kind: "primitive", name: "bool" },
	String: { kind: "string" },
};

export function walkDartFile(tree: Tree, sourcePath: string, opts: WalkDartOptions = {}): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let pendingDoc: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "documentation_comment" || child.type === "comment") {
					const text = child.text.trim();
					if (text.startsWith("///")) {
						pendingDoc.push(text.replace(/^\/\/\/\s?/, ""));
					} else if (text.startsWith("//")) {
						pendingDoc.push(text.replace(/^\/\/\s?/, ""));
					}
					continue;
				}

				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];

				if (child.type === "class_definition") {
					const item = handleClass(child, description);
					if (item) items.push(item);
				} else if (child.type === "enum_declaration") {
					const item = handleEnum(child, description);
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

function isPublic(name: string): boolean {
	return !name.startsWith("_");
}

function handleClass(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c.type === "identifier");
	const name = nameNode?.text;
	if (!name || !isPublic(name)) return null;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];

	const body = node.childForFieldName("body") || node.namedChildren.find(n => n.type === "class_body");
	if (body) {
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "documentation_comment" || c.type === "comment") {
				const text = c.text.trim();
				if (text.startsWith("///")) {
					fieldDoc.push(text.replace(/^\/\/\/\s?/, ""));
				}
				continue;
			}
			if (c.type === "declaration") {
				const typeNode = c.childForFieldName("type") || c.namedChildren.find(n => n.type === "type_identifier" || n.type === "builtin_type");
				const idents = c.namedChildren.filter(n => n.type === "identifier" || n.type === "declared_identifier");
				
				for (const ident of idents) {
					const pName = ident.text.replace(/\=.*$/, "").trim(); // strip initializer if parsed together
					if (pName && isPublic(pName) && typeNode) {
						fields.push({
							name: pName,
							type: parseDartType(typeNode),
							description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
							pub: true
						});
					}
				}
			}
			fieldDoc = [];
		}
	}

	return { kind: "struct", name, fields, description, pub: true };
}

function handleEnum(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c.type === "identifier");
	const name = nameNode?.text;
	if (!name || !isPublic(name)) return null;

	const body = node.childForFieldName("body") || node.namedChildren.find(n => n.type === "enum_body");
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	let variantDoc: string[] = [];

	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "documentation_comment" || c.type === "comment") {
			const text = c.text.trim();
			if (text.startsWith("///")) {
				variantDoc.push(text.replace(/^\/\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type === "enum_constant") {
			const vname = c.childForFieldName("name")?.text || c.namedChildren.find(n => n.type === "identifier")?.text;
			if (vname && isPublic(vname)) {
				variants.push({
					kind: "unit",
					name: vname,
					description: variantDoc.length ? variantDoc.join("\n") : undefined
				});
			}
			variantDoc = [];
		}
	}

	return { kind: "enum", name, variants, description, pub: true };
}

function parseDartType(node: TSNode): IRType {
	let text = node.text;
	const isOptional = text.endsWith("?");
	if (isOptional) text = text.slice(0, -1);

	let type: IRType = { kind: "unknown", raw: text };
	
	const prim = DART_PRIMITIVES[text];
	if (prim) {
		type = prim;
	} else if (text.startsWith("List<") && text.endsWith(">")) {
		const inner = text.slice(5, -1);
		type = { kind: "array", item: parseDartType({ text: inner } as TSNode) };
	} else {
		type = { kind: "ref", name: text };
	}

	if (isOptional) return { kind: "optional", inner: type };
	return type;
}
