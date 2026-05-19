import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkDartOptions {
	extraKnownNames?: readonly string[];
}

const DART_PRIMITIVES: Record<string, string> = {
	int: "i64",
	double: "f64",
	bool: "bool",
};

export class DartImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Dart",
		supportedExtensions: [".dart"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode);
		return this.finalize();
	}

	private visit(node: TSNode): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "documentation_comment" || child.type === "comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}

			const description = this.docs.consume();

			if (child.type === "class_definition") {
				this.handleClass(child, description);
			} else if (child.type === "enum_declaration") {
				this.handleEnum(child, description);
			} else {
				this.visit(child);
			}
		}
	}

	private isPublic(name: string): boolean {
		return !name.startsWith("_");
	}

	private handleClass(node: TSNode, description: string | undefined): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "identifier");
		const name = nameNode?.text;
		if (!name || !this.isPublic(name)) return;

		const fields: Record<string, PopType> = {};

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find((n) => n && n.type === "class_body");
		if (body) {
			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "documentation_comment" || c.type === "comment") {
					this.docs.addCommentNode(c.text);
					continue;
				}
				if (c.type === "declaration") {
					const typeIdent = c.namedChildren.find(
						(n) => n?.type === "type_identifier",
					);
					const typeArgs = c.namedChildren.find(
						(n) => n?.type === "type_arguments",
					);
					const isNullable = c.namedChildren.some(
						(n) => n?.type === "nullable_type",
					);
					const identList = c.namedChildren.find(
						(n) => n?.type === "initialized_identifier_list",
					);

					if (typeIdent && identList) {
						for (const initIdent of identList.namedChildren) {
							if (!initIdent || initIdent.type !== "initialized_identifier")
								continue;
							const idNode = initIdent.namedChildren.find(
								(n) => n?.type === "identifier",
							);
							const pName = idNode?.text;
							if (pName && this.isPublic(pName)) {
								const fDoc = this.docs.consume();
								const fType = this.parseDartTypeFromParts(
									typeIdent,
									typeArgs,
									isNullable,
								);
								if (fDoc) fType.description = fDoc;
								fields[pName] = fType;
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
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "identifier");
		const name = nameNode?.text;
		if (!name || !this.isPublic(name)) return;

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find((n) => n && n.type === "enum_body");
		if (!body) return;

		const options: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "documentation_comment" || c.type === "comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type === "enum_constant") {
				const vname =
					c.childForFieldName("name")?.text ||
					c.namedChildren.find((n) => n && n.type === "identifier")?.text;
				if (vname && this.isPublic(vname)) {
					options.push(vname);
				}
				this.docs.clear();
			}
		}

		this.addItem(
			name,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private parseDartTypeFromParts(
		typeIdent: TSNode,
		typeArgs: TSNode | null | undefined,
		nullable: boolean,
	): PopType {
		const name = typeIdent.text;
		let base: PopType;

		if (typeArgs && (name === "List" || name === "Iterable")) {
			const innerIdent = typeArgs.namedChildren.find(
				(n) => n?.type === "type_identifier",
			);
			const innerType = innerIdent
				? this.parseDartTypeFromParts(innerIdent, undefined, false)
				: ({ type: "any", originalType: "dynamic" } as PopType);
			base = { type: "array", item: innerType } as PopType;
		} else {
			if (name === "String") {
				base = { type: "string" } as PopType;
			} else {
				const prim = DART_PRIMITIVES[name];
				if (prim) {
					if (prim === "bool")
						base = { type: "boolean", binaryType: "bool" } as PopType;
					else base = { type: "number", binaryType: prim } as PopType;
				} else {
					base = { type: "link", target: name } as PopType;
				}
			}
		}

		if (nullable) {
			(base as any).required = false;
		}
		return base;
	}
}

export function walkDartFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkDartOptions = {},
): WalkResult {
	const importer = new DartImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
