import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkScalaOptions {
	extraKnownNames?: readonly string[];
}

const SCALA_PRIMITIVES: Record<string, string> = {
	Byte: "i8",
	Short: "i16",
	Int: "i32",
	Long: "i64",
	Float: "f32",
	Double: "f64",
	Boolean: "boolean",
	Char: "u16",
};

export class ScalaImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Scala",
		supportedExtensions: [".scala"],
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

			if (
				child.type === "class_definition" ||
				child.type === "object_definition"
			) {
				this.handleClass(child, description);
			} else {
				this.visit(child);
			}
		}
	}

	private isPublic(node: TSNode): boolean {
		const text = node.text;
		return !text.includes("private ") && !text.includes("protected ");
	}

	private handleClass(node: TSNode, description: string | undefined): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "identifier");
		const name = nameNode?.text;
		if (!name || !this.isPublic(node)) return;

		const fields: Record<string, PopType> = {};

		const params =
			node.childForFieldName("class_parameters") ||
			node.namedChildren.find((n) => n && n.type === "class_parameters");
		if (params) {
			for (const p of params.namedChildren) {
				if (p && p.type === "class_parameter") {
					if (!this.isPublic(p)) continue;
					const pName =
						p.childForFieldName("name") ||
						p.namedChildren.find((n) => n && n.type === "identifier");
					const pType =
						p.childForFieldName("type") ||
						p.namedChildren.find(
							(n) =>
								n &&
								(n.type === "type_identifier" || n.type === "generic_type"),
						);
					if (pName && pType) {
						fields[pName.text] = this.parseScalaType(pType);
					}
				}
			}
		}

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find((n) => n && n.type === "template_body");
		if (body) {
			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "comment") {
					this.docs.addCommentNode(c.text);
					continue;
				}
				if (
					c.type === "val_declaration" ||
					c.type === "var_declaration" ||
					c.type === "val_definition" ||
					c.type === "var_definition"
				) {
					if (!this.isPublic(c)) {
						this.docs.clear();
						continue;
					}
					const pName =
						c.childForFieldName("name") ??
						c.namedChildren.find((n) => n?.type === "identifier");
					const pType =
						c.childForFieldName("type") ??
						c.namedChildren.find(
							(n) =>
								n &&
								(n.type === "type_identifier" || n.type === "generic_type"),
						);
					if (pName && pType) {
						const fDoc = this.docs.consume();
						const fType = this.parseScalaType(pType);
						if (fDoc) fType.description = fDoc;
						fields[pName.text] = fType;
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

	private parseScalaType(node: TSNode): PopType {
		const text = node.text;
		if (text === "String") return { type: "string" } as PopType;
		const prim = SCALA_PRIMITIVES[text];
		if (prim) {
			if (prim === "boolean")
				return { type: "boolean", binaryType: "boolean" } as PopType;
			return { type: "number", binaryType: prim } as PopType;
		}

		const genericMatch = text.match(/^([A-Za-z0-9_]+)\[(.+)\]$/);
		if (genericMatch) {
			const base = genericMatch[1];
			const inner = genericMatch[2];
			if (base === "Array" || base === "List" || base === "Seq") {
				return {
					type: "array",
					item: this.parseScalaType({ text: inner } as TSNode),
				} as PopType;
			}
			if (base === "Option") {
				const innerType = this.parseScalaType({ text: inner } as TSNode);
				(innerType as any).required = false;
				return innerType;
			}
		}

		return { type: "link", target: text } as PopType;
	}
}

export function walkScalaFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkScalaOptions = {},
): WalkResult {
	const importer = new ScalaImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
