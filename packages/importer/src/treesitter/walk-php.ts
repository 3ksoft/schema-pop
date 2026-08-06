import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, WalkResult } from "../toolkit";

export interface WalkPhpOptions {
	extraKnownNames?: readonly string[];
}

const PHP_PRIMITIVES: Record<string, string> = {
	int: "i64",
	float: "f64",
	boolean: "boolean",
};

export class PhpImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "PHP",
		supportedExtensions: [".php"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode, "");
		return this.finalize();
	}

	private visit(node: TSNode, currentNamespace: string): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}
			if (child.type === "attribute_list") {
				continue;
			}

			const description = this.docs.consume();

			if (child.type === "namespace_definition") {
				const nameNode = child.childForFieldName("name");
				const body = child.childForFieldName("body");
				const ns = nameNode?.text ?? "";
				if (body) {
					const newNs = currentNamespace ? `${currentNamespace}\\${ns}` : ns;
					this.visit(body, newNs);
				} else {
					currentNamespace = currentNamespace
						? `${currentNamespace}\\${ns}`
						: ns;
				}
			} else if (child.type === "class_declaration") {
				this.handleClass(child, description, currentNamespace);
			} else if (child.type === "enum_declaration") {
				this.handleEnum(child, description, currentNamespace);
			} else {
				this.visit(child, currentNamespace);
			}
		}
	}

	private handleClass(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) return;
		const qName = scopePrefix ? `${scopePrefix}\\${name}` : name;

		const body = node.childForFieldName("body");
		if (!body) return;

		const fields: Record<string, PopType> = {};

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				this.docs.addCommentNode(c.text);
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
					this.docs.clear();
					continue;
				}

				const typeNode = c.childForFieldName("type");
				const baseType = typeNode
					? this.parsePhpType(typeNode)
					: ({ type: "any", originalType: "mixed" } as PopType);

				for (const elem of c.namedChildren) {
					if (elem && elem.type === "property_element") {
						const varName = elem.namedChildren[0];
						const propName =
							elem.childForFieldName("name")?.text?.replace(/^\$/, "") ??
							varName?.namedChildren[0]?.text ??
							varName?.text?.replace(/^\$/, "");

						if (propName) {
							const fDoc = this.docs.consume();
							const fType = { ...baseType };
							if (fDoc) fType.description = fDoc;
							fields[propName] = fType;
						}
					}
				}
			}
			this.docs.clear();
		}

		this.addItem(
			qName,
			{ type: "object", typeString: name, fields } as PopType,
			description,
		);
	}

	private handleEnum(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) return;
		const qName = scopePrefix ? `${scopePrefix}\\${name}` : name;

		const body = node.childForFieldName("body");
		if (!body) return;

		const options: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type === "enum_case") {
				const vname = c.childForFieldName("name")?.text;
				if (vname) {
					options.push(vname);
				}
			}
			this.docs.clear();
		}

		this.addItem(
			qName,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private parsePhpType(node: TSNode): PopType {
		if (node.type === "optional_type") {
			const inner = node.namedChild(0);
			const innerType = inner
				? this.parsePhpType(inner)
				: ({ type: "any", originalType: "mixed" } as PopType);
			(innerType as any).required = false;
			return innerType;
		}
		if (node.type === "union_type") {
			return { type: "any", originalType: node.text } as PopType;
		}
		if (node.type === "named_type") {
			const text = node.text;
			if (text === "string") return { type: "string" } as PopType;
			const prim = PHP_PRIMITIVES[text];
			if (prim) {
				if (prim === "boolean")
					return { type: "boolean", binaryType: "boolean" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: text } as PopType;
		}
		if (node.type === "primitive_type") {
			if (node.text === "string") return { type: "string" } as PopType;
			const prim = PHP_PRIMITIVES[node.text];
			if (prim) {
				if (prim === "boolean")
					return { type: "boolean", binaryType: "boolean" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "any", originalType: node.text } as PopType;
		}
		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkPhpFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkPhpOptions = {},
): WalkResult {
	const importer = new PhpImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
