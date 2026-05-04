import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IREnumVariant, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkKotlinOptions {
	extraKnownNames?: readonly string[];
}

const KOTLIN_PRIMITIVES: Record<string, IRType> = {
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

export function walkKotlinFile(tree: Tree, sourcePath: string, opts: WalkKotlinOptions = {}): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let currentPackage = "";
		let pendingDoc: string[] = [];
		let pendingAttrs: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "package_header") {
					const ident = child.childForFieldName("identifier") || child.namedChildren.find(c => c && c.type === "identifier");
					if (ident) currentPackage = ident.text;
					continue;
				}

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

				if (child.type === "annotation") {
					pendingAttrs.push(child.text);
					continue;
				}

				const attrs = pendingAttrs;
				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];
				pendingAttrs = [];

				if (child.type === "class_declaration" || child.type === "object_declaration") {
					const isEnum = child.namedChildren.some(c => c?.type === "enum_class_body");
					
					if (isEnum) {
						const item = handleEnum(child, attrs, description, currentPackage);
						if (item) items.push(item);
					} else {
						const item = handleClass(child, attrs, description, currentPackage);
						if (item) items.push(item);
					}
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
	const mods = node.childForFieldName("modifiers") || node.namedChildren.find(n => n && n.type === "modifiers");
	if (!mods) return true; // Public by default in Kotlin
	const text = mods.text;
	return !text.includes("private") && !text.includes("protected") && !text.includes("internal");
}

function handleClass(node: TSNode, _attrs: string[], description: string | undefined, pkg: string): IRItem | null {
	const nameNode = node.childForFieldName("name") || node.namedChildren.find(c => c && (c.type === "simple_identifier" || c.type === "type_identifier"));
	const name = nameNode?.text;
	if (!name) return null;
	const qName = pkg ? `${pkg}.${name}` : name;

	if (!isPublic(node)) return null;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];

	// Extract from primary constructor
	const primaryConstructor = node.childForFieldName("primary_constructor") || node.namedChildren.find(n => n && n.type === "primary_constructor");
	if (primaryConstructor) {
		for (const param of primaryConstructor.namedChildren) {
			if (!param || param.type !== "class_parameter") continue;
			const hasValVar = param.namedChildren.some(n => n?.type === "binding_pattern_kind");
			if (!hasValVar) continue;
			const pName = param.childForFieldName("name") ?? param.namedChildren.find(n => n?.type === "simple_identifier");
			const pType = param.childForFieldName("type") ?? param.namedChildren.find(n => n && (n.type === "user_type" || n.type === "type_identifier" || n.type === "nullable_type"));
			if (pName && pType) {
				fields.push({ name: pName.text, type: parseKotlinType(pType), pub: true });
			}
		}
	}

	// Extract from class body
	const body = node.childForFieldName("body") || node.namedChildren.find(n => n && n.type === "class_body");
	if (body) {
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
			if (c.type === "property_declaration") {
				if (!isPublic(c)) {
					fieldDoc = [];
					continue;
				}
				const varDecl = c.childForFieldName("variable_declaration") || c.namedChildren.find(n => n && n.type === "variable_declaration");
				if (varDecl) {
					const nNode = varDecl.childForFieldName("name") || varDecl.namedChildren.find(n => n && n.type === "simple_identifier");
					const tNode = varDecl.childForFieldName("type") || varDecl.namedChildren.find(n => n && (n.type === "type_identifier" || n.type === "user_type" || n.type === "nullable_type"));
					if (nNode && tNode) {
						fields.push({
							name: nNode.text,
							type: parseKotlinType(tNode),
							description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
							pub: true
						});
					}
				}
			}
			fieldDoc = [];
		}
	}

	return { kind: "struct", name: qName, fields, description, pub: true };
}

function handleEnum(node: TSNode, _attrs: string[], description: string | undefined, pkg: string): IRItem | null {
	const nameNode =
		node.childForFieldName("name") ??
		node.namedChildren.find(c => c && (c.type === "simple_identifier" || c.type === "type_identifier"));
	const name = nameNode?.text;
	if (!name) return null;
	const qName = pkg ? `${pkg}.${name}` : name;

	if (!isPublic(node)) return null;

	const body =
		node.childForFieldName("body") ??
		node.namedChildren.find(n => n && n.type === "enum_class_body");
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	let variantDoc: string[] = [];

	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			const text = c.text.trim();
			if (text.startsWith("/**")) {
				const m = text.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) variantDoc.push(stripStarLines(m[1]));
			} else if (text.startsWith("//")) {
				variantDoc.push(text.replace(/^\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type === "enum_entry") {
			const mName = c.childForFieldName("name") || c.namedChildren.find(n => n && n.type === "simple_identifier");
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

function parseKotlinType(node: TSNode): IRType {
	if (node.type === "nullable_type") {
		const inner = node.namedChildren[0];
		return { kind: "optional", inner: inner ? parseKotlinType(inner) : { kind: "unknown", raw: "Any" } };
	}
	if (node.type === "user_type" || node.type === "type_identifier" || node.type === "simple_identifier") {
		const ident = node.childForFieldName("name") || node.namedChildren.find(c => c && (c.type === "simple_identifier" || c.type === "type_identifier")) || node;
		const text = ident.text;
		
		// Handles Generics: List<String>
		const args = node.childForFieldName("type_arguments") || node.namedChildren.find(c => c && c.type === "type_arguments");
		if (args && (text === "List" || text === "MutableList" || text === "Array" || text === "Collection")) {
			const proj = args.namedChildren.find(c => c && c.type === "type_projection");
			const innerTypeNode = proj?.namedChildren[0];
			if (innerTypeNode) {
				return { kind: "array", item: parseKotlinType(innerTypeNode) };
			}
		}

		// Primitives
		if (KOTLIN_PRIMITIVES[text]) return KOTLIN_PRIMITIVES[text];

		// Specialized primitive arrays: IntArray, ByteArray
		if (text.endsWith("Array") && text !== "Array") {
			const base = text.replace("Array", "");
			if (KOTLIN_PRIMITIVES[base]) {
				return { kind: "array", item: KOTLIN_PRIMITIVES[base] };
			}
		}

		return { kind: "ref", name: text };
	}
	return { kind: "unknown", raw: node.text };
}
