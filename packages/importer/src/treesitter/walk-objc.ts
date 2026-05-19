import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkObjcOptions {
	extraKnownNames?: readonly string[];
}

const OBJC_PRIMITIVES: Record<string, string> = {
	int: "i32",
	NSInteger: "i64",
	NSUInteger: "u64",
	float: "f32",
	CGFloat: "f64",
	double: "f64",
	BOOL: "bool",
	char: "i8",
};

export class ObjcImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Objective-C",
		supportedExtensions: [".h", ".m"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode);
		return this.finalize();
	}

	private visit(node: TSNode): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}

			const description = this.docs.consume();

			if (child.type === "class_interface") {
				this.handleInterface(child, description);
			} else if (child.type === "enum_specifier") {
				this.handleEnum(child, description);
			} else if (child.type === "struct_specifier") {
				this.handleStruct(child, description);
			} else {
				this.visit(child);
			}
		}
	}

	private handleInterface(node: TSNode, description: string | undefined): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "identifier");
		const name = nameNode?.text;
		if (!name) return;

		const fields: Record<string, PopType> = {};

		const bodyChildren =
			node.childForFieldName("body")?.namedChildren ??
			node.namedChildren.find((n) => n?.type === "interface_declaration_list")
				?.namedChildren ??
			node.namedChildren;

		for (const c of bodyChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type === "property_declaration") {
				const isTypeNode = (n: TSNode | null | undefined) =>
					!!n &&
					(n.type === "type_identifier" ||
						n.type === "primitive_type" ||
						n.type === "typedefed_specifier" ||
						n.type === "BOOL" ||
						n.type === "sized_type_specifier");
				const typeNode = c.namedChildren.find(isTypeNode);
				let propName: string | undefined;
				for (const n of c.namedChildren) {
					if (!n) continue;
					if (n.type === "identifier") {
						propName = n.text;
						break;
					}
					if (n.type === "pointer_declarator") {
						const inner = n.namedChildren.find(
							(x) => x?.type === "identifier",
						);
						if (inner) {
							propName = inner.text;
							break;
						}
					}
				}

				if (typeNode && propName) {
					const fDoc = this.docs.consume();
					const fType = this.parseObjcType(typeNode);
					if (fDoc) fType.description = fDoc;
					fields[propName] = fType;
				}
			}
			this.docs.clear();
		}

		this.addItem(
			name,
			{ type: "object", typeString: name, fields } as PopType,
			description,
		);
	}

	private handleStruct(node: TSNode, description: string | undefined): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) return;

		const fields: Record<string, PopType> = {};
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
						fields[declNode.text] = this.parseObjcType(typeNode);
					}
				}
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

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find((n) => n && n.type === "enumerator_list");
		if (!body) return;

		const options: string[] = [];
		for (const c of body.namedChildren) {
			if (c?.type === "enumerator") {
				const vname =
					c.childForFieldName("name")?.text || c.text.split("=")[0]?.trim();
				if (vname) {
					options.push(vname);
				}
			}
		}

		this.addItem(
			name,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private parseObjcType(node: TSNode): PopType {
		if (node.type === "BOOL") {
			return { type: "boolean", binaryType: "bool" } as PopType;
		}
		if (
			node.type === "type_identifier" ||
			node.type === "primitive_type" ||
			node.type === "identifier" ||
			node.type === "typedefed_specifier" ||
			node.type === "sized_type_specifier"
		) {
			const text = node.text;
			if (text === "NSString") return { type: "string" } as PopType;
			const prim = OBJC_PRIMITIVES[text];
			if (prim) {
				if (prim === "bool")
					return { type: "boolean", binaryType: "bool" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}

			if (text === "NSArray" || text === "NSMutableArray") {
				return {
					type: "array",
					item: { type: "any", originalType: "id" },
				} as PopType;
			}

			return { type: "link", target: text } as PopType;
		}

		if (node.type === "generic_type") {
			const name = node.childForFieldName("name")?.text;
			if (name === "NSArray" || name === "NSMutableArray") {
				const args = node.childForFieldName("type_arguments");
				if (args && args.namedChildren.length > 0) {
					const inner = args.namedChildren[0];
					if (inner)
						return {
							type: "array",
							item: this.parseObjcType(inner),
						} as PopType;
				}
				return {
					type: "array",
					item: { type: "any", originalType: "id" },
				} as PopType;
			}
		}

		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkObjcFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkObjcOptions = {},
): WalkResult {
	const importer = new ObjcImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
