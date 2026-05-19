import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkJavaOptions {
	extraKnownNames?: readonly string[];
}

const JAVA_PRIMITIVES: Record<string, string> = {
	byte: "i8",
	short: "i16",
	int: "i32",
	long: "i64",
	float: "f32",
	double: "f64",
	boolean: "bool",
	char: "u16",
};

export class JavaImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Java",
		supportedExtensions: [".java"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode);
		return this.finalize();
	}

	private visit(node: TSNode): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "block_comment" || child.type === "line_comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}
			if (child.type === "modifiers") {
				continue;
			}

			const description = this.docs.consume();

			if (
				child.type === "class_declaration" ||
				child.type === "record_declaration"
			) {
				this.handleClass(child, description);
			} else if (child.type === "enum_declaration") {
				this.handleEnum(child, description);
			} else {
				this.visit(child);
			}
		}
	}

	private hasModifier(node: TSNode, mod: string): boolean {
		const mods =
			node.childForFieldName("modifiers") ??
			node.namedChildren.find((c) => c?.type === "modifiers");
		if (!mods) return false;
		return mods.text.includes(mod);
	}

	private handleClass(node: TSNode, description: string | undefined): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) return;

		const fields: Record<string, PopType> = {};

		if (node.type === "record_declaration") {
			const params =
				node.childForFieldName("parameters") ??
				node.namedChildren.find((n) => n?.type === "formal_parameters");
			if (params) {
				for (const param of params.namedChildren) {
					if (!param) continue;
					if (param.type === "formal_parameter") {
						const pType = param.namedChildren.find(
							(n) => n?.type !== "identifier",
						);
						const pName = param.namedChildren.find(
							(n) => n?.type === "identifier",
						)?.text;
						if (pName && pType) {
							fields[pName] = this.parseJavaType(pType);
						}
					} else if (param.type === "record_declaration_parameter") {
						const pName = param.childForFieldName("name")?.text;
						const pType = param.childForFieldName("type");
						if (pName && pType) {
							fields[pName] = this.parseJavaType(pType);
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
					this.docs.addCommentNode(c.text);
					continue;
				}
				if (c.type === "field_declaration") {
					if (!this.hasModifier(c, "public")) {
						this.docs.clear();
						continue;
					}
					const typeNode = c.childForFieldName("type");
					const baseType = typeNode
						? this.parseJavaType(typeNode)
						: ({ type: "any", originalType: "Object" } as PopType);

					for (const decl of c.namedChildren) {
						if (!decl) continue;
						if (decl.type === "variable_declarator") {
							const propName = decl.childForFieldName("name")?.text;
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
		}

		this.addItem(
			name,
			{ type: "object", typeString: name, fields } as PopType,
			description,
		);
	}

	private handleEnum(node: TSNode, description: string | undefined): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) return;

		const body = node.childForFieldName("body");
		if (!body) return;

		const options: string[] = [];
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "block_comment" || c.type === "line_comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type === "enum_constant") {
				const vname = c.childForFieldName("name")?.text;
				if (vname) {
					options.push(vname);
				}
			}
			this.docs.clear();
		}

		this.addItem(
			name,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private parseJavaType(node: TSNode): PopType {
		if (
			node.type === "integral_type" ||
			node.type === "floating_point_type" ||
			node.type === "boolean_type"
		) {
			const prim = JAVA_PRIMITIVES[node.text];
			if (prim) {
				if (prim === "bool")
					return { type: "boolean", binaryType: "bool" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
		}
		if (node.type === "type_identifier") {
			const text = node.text;
			if (text === "String") return { type: "string" } as PopType;
			const prim = JAVA_PRIMITIVES[text];
			if (prim) {
				if (prim === "bool")
					return { type: "boolean", binaryType: "bool" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: text } as PopType;
		}
		if (node.type === "generic_type") {
			const name =
				node.childForFieldName("name")?.text ??
				node.namedChildren.find((c) => c?.type === "type_identifier")?.text;
			const args =
				node.childForFieldName("type_arguments") ??
				node.namedChildren.find((c) => c?.type === "type_arguments");
			if ((name === "List" || name === "ArrayList") && args) {
				const inner = args.namedChildren.find(
					(c) =>
						c && (c.type === "type_identifier" || c.type === "generic_type"),
				);
				if (inner)
					return { type: "array", item: this.parseJavaType(inner) } as PopType;
			}
			if (name === "Optional" && args) {
				const inner = args.namedChildren.find(
					(c) =>
						c && (c.type === "type_identifier" || c.type === "generic_type"),
				);
				if (inner) {
					const innerType = this.parseJavaType(inner);
					(innerType as any).required = false;
					return innerType;
				}
			}
			return { type: "any", originalType: node.text } as PopType;
		}
		if (node.type === "array_type") {
			const typeNode = node.childForFieldName("element");
			if (typeNode) {
				return { type: "array", item: this.parseJavaType(typeNode) } as PopType;
			}
		}
		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkJavaFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkJavaOptions = {},
): WalkResult {
	const importer = new JavaImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
