import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

const CS_PRIMITIVES: Record<string, string> = {
	byte: "u8",
	sbyte: "i8",
	short: "i16",
	ushort: "u16",
	int: "i32",
	uint: "u32",
	long: "i64",
	ulong: "u64",
	float: "f32",
	double: "f64",
	boolean: "boolean",
	char: "u16",
};

export interface WalkCSharpOptions {
	extraKnownNames?: readonly string[];
}

export class CSharpImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "C#",
		supportedExtensions: [".cs"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode, "");
		return this.finalize();
	}

	private visit(node: TSNode, currentNamespace: string): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "comment") {
				const text = child.text.trim();
				if (text.startsWith("///")) {
					const content = text
						.replace(/^\/\/\/\s*(<[^>]+>)?/, "")
						.replace(/(<\/[^>]+>)?$/, "")
						.trim();
					if (content && !content.startsWith("<")) {
						this.docs.addCommentNode(`/// ${content}`);
					}
				} else if (text.startsWith("//")) {
					this.docs.addCommentNode(child.text);
				} else if (text.startsWith("/*")) {
					this.docs.addCommentNode(child.text);
				}
				continue;
			}

			const description = this.docs.consume();

			if (
				child.type === "namespace_declaration" ||
				child.type === "file_scoped_namespace_declaration"
			) {
				const nameNode =
					child.childForFieldName("name") ||
					child.namedChildren.find(
						(c) =>
							c && (c.type === "identifier" || c.type === "qualified_name"),
					);
				const ns = nameNode?.text ?? "";
				const body =
					child.childForFieldName("body") ||
					child.namedChildren.find((c) => c && c.type === "declaration_list");

				const oldNs = currentNamespace;
				currentNamespace = oldNs ? `${oldNs}.${ns}` : ns;

				if (body) {
					this.visit(body, currentNamespace);
				} else if (child.type === "file_scoped_namespace_declaration") {
					for (let i = 0; i < child.namedChildCount; i++) {
						const c = child.namedChild(i);
						if (
							c &&
							c.type !== "identifier" &&
							c.type !== "qualified_name" &&
							c.type !== "comment"
						) {
							this.visit({ namedChildren: [c] } as any, currentNamespace);
						}
					}
				}
				currentNamespace = oldNs;
			} else if (
				child.type === "class_declaration" ||
				child.type === "struct_declaration" ||
				child.type === "record_declaration" ||
				child.type === "record_struct_declaration"
			) {
				this.handleClass(child, description, currentNamespace);
			} else if (child.type === "enum_declaration") {
				this.handleEnum(child, description, currentNamespace);
			} else {
				this.visit(child, currentNamespace);
			}
		}
	}

	private hasModifier(node: TSNode, mod: string): boolean {
		const modifiers =
			node.childForFieldName("modifiers") ||
			node.namedChildren.find((n) => n && n.type === "modifier_list");
		if (modifiers) {
			return modifiers.namedChildren.some((m) => m?.text === mod);
		}
		return node.namedChildren.some(
			(m) => m?.type === "modifier" && m.text === mod,
		);
	}

	private handleClass(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "identifier");
		const name = nameNode?.text;
		if (!name) return;
		const qName = scopePrefix ? `${scopePrefix}.${name}` : name;

		const fields: Record<string, PopType> = {};

		const params =
			node.childForFieldName("parameters") ||
			node.namedChildren.find((n) => n && n.type === "parameter_list");
		if (params) {
			for (const p of params.namedChildren) {
				if (p?.type === "parameter") {
					const pName =
						p.childForFieldName("name") ||
						p.namedChildren.find((n) => n && n.type === "identifier");
					const pType =
						p.childForFieldName("type") ||
						p.namedChildren.find(
							(n) =>
								n &&
								n.type !== "identifier" &&
								n.type !== "modifier" &&
								n.type !== "attribute_list",
						);
					if (pName && pType) {
						fields[pName.text] = this.parseCSharpType(pType);
					}
				}
			}
		}

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find((n) => n && n.type === "declaration_list");
		if (body) {
			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "comment") {
					const text = c.text
						.replace(/^\/\/\/?\s*(<[^>]+>)?/, "")
						.replace(/(<\/[^>]+>)?$/, "")
						.trim();
					if (text) this.docs.addCommentNode(`/// ${text}`);
					continue;
				}
				if (c.type === "property_declaration") {
					if (!this.hasModifier(c, "public")) {
						this.docs.clear();
						continue;
					}
					const tNode =
						c.childForFieldName("type") ||
						c.namedChildren.find(
							(n) =>
								n &&
								n.type !== "modifier" &&
								n.type !== "identifier" &&
								n.type !== "accessor_list",
						);
					const nNode =
						c.childForFieldName("name") ||
						c.namedChildren.find((n) => n && n.type === "identifier");
					if (tNode && nNode) {
						const fDoc = this.docs.consume();
						const fType = this.parseCSharpType(tNode);
						if (fDoc) fType.description = fDoc;
						fields[nNode.text] = fType;
					}
				} else if (c.type === "field_declaration") {
					if (!this.hasModifier(c, "public")) {
						this.docs.clear();
						continue;
					}
					const decl =
						c.childForFieldName("declaration") ||
						c.namedChildren.find((n) => n && n.type === "variable_declaration");
					if (decl) {
						const tNode =
							decl.childForFieldName("type") ||
							decl.namedChildren.find(
								(n) => n && n.type !== "variable_declarator",
							);
						const vars = decl.namedChildren.filter(
							(n) => n && n.type === "variable_declarator",
						);
						for (const v of vars) {
							if (!v) continue;
							const nNode =
								v.childForFieldName("name") ||
								v.namedChildren.find((n) => n && n.type === "identifier");
							if (tNode && nNode) {
								const fDoc = this.docs.consume();
								const fType = this.parseCSharpType(tNode);
								if (fDoc) fType.description = fDoc;
								fields[nNode.text] = fType;
							}
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
		scopePrefix: string,
	): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "identifier");
		const name = nameNode?.text;
		if (!name) return;
		const qName = scopePrefix ? `${scopePrefix}.${name}` : name;

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find(
				(n) => n && n.type === "enum_member_declaration_list",
			);
		if (!body) return;

		const options: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				const text = c.text
					.replace(/^\/\/\/?\s*(<[^>]+>)?/, "")
					.replace(/(<\/[^>]+>)?$/, "")
					.trim();
				if (text) this.docs.addCommentNode(`/// ${text}`);
				continue;
			}
			if (c.type === "enum_member_declaration") {
				const mName =
					c.childForFieldName("name") ||
					c.namedChildren.find((n) => n && n.type === "identifier");
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

	private parseCSharpType(node: TSNode): PopType {
		if (node.type === "nullable_type") {
			const inner = node.childForFieldName("type") || node.namedChildren[0];
			const innerType = inner
				? this.parseCSharpType(inner)
				: ({ type: "any", originalType: "any" } as PopType);
			(innerType as any).required = false;
			return innerType;
		}
		if (node.type === "array_type") {
			const inner = node.childForFieldName("type") || node.namedChildren[0];
			return {
				type: "array",
				item: inner
					? this.parseCSharpType(inner)
					: { type: "any", originalType: "any" },
			} as PopType;
		}
		if (node.type === "generic_name") {
			const name = node.namedChildren.find(
				(c) => c && c.type === "identifier",
			)?.text;
			const args =
				node.childForFieldName("type_arguments") ||
				node.namedChildren.find((c) => c && c.type === "type_argument_list");
			if (
				args &&
				(name === "List" ||
					name === "IEnumerable" ||
					name === "IReadOnlyList" ||
					name === "IList")
			) {
				const inner = args.namedChildren.find(
					(c) => c && c.type !== "comment" && c.type !== "punctuation",
				);
				if (inner)
					return {
						type: "array",
						item: this.parseCSharpType(inner),
					} as PopType;
			}
			return { type: "any", originalType: node.text } as PopType;
		}
		if (
			node.type === "predefined_type" ||
			node.type === "identifier" ||
			node.type === "qualified_name"
		) {
			const text = node.text.split(".").pop()!;
			if (text === "string") return { type: "string" } as PopType;
			const prim = CS_PRIMITIVES[text];
			if (prim) {
				if (prim === "boolean")
					return { type: "boolean", binaryType: "boolean" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: node.text } as PopType;
		}
		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkCSharpFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkCSharpOptions = {},
): WalkResult {
	const importer = new CSharpImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
