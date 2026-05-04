import type { Node as TSNode, Tree } from "web-tree-sitter";
import type {
	IRField,
	IREnumVariant,
	IRItem,
	SchemaPopIR,
	IRType,
} from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkPythonOptions {
	extraKnownNames?: readonly string[];
}

const PYTHON_PRIMITIVES: Record<string, IRType> = {
	int: { kind: "primitive", name: "i64" },
	float: { kind: "primitive", name: "f64" },
	bool: { kind: "primitive", name: "bool" },
	str: { kind: "string" },
	bytes: { kind: "array", item: { kind: "primitive", name: "u8" } },
};

export function walkPythonFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkPythonOptions = {},
): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let pendingDoc: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "expression_statement") {
					const stringNode = child.namedChildren[0];
					if (child.namedChildren.length === 1 && stringNode?.type === "string") {
						const text = stringNode.text.replace(/^["']{3}|["']{3}$/g, "").trim();
						if (text) pendingDoc.push(text);
						continue;
					}
				}

				if (child.type === "comment") {
					pendingDoc.push(child.text.replace(/^#\s?/, ""));
					continue;
				}

				const description = pendingDoc.length ? pendingDoc.join("\n") : undefined;
				pendingDoc = [];

				if (child.type === "class_definition") {
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

function handleClass(node: TSNode, description: string | undefined): IRItem | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;

	let isEnum = false;
	const supers = node.childForFieldName("superclasses");
	if (supers) {
		const superTexts = supers.namedChildren.map((c) => c?.text);
		if (superTexts.some((t) => t && (t.includes("Enum") || t.includes("IntEnum")))) {
			isEnum = true;
		}
	}

	const body = node.childForFieldName("body");
	if (!body) return null;

	if (isEnum) {
		const variants: IREnumVariant[] = [];
		let variantDoc: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "expression_statement") {
				const stringNode = c.namedChildren[0];
				if (c.namedChildren.length === 1 && stringNode?.type === "string") {
					const text = stringNode.text.replace(/^["']{3}|["']{3}$/g, "").trim();
					if (text) variantDoc.push(text);
					continue;
				}

				const assign = c.namedChildren.find((n) => n?.type === "assignment");
				if (assign) {
					const left = assign.childForFieldName("left") || assign.namedChildren[0];
					if (left) {
						variants.push({
							kind: "unit",
							name: left.text,
							description: variantDoc.length ? variantDoc.join("\n") : undefined,
						});
					}
				}
				variantDoc = [];
			} else if (c.type === "comment") {
				variantDoc.push(c.text.replace(/^#\s?/, ""));
			}
		}

		return {
			kind: "enum",
			name,
			variants,
			description,
			pub: true,
		};
	} else {
		const fields: IRField[] = [];
		let fieldDoc: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "expression_statement") {
				const stringNode = c.namedChildren[0];
				if (c.namedChildren.length === 1 && stringNode?.type === "string") {
					const text = stringNode.text.replace(/^["']{3}|["']{3}$/g, "").trim();
					if (text) fieldDoc.push(text);
					continue;
				}

				let nameNode: TSNode | null = null;
				let typeNode: TSNode | null = null;

				const assign = c.namedChildren.find((n) => n?.type === "assignment");
				if (assign) {
					nameNode = assign.childForFieldName("left") || assign.namedChildren[0] || null;
					typeNode = assign.childForFieldName("type") || assign.namedChildren.find((n) => n?.type === "type") || null;
				} else {
					// Plain PEP 526 variable annotation without assignment
					typeNode = c.namedChildren.find((n) => n?.type === "type") || null;
					if (typeNode) {
						nameNode = c.namedChildren[0] || null;
					}
				}

				if (nameNode && typeNode) {
					fields.push({
						name: nameNode.text,
						type: parsePythonType(typeNode),
						description: fieldDoc.length ? fieldDoc.join("\n") : undefined,
						pub: true,
					});
				}
				fieldDoc = [];
			} else if (c.type === "comment") {
				fieldDoc.push(c.text.replace(/^#\s?/, ""));
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
}

function parsePythonType(node: TSNode): IRType {
	if (node.type === "type") {
		const inner = node.namedChildren[0];
		if (inner) return parsePythonType(inner);
	}

	if (node.type === "index") {
		const inner = node.namedChildren[0];
		if (inner) return parsePythonType(inner);
	}

	if (node.type === "identifier" || node.type === "none") {
		const text = node.text;
		if (text === "None") return { kind: "unknown", raw: "None" };
		const prim = PYTHON_PRIMITIVES[text];
		if (prim) return prim;
		return { kind: "ref", name: text };
	}

	if (node.type === "subscript") {
		const value = node.childForFieldName("value");
		const name = value?.text;

		// Subscript values in python are commonly under an 'index' node wrapper
		const subs = node.namedChildren.filter((n) => n && n !== value);
		const firstSub = subs[0];

		if (firstSub && name) {
			if (name === "list" || name === "List" || name === "Sequence") {
				return { kind: "array", item: parsePythonType(firstSub) };
			}
			if (name === "Optional") {
				return { kind: "optional", inner: parsePythonType(firstSub) };
			}
		}
		return { kind: "unknown", raw: node.text };
	}

	if (node.type === "binary_operator") {
		const left = node.childForFieldName("left");
		const right = node.childForFieldName("right");
		const op = node.childForFieldName("operator")?.text;
		if (op === "|") {
			if (right?.text === "None") {
				return { kind: "optional", inner: parsePythonType(left!) };
			}
			if (left?.text === "None") {
				return { kind: "optional", inner: parsePythonType(right!) };
			}
		}
	}

	return { kind: "unknown", raw: node.text };
}
