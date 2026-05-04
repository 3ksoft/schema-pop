import type { Node as TSNode, Tree } from "web-tree-sitter";
import type {
	IRField,
	IREnumVariant,
	IRItem,
	SchemaPopIR,
	IRType,
} from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkJavaOptions {
	extraKnownNames?: readonly string[];
}

const JAVA_PRIMITIVES: Record<string, IRType> = {
	byte: { kind: "primitive", name: "i8" },
	short: { kind: "primitive", name: "i16" },
	int: { kind: "primitive", name: "i32" },
	long: { kind: "primitive", name: "i64" },
	float: { kind: "primitive", name: "f32" },
	double: { kind: "primitive", name: "f64" },
	boolean: { kind: "primitive", name: "bool" },
	char: { kind: "primitive", name: "u16" },
	String: { kind: "string" },
};

export function walkJavaFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkJavaOptions = {},
): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let pendingDoc: string[] = [];
		let pendingAttrs: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "block_comment") {
					const t = child.text;
					if (t.startsWith("/**")) {
						const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
						if (m && m[1]) pendingDoc.push(stripStarLines(m[1]));
					}
					continue;
				}
				if (child.type === "line_comment") {
					pendingDoc.push(child.text.replace(/^\/+\s?/, ""));
					continue;
				}
				if (child.type === "modifiers") {
					for (const mod of child.namedChildren) {
						if (!mod) continue;
						if (mod.type === "marker_annotation" || mod.type === "annotation") {
							pendingAttrs.push(mod.text);
						}
					}
					continue;
				}

				const attrs = pendingAttrs;
				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];
				pendingAttrs = [];

				if (
					child.type === "class_declaration" ||
					child.type === "record_declaration"
				) {
					const item = handleClass(child, attrs, description);
					if (item) items.push(item);
				} else if (child.type === "enum_declaration") {
					const item = handleEnum(child, attrs, description);
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

function hasModifier(node: TSNode, mod: string): boolean {
	const mods =
		node.childForFieldName("modifiers") ??
		node.namedChildren.find((c) => c?.type === "modifiers");
	if (!mods) return false;
	return mods.text.includes(mod);
}

function handleClass(
	node: TSNode,
	_attrs: string[],
	description: string | undefined,
): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;

	const fields: IRField[] = [];
	let fieldDoc: string[] = [];

	if (node.type === "record_declaration") {
		const params =
			node.childForFieldName("parameters") ??
			node.namedChildren.find(n => n?.type === "formal_parameters");
		if (params) {
			for (const param of params.namedChildren) {
				if (!param) continue;
				if (param.type === "formal_parameter") {
					// formal_parameter: type node + identifier (name)
					const pType = param.namedChildren.find(n => n?.type !== "identifier");
					const pName = param.namedChildren.find(n => n?.type === "identifier")?.text;
					if (pName && pType) {
						fields.push({ name: pName, type: parseJavaType(pType), pub: true });
					}
				} else if (param.type === "record_declaration_parameter") {
					const pName = param.childForFieldName("name")?.text;
					const pType = param.childForFieldName("type");
					if (pName && pType) {
						fields.push({
							name: pName,
							type: parseJavaType(pType),
							pub: true,
						});
					}
				}
			}
		}
	}

	const body = node.childForFieldName("body");
	if (body) {
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "block_comment" || c.type === "line_comment") {
				const t = c.text;
				if (t.startsWith("/**")) {
					const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
					if (m && m[1]) fieldDoc.push(stripStarLines(m[1]));
				} else if (t.startsWith("//")) {
					fieldDoc.push(t.replace(/^\/+\s?/, ""));
				}
				continue;
			}
			if (c.type === "field_declaration") {
				if (!hasModifier(c, "public")) {
					fieldDoc = [];
					continue;
				}
				const typeNode = c.childForFieldName("type");
				const baseType = typeNode
					? parseJavaType(typeNode)
					: ({ kind: "unknown", raw: "Object" } as IRType);

				for (const decl of c.namedChildren) {
					if (!decl) continue;
					if (decl.type === "variable_declarator") {
						const propName = decl.childForFieldName("name")?.text;
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
	}

	return {
		kind: "struct",
		name,
		fields,
		description,
		pub: true,
	};
}

function handleEnum(
	node: TSNode,
	_attrs: string[],
	description: string | undefined,
): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;

	const body = node.childForFieldName("body");
	if (!body) return null;

	const variants: IREnumVariant[] = [];
	let variantDoc: string[] = [];
	for (const c of body.namedChildren) {
		if (!c) continue;
		if (c.type === "block_comment" || c.type === "line_comment") {
			const t = c.text;
			if (t.startsWith("/**")) {
				const m = t.match(/^\/\*\*([\s\S]*?)\*\/$/);
				if (m && m[1]) variantDoc.push(stripStarLines(m[1]));
			} else if (t.startsWith("//")) {
				variantDoc.push(t.replace(/^\/+\s?/, ""));
			}
			continue;
		}
		if (c.type === "enum_constant") {
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
		name,
		variants,
		description,
		pub: true,
	};
}

function parseJavaType(node: TSNode): IRType {
	if (
		node.type === "integral_type" ||
		node.type === "floating_point_type" ||
		node.type === "boolean_type"
	) {
		const prim = JAVA_PRIMITIVES[node.text];
		if (prim) return prim;
	}
	if (node.type === "type_identifier") {
		const text = node.text;
		const prim = JAVA_PRIMITIVES[text];
		if (prim) return prim;
		return { kind: "ref", name: text };
	}
	if (node.type === "generic_type") {
		// In tree-sitter-java, generic_type children are accessed via namedChildren, not fields
		const name =
			node.childForFieldName("name")?.text ??
			node.namedChildren.find(c => c?.type === "type_identifier")?.text;
		const args =
			node.childForFieldName("type_arguments") ??
			node.namedChildren.find(c => c?.type === "type_arguments");
		if ((name === "List" || name === "ArrayList") && args) {
			const inner = args.namedChildren.find(
				(c) => c && (c.type === "type_identifier" || c.type === "generic_type"),
			);
			if (inner) return { kind: "array", item: parseJavaType(inner) };
		}
		if (name === "Optional" && args) {
			const inner = args.namedChildren.find(
				(c) => c && (c.type === "type_identifier" || c.type === "generic_type"),
			);
			if (inner) return { kind: "optional", inner: parseJavaType(inner) };
		}
		return { kind: "unknown", raw: node.text };
	}
	if (node.type === "array_type") {
		const typeNode = node.childForFieldName("element");
		if (typeNode) {
			return { kind: "array", item: parseJavaType(typeNode) };
		}
	}
	return { kind: "unknown", raw: node.text };
}
