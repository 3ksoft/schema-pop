import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IREnumVariant, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkSwiftOptions {
	extraKnownNames?: readonly string[];
}

const SWIFT_PRIMITIVES: Record<string, IRType> = {
	Int8: { kind: "primitive", name: "i8" },
	Int16: { kind: "primitive", name: "i16" },
	Int32: { kind: "primitive", name: "i32" },
	Int64: { kind: "primitive", name: "i64" },
	Int: { kind: "primitive", name: "i64" },
	UInt8: { kind: "primitive", name: "u8" },
	UInt16: { kind: "primitive", name: "u16" },
	UInt32: { kind: "primitive", name: "u32" },
	UInt64: { kind: "primitive", name: "u64" },
	UInt: { kind: "primitive", name: "u64" },
	Float: { kind: "primitive", name: "f32" },
	Double: { kind: "primitive", name: "f64" },
	Bool: { kind: "primitive", name: "bool" },
	String: { kind: "string" },
};

export function walkSwiftFile(tree: Tree, sourcePath: string, opts: WalkSwiftOptions = {}): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let pendingDoc: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "comment") {
					const text = child.text.trim();
					if (text.startsWith("///")) {
						pendingDoc.push(text.replace(/^\/\/\/\s?/, ""));
					} else if (text.startsWith("/**")) {
						const m = text.match(/^\/\*\*([\s\S]*?)\*\/$/);
						if (m && m[1]) pendingDoc.push(stripStarLines(m[1]));
					}
					continue;
				}

				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];

				if (child.type === "class_declaration" || child.type === "struct_declaration") {
					// Swift enums are class_declaration with enum_class_body
					const isEnum = child.namedChildren.some(n => n?.type === "enum_class_body");
					const item = isEnum ? handleEnum(child, description) : handleStruct(child, description);
					if (item) items.push(item);
				} else if (child.type === "enum_declaration") {
					const item = handleEnum(child, description);
					if (item) items.push(item);
				} else if (child.type === "typealias_declaration") {
					const item = handleAlias(child, description);
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
	const modifiers = node.namedChildren.filter(n => n && (n.type === "modifiers" || n.type === "visibility_modifier"));
	for (const mod of modifiers) {
		if (mod && (mod.text.includes("private") || mod.text.includes("fileprivate"))) return false;
	}
	return true;
}

function handleStruct(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c && c.type === "type_identifier");
	const name = nameNode?.text;
	if (!name) return null;

	if (!isPublic(node)) return null;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];

	const body = node.childForFieldName("body") || node.namedChildren.find(n => n && (n.type === "class_body" || n.type === "struct_body"));
	if (body) {
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				const text = c.text.trim();
				if (text.startsWith("///")) {
					fieldDoc.push(text.replace(/^\/\/\/\s?/, ""));
				}
				continue;
			}
			if (c.type === "declaration" || c.type === "property_declaration") {
				if (!isPublic(c)) {
					fieldDoc = [];
					continue;
				}
				// Swift AST: property_declaration → value_binding_pattern, pattern, type_annotation
				const patternNode = c.namedChildren.find(n => n?.type === "pattern");
				const typeAnnotation = c.namedChildren.find(n => n?.type === "type_annotation");
				const pName = patternNode?.namedChildren.find(n => n?.type === "simple_identifier") ?? patternNode;
				const pType = typeAnnotation?.namedChildren[0] ?? typeAnnotation;
				if (pName && pType) {
					fields.push({
						name: pName.text,
						type: parseSwiftType(pType),
						description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
						pub: true,
					});
				}
			}
			fieldDoc = [];
		}
	}
	return { kind: "struct", name, fields, description, pub: true };
}

function handleEnum(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c && c.type === "type_identifier");
	const name = nameNode?.text;
	if (!name) return null;

	if (!isPublic(node)) return null;

	// Swift: enum body is enum_class_body; entries are enum_entry nodes directly
	const body =
		node.childForFieldName("body") ??
		node.namedChildren.find(n => n && (n.type === "enum_class_body" || n.type === "enum_body"));
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	let variantDoc: string[] = [];

	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			const text = c.text.trim();
			if (text.startsWith("///")) variantDoc.push(text.replace(/^\/\/\/\s?/, ""));
			continue;
		}
		if (c.type === "enum_entry") {
			const ident = c.namedChildren.find(n => n?.type === "simple_identifier") ?? c;
			variants.push({
				kind: "unit",
				name: ident.text,
				description: variantDoc.length ? variantDoc.join("\n") : undefined,
			});
		}
		variantDoc = [];
	}

	return { kind: "enum", name, variants, description, pub: true };
}

function handleAlias(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c && c.type === "type_identifier");
	const name = nameNode?.text;
	if (!name) return null;

	const typeNode = node.childForFieldName("type") || node.namedChildren.find(c => c && c.type !== "type_identifier" && c.type !== "comment" && c.type !== "typealias");
	if (!typeNode) return null;

	return {
		kind: "alias",
		name,
		type: parseSwiftType(typeNode),
		description,
		pub: true
	};
}

function parseSwiftType(node: TSNode): IRType {
	// Handle structural AST nodes first
	if (node.type === "optional_type") {
		const inner = node.namedChildren[0];
		return { kind: "optional", inner: inner ? parseSwiftType(inner) : { kind: "unknown", raw: "Any" } };
	}
	if (node.type === "array_type") {
		const item = node.namedChildren[0];
		return { kind: "array", item: item ? parseSwiftType(item) : { kind: "unknown", raw: "Any" } };
	}
	if (node.type === "user_type") {
		const ident = node.namedChildren.find(n => n?.type === "type_identifier");
		const text = ident?.text ?? node.text;
		const args = node.namedChildren.find(n => n?.type === "type_arguments");
		if (args) {
			const inner = args.namedChildren.find(n => n?.type === "user_type" || n?.type === "type_identifier");
			if ((text === "Optional") && inner) return { kind: "optional", inner: parseSwiftType(inner) };
			if ((text === "Array") && inner) return { kind: "array", item: parseSwiftType(inner) };
		}
		if (SWIFT_PRIMITIVES[text]) return SWIFT_PRIMITIVES[text];
		return { kind: "ref", name: text };
	}
	if (node.type === "type_identifier") {
		if (SWIFT_PRIMITIVES[node.text]) return SWIFT_PRIMITIVES[node.text];
		return { kind: "ref", name: node.text };
	}
	// Fallback: text-based parsing for alias targets etc.
	const text = node.text.replace(/^:\s*/, "");
	if (SWIFT_PRIMITIVES[text]) return SWIFT_PRIMITIVES[text];
	if (text.endsWith("?")) {
		const inner = text.slice(0, -1);
		return { kind: "optional", inner: parseSwiftType({ text: inner, type: "type_identifier" } as TSNode) };
	}
	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1);
		return { kind: "array", item: parseSwiftType({ text: inner, type: "type_identifier" } as TSNode) };
	}
	return { kind: "ref", name: text };
}
