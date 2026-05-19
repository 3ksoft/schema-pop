import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkKotlinOptions {
	extraKnownNames?: readonly string[];
}

const KOTLIN_PRIMITIVES: Record<string, string> = {
	Byte: "i8",
	Short: "i16",
	Int: "i32",
	Long: "i64",
	Float: "f32",
	Double: "f64",
	Boolean: "bool",
	Char: "u16",
};

export class KotlinImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Kotlin",
		supportedExtensions: [".kt"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode, "");
		return this.finalize();
	}

	private visit(node: TSNode, currentPackage: string): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "package_header") {
				const ident =
					child.childForFieldName("identifier") ||
					child.namedChildren.find((c) => c && c.type === "identifier");
				if (ident) currentPackage = ident.text;
				continue;
			}

			if (child.type === "comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}

			if (child.type === "annotation") {
				continue;
			}

			const description = this.docs.consume();

			if (
				child.type === "class_declaration" ||
				child.type === "object_declaration"
			) {
				const isEnum = child.namedChildren.some(
					(c) => c?.type === "enum_class_body",
				);

				if (isEnum) {
					this.handleEnum(child, description, currentPackage);
				} else {
					this.handleClass(child, description, currentPackage);
				}
			} else {
				this.visit(child, currentPackage);
			}
		}
	}

	private isPublic(node: TSNode): boolean {
		const mods =
			node.childForFieldName("modifiers") ||
			node.namedChildren.find((n) => n && n.type === "modifiers");
		if (!mods) return true;
		const text = mods.text;
		return (
			!text.includes("private") &&
			!text.includes("protected") &&
			!text.includes("internal")
		);
	}

	private handleClass(
		node: TSNode,
		description: string | undefined,
		pkg: string,
	): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find(
				(c) =>
					c && (c.type === "simple_identifier" || c.type === "type_identifier"),
			);
		const name = nameNode?.text;
		if (!name) return;
		const qName = pkg ? `${pkg}.${name}` : name;

		if (!this.isPublic(node)) return;

		const fields: Record<string, PopType> = {};

		const primaryConstructor =
			node.childForFieldName("primary_constructor") ||
			node.namedChildren.find((n) => n && n.type === "primary_constructor");
		if (primaryConstructor) {
			for (const param of primaryConstructor.namedChildren) {
				if (!param || param.type !== "class_parameter") continue;
				const hasValVar = param.namedChildren.some(
					(n) => n?.type === "binding_pattern_kind",
				);
				if (!hasValVar) continue;
				const pName =
					param.childForFieldName("name") ??
					param.namedChildren.find((n) => n?.type === "simple_identifier");
				const pType =
					param.childForFieldName("type") ??
					param.namedChildren.find(
						(n) =>
							n &&
							(n.type === "user_type" ||
								n.type === "type_identifier" ||
								n.type === "nullable_type"),
					);
				if (pName && pType) {
					fields[pName.text] = this.parseKotlinType(pType);
				}
			}
		}

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find((n) => n && n.type === "class_body");
		if (body) {
			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "comment") {
					this.docs.addCommentNode(c.text);
					continue;
				}
				if (c.type === "property_declaration") {
					if (!this.isPublic(c)) {
						this.docs.clear();
						continue;
					}
					const varDecl =
						c.childForFieldName("variable_declaration") ||
						c.namedChildren.find((n) => n && n.type === "variable_declaration");
					if (varDecl) {
						const nNode =
							varDecl.childForFieldName("name") ||
							varDecl.namedChildren.find(
								(n) => n && n.type === "simple_identifier",
							);
						const tNode =
							varDecl.childForFieldName("type") ||
							varDecl.namedChildren.find(
								(n) =>
									n &&
									(n.type === "type_identifier" ||
										n.type === "user_type" ||
										n.type === "nullable_type"),
							);
						if (nNode && tNode) {
							const fDoc = this.docs.consume();
							const fType = this.parseKotlinType(tNode);
							if (fDoc) fType.description = fDoc;
							fields[nNode.text] = fType;
						}
					}
				}
				this.docs.clear();
			}
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
		pkg: string,
	): void {
		const nameNode =
			node.childForFieldName("name") ??
			node.namedChildren.find(
				(c) =>
					c && (c.type === "simple_identifier" || c.type === "type_identifier"),
			);
		const name = nameNode?.text;
		if (!name) return;
		const qName = pkg ? `${pkg}.${name}` : name;

		if (!this.isPublic(node)) return;

		const body =
			node.childForFieldName("body") ??
			node.namedChildren.find((n) => n && n.type === "enum_class_body");
		if (!body) return;

		const options: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type === "enum_entry") {
				const mName =
					c.childForFieldName("name") ||
					c.namedChildren.find((n) => n && n.type === "simple_identifier");
				if (mName) {
					options.push(mName.text);
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

	private parseKotlinType(node: TSNode): PopType {
		if (node.type === "nullable_type") {
			const inner = node.namedChildren[0];
			const innerType = inner
				? this.parseKotlinType(inner)
				: ({ type: "any", originalType: "Any" } as PopType);
			(innerType as any).required = false;
			return innerType;
		}
		if (
			node.type === "user_type" ||
			node.type === "type_identifier" ||
			node.type === "simple_identifier"
		) {
			const ident =
				node.childForFieldName("name") ||
				node.namedChildren.find(
					(c) =>
						c &&
						(c.type === "simple_identifier" || c.type === "type_identifier"),
				) ||
				node;
			const text = ident.text;

			if (text === "String") return { type: "string" } as PopType;

			const args =
				node.childForFieldName("type_arguments") ||
				node.namedChildren.find((c) => c && c.type === "type_arguments");
			if (
				args &&
				(text === "List" ||
					text === "MutableList" ||
					text === "Array" ||
					text === "Collection")
			) {
				const proj = args.namedChildren.find(
					(c) => c && c.type === "type_projection",
				);
				const innerTypeNode = proj?.namedChildren[0];
				if (innerTypeNode) {
					return {
						type: "array",
						item: this.parseKotlinType(innerTypeNode),
					} as PopType;
				}
			}

			const prim = KOTLIN_PRIMITIVES[text];
			if (prim) {
				if (prim === "bool")
					return { type: "boolean", binaryType: "bool" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}

			if (text.endsWith("Array") && text !== "Array") {
				const base = text.replace("Array", "");
				const bPrim = KOTLIN_PRIMITIVES[base];
				if (bPrim) {
					const itemType =
						bPrim === "bool"
							? { type: "boolean", binaryType: "bool" }
							: { type: "number", binaryType: bPrim };
					return { type: "array", item: itemType } as PopType;
				}
			}

			return { type: "link", target: text } as PopType;
		}
		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkKotlinFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkKotlinOptions = {},
): WalkResult {
	const importer = new KotlinImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
