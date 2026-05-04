import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IREnumVariant, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkScalaOptions {
	extraKnownNames?: readonly string[];
}

const SCALA_PRIMITIVES: Record<string, IRType> = {
	Byte: { kind: "primitive", name: "i8" },
	Short: { kind: "primitive", name: "i16" },
	Int: { kind: "primitive", name: "i32" },
	Long: { kind: "primitive", name: "i64" },
	Float: { kind: "primitive", name: "f32" },
	Double: { kind: "primitive", name: "f64" },
	Boolean: { kind: "primitive", name: "bool" },
	Char: { kind: "primitive", name: "u16" },
	String: { kind: "string" },
};

export function walkScalaFile(tree: Tree, sourcePath: string, opts: WalkScalaOptions = {}): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let pendingDoc: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "comment") {
					const text = child.text.trim();
					if (text.startsWith("/**")) {
						const m = text.match(/^\/\*\*([\s\S]*?)\*\/$/);
						if (m && m[1]) pendingDoc.push(stripStarLines(m[1]));
					} else if (text.startsWith("//")) {
						pendingDoc.push(text.replace(/^\/\/\s?/, ""));
					}
					continue;
				}

				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];

				if (child.type === "class_definition" || child.type === "object_definition") {
					const item = handleClass(child, description);
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
	return block.split("\n").map(l => l.replace(/^\s*\*\s?/, "")).join("\n").trim();
}

function isPublic(node: TSNode): boolean {
	const text = node.text;
	return !text.includes("private ") && !text.includes("protected ");
}

function handleClass(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c.type === "identifier");
	const name = nameNode?.text;
	if (!name || !isPublic(node)) return null;

	const fields: IRField[] = [];
	
	const params = node.childForFieldName("class_parameters") || node.namedChildren.find(n => n.type === "class_parameters");
	if (params) {
		for (const p of params.namedChildren) {
			if (p.type === "class_parameter") {
				if (!isPublic(p)) continue;
				const pName = p.childForFieldName("name") || p.namedChildren.find(n => n.type === "identifier");
				const pType = p.childForFieldName("type") || p.namedChildren.find(n => n.type === "type_identifier" || n.type === "generic_type");
				if (pName && pType) {
					fields.push({
						name: pName.text,
						type: parseScalaType(pType),
						pub: true
					});
				}
			}
		}
	}

	const body = node.childForFieldName("body") || node.namedChildren.find(n => n.type === "template_body");
	if (body) {
		let fieldDoc: string[] = [];
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				const text = c.text.trim();
				if (text.startsWith("/**")) {
					const m = text.match(/^\/\*\*([\s\S]*?)\*\/$/);
					if (m && m[1]) fieldDoc.push(stripStarLines(m[1]));
				} else if (text.startsWith("//")) {
					fieldDoc.push(text.replace(/^\/\/\s?/, ""));
				}
				continue;
			}
			if (c.type === "val_declaration" || c.type === "var_declaration") {
				if (!isPublic(c)) {
					fieldDoc = [];
					continue;
				}
				const pName = c.childForFieldName("name") || c.namedChildren.find(n => n.type === "identifier");
				const pType = c.childForFieldName("type") || c.namedChildren.find(n => n.type === "type_identifier" || n.type === "generic_type");
				if (pName && pType) {
					fields.push({
						name: pName.text,
						type: parseScalaType(pType),
						description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
						pub: true
					});
				}
			}
			fieldDoc = [];
		}
	}

	return { kind: "struct", name, fields, description, pub: true };
}

function parseScalaType(node: TSNode): IRType {
	const text = node.text;
	const prim = SCALA_PRIMITIVES[text];
	if (prim) return prim;

	const genericMatch = text.match(/^([A-Za-z0-9_]+)\[(.+)\]$/);
	if (genericMatch) {
		const base = genericMatch[1];
		const inner = genericMatch[2];
		if (base === "Array" || base === "List" || base === "Seq") {
			return { kind: "array", item: parseScalaType({ text: inner } as TSNode) };
		}
		if (base === "Option") {
			return { kind: "optional", inner: parseScalaType({ text: inner } as TSNode) };
		}
	}

	return { kind: "ref", name: text };
}
