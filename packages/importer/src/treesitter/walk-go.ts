import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkGoOptions {
	extraKnownNames?: readonly string[];
}

const GO_PRIMITIVES: Record<string, string> = {
	int: "i64",
	int8: "i8",
	int16: "i16",
	int32: "i32",
	int64: "i64",
	uint: "u64",
	uint8: "u8",
	uint16: "u16",
	uint32: "u32",
	uint64: "u64",
	float32: "f32",
	float64: "f64",
	bool: "bool",
	byte: "u8",
	rune: "i32",
};

export class GoImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Go",
		supportedExtensions: [".go"],
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

			if (child.type === "type_declaration") {
				for (const spec of child.namedChildren) {
					if (
						spec &&
						(spec.type === "type_spec" || spec.type === "alias_declaration")
					) {
						const nameNode = spec.childForFieldName("name");
						const typeNode =
							spec.childForFieldName("type") ||
							spec.namedChildren.find(
								(c) =>
									c && c.type !== "type_identifier" && c.type !== "comment",
							);
						if (!nameNode || !typeNode) continue;

						const name = nameNode.text;
						if (!this.isExported(name)) continue;

						if (typeNode.type === "struct_type") {
							const list =
								typeNode.namedChildren.find(
									(c) => c && c.type === "field_declaration_list",
								) || typeNode;
							const fields: Record<string, PopType> = {};

							for (const c of list.namedChildren) {
								if (!c) continue;
								if (c.type === "comment") {
									this.docs.addCommentNode(c.text);
									continue;
								}
								if (c.type === "field_declaration") {
									const tNode =
										c.childForFieldName("type") ||
										c.namedChildren.find(
											(x) =>
												x &&
												x.type !== "field_identifier" &&
												x.type !== "comment" &&
												x.type !== "raw_string_literal" &&
												x.type !== "interpreted_string_literal",
										);
									const names = c.namedChildren.filter(
										(x) => x && x.type === "field_identifier",
									);
									if (!tNode) {
										this.docs.clear();
										continue;
									}

									const t = this.parseGoType(tNode);
									const fDoc = this.docs.consume();
									if (fDoc) t.description = fDoc;

									if (names.length === 0) {
										const embedName =
											tNode.text.split(".").pop()?.replace(/^\*/, "") ||
											tNode.text;
										if (this.isExported(embedName)) {
											fields[embedName] = t;
										}
									} else {
										for (const nNode of names) {
											if (nNode && this.isExported(nNode.text)) {
												fields[nNode.text] = { ...t };
											}
										}
									}
								}
								this.docs.clear();
							}
							this.addItem(
								name,
								{ type: "object", typeString: name, fields } as PopType,
								description,
							);
						} else if (typeNode.type !== "interface_type") {
							this.addItem(name, this.parseGoType(typeNode), description);
						}
					}
				}
			} else {
				this.visit(child);
			}
		}
	}

	private isExported(name: string): boolean {
		return name.length > 0 && name[0] === name[0].toUpperCase();
	}

	private parseGoType(node: TSNode): PopType {
		if (node.type === "type_identifier" || node.type === "identifier") {
			if (node.text === "string") return { type: "string" } as PopType;
			const prim = GO_PRIMITIVES[node.text];
			if (prim) {
				if (prim === "bool")
					return { type: "boolean", binaryType: "bool" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: node.text } as PopType;
		}
		if (node.type === "pointer_type") {
			const inner = node.namedChildren[0];
			const innerType = inner
				? this.parseGoType(inner)
				: ({ type: "any", originalType: "any" } as PopType);
			(innerType as any).required = false;
			return innerType;
		}
		if (node.type === "slice_type") {
			const inner = node.childForFieldName("element") || node.namedChildren[0];
			return {
				type: "array",
				item: inner
					? this.parseGoType(inner)
					: { type: "any", originalType: "any" },
			} as PopType;
		}
		if (node.type === "array_type") {
			const lenNode = node.childForFieldName("length");
			const elNode = node.childForFieldName("element");
			const item = elNode
				? this.parseGoType(elNode)
				: ({ type: "any", originalType: "any" } as PopType);
			const len = lenNode ? parseInt(lenNode.text, 10) : NaN;
			if (!isNaN(len)) {
				return { type: "array", item, minLength: len, maxLength: len } as PopType;
			}
			return { type: "array", item } as PopType;
		}
		if (node.type === "qualified_type") {
			const pkg = node.childForFieldName("package")?.text;
			const name = node.childForFieldName("name")?.text;
			if (pkg && name)
				return { type: "link", target: `${pkg}.${name}` } as PopType;
		}
		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkGoFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkGoOptions = {},
): WalkResult {
	const importer = new GoImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
