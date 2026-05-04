import type {
	IREnumVariant,
	IRField,
	IRItem,
	IRType,
	SchemaPopIR,
} from "schema-pop";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkObjcOptions {
	extraKnownNames?: readonly string[];
}

const OBJC_PRIMITIVES: Record<string, IRType> = {
	int: { kind: "primitive", name: "i32" },
	NSInteger: { kind: "primitive", name: "i64" },
	NSUInteger: { kind: "primitive", name: "u64" },
	float: { kind: "primitive", name: "f32" },
	CGFloat: { kind: "primitive", name: "f64" },
	double: { kind: "primitive", name: "f64" },
	BOOL: { kind: "primitive", name: "bool" },
	char: { kind: "primitive", name: "i8" },
	NSString: { kind: "string" },
};

export function walkObjcFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkObjcOptions = {},
): SchemaPopIR {
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
					} else if (text.startsWith("///")) {
						pendingDoc.push(text.replace(/^\/\/\/\s?/, ""));
					}
					continue;
				}

				const description = pendingDoc.length
					? pendingDoc.join("\n")
					: undefined;
				pendingDoc = [];

				if (child.type === "class_interface") {
					const item = handleInterface(child, description);
					if (item) items.push(item);
				} else if (child.type === "enum_specifier") {
					const item = handleEnum(child, description);
					if (item) items.push(item);
				} else if (child.type === "struct_specifier") {
					// Optional fallback for standard C structs in ObjC context
					const item = handleStruct(child, description);
					if (item) items.push(item);
				} else {
					// In tree-sitter-objc, top-level often wraps things in preproc or macros
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

function handleInterface(
	node: TSNode,
	description: string | undefined,
): IRItem | null {
	const nameNode =
		node.childForFieldName("name") ||
		node.namedChildren.find((c) => c && c.type === "identifier");
	const name = nameNode?.text;
	if (!name) return null;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];

	// In tree-sitter-objc, properties are direct children of class_interface (no body wrapper)
	const bodyChildren =
		node.childForFieldName("body")?.namedChildren ??
		node.namedChildren.find((n) => n?.type === "interface_declaration_list")
			?.namedChildren ??
		node.namedChildren;

	for (const c of bodyChildren) {
		if (!c) continue;
		if (c.type === "comment") {
			const text = c.text.trim();
			if (text.startsWith("/**")) {
				const m = text.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) fieldDoc.push(stripStarLines(m[1]));
			} else if (text.startsWith("///")) {
				fieldDoc.push(text.replace(/^\/\/\/\s?/, ""));
			}
			continue;
		}
		if (c.type === "property_declaration") {
			// ObjC AST: property_declaration → property_attributes_declaration? + struct_declaration
			// struct_declaration → (type_identifier | primitive_type | typedefed_specifier) + struct_declarator
			// struct_declarator → (pointer_declarator → identifier) | identifier directly
			const structDecl = c.namedChildren.find(
				(n) => n?.type === "struct_declaration",
			);
			const typeNode =
				structDecl?.namedChildren.find(
					(n) =>
						n?.type === "type_identifier" ||
						n?.type === "primitive_type" ||
						n?.type === "typedefed_specifier",
				) ??
				c.namedChildren.find(
					(n) =>
						n?.type === "type_identifier" ||
						n?.type === "primitive_type" ||
						n?.type === "typedefed_specifier",
				);
			const structDeclr = structDecl?.namedChildren.find(
				(n) => n?.type === "struct_declarator",
			);
			const ptrDeclr = structDeclr?.namedChildren.find(
				(n) => n?.type === "pointer_declarator",
			);
			const propName =
				ptrDeclr?.namedChildren.find((n) => n?.type === "identifier")?.text ??
				structDeclr?.namedChildren.find((n) => n?.type === "identifier")
					?.text ??
				structDeclr?.text ??
				c.namedChildren.find((n) => n?.type === "identifier")?.text;

			if (typeNode && propName) {
				fields.push({
					name: propName,
					type: parseObjcType(typeNode),
					description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
					pub: true,
				});
			}
		}
		fieldDoc = [];
	}

	return { kind: "struct", name, fields, description, pub: true };
}

function handleStruct(
	node: TSNode,
	description: string | undefined,
): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;

	const fields: IRField[] = [];
	const body =
		node.childForFieldName("body") ||
		node.namedChildren.find((n) => n && n.type === "field_declaration_list");
	if (body) {
		for (const c of body.namedChildren) {
			if (c?.type === "field_declaration") {
				const typeNode = c.childForFieldName("type");
				const declNode =
					c.childForFieldName("declarator") ||
					c.namedChildren.find((n) => n && n.type === "identifier");
				if (typeNode && declNode) {
					fields.push({
						name: declNode.text,
						type: parseObjcType(typeNode),
						pub: true,
					});
				}
			}
		}
	}

	return { kind: "struct", name, fields, description, pub: true };
}

function handleEnum(
	node: TSNode,
	description: string | undefined,
): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;

	const body =
		node.childForFieldName("body") ||
		node.namedChildren.find((n) => n && n.type === "enumerator_list");
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	for (const c of body.namedChildren) {
		if (c?.type === "enumerator") {
			const vname =
				c.childForFieldName("name")?.text || c.text.split("=")[0]?.trim();
			if (vname) {
				variants.push({
					kind: "unit",
					name: vname,
				});
			}
		}
	}

	return { kind: "enum", name, variants, description, pub: true };
}

function parseObjcType(node: TSNode): IRType {
	if (
		node.type === "type_identifier" ||
		node.type === "primitive_type" ||
		node.type === "identifier" ||
		node.type === "typedefed_specifier"
	) {
		const text = node.text;
		const prim = OBJC_PRIMITIVES[text];
		if (prim) return prim;

		if (text === "NSArray" || text === "NSMutableArray") {
			return { kind: "array", item: { kind: "unknown", raw: "id" } };
		}

		return { kind: "ref", name: text };
	}

	// Fallback for generic types (if parser supports them natively for ObjC)
	if (node.type === "generic_type") {
		const name = node.childForFieldName("name")?.text;
		if (name === "NSArray" || name === "NSMutableArray") {
			const args = node.childForFieldName("type_arguments");
			if (args && args.namedChildren.length > 0) {
				const inner = args.namedChildren[0];
				if (inner) return { kind: "array", item: parseObjcType(inner) };
			}
			return { kind: "array", item: { kind: "unknown", raw: "id" } };
		}
	}

	return { kind: "unknown", raw: node.text };
}
