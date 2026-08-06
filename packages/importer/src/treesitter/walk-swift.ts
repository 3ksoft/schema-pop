import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, WalkResult } from "../toolkit";

export interface WalkSwiftOptions {
	extraKnownNames?: readonly string[];
}

const SWIFT_PRIMITIVES: Record<string, string> = {
	Int8: "i8",
	Int16: "i16",
	Int32: "i32",
	Int64: "i64",
	Int: "i64",
	UInt8: "u8",
	UInt16: "u16",
	UInt32: "u32",
	UInt64: "u64",
	UInt: "u64",
	Float: "f32",
	Double: "f64",
	Bool: "boolean",
};

export class SwiftImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Swift",
		supportedExtensions: [".swift"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode);
		return this.finalize();
	}

	private visit(node: TSNode): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "comment") {
				const text = child.text.trim();
				if (text.startsWith("///")) {
					this.docs.addCommentNode(child.text);
				} else if (text.startsWith("/**")) {
					this.docs.addCommentNode(child.text);
				}
				continue;
			}

			const description = this.docs.consume();

			if (
				child.type === "class_declaration" ||
				child.type === "struct_declaration"
			) {
				const isEnum = child.namedChildren.some(
					(n) => n?.type === "enum_class_body",
				);
				if (isEnum) {
					this.handleEnum(child, description);
				} else {
					this.handleStruct(child, description);
				}
			} else if (child.type === "enum_declaration") {
				this.handleEnum(child, description);
			} else if (child.type === "typealias_declaration") {
				this.handleAlias(child, description);
			} else {
				this.visit(child);
			}
		}
	}

	private isPublic(node: TSNode): boolean {
		const modifiers = node.namedChildren.filter(
			(n) => n && (n.type === "modifiers" || n.type === "visibility_modifier"),
		);
		for (const mod of modifiers) {
			if (
				mod &&
				(mod.text.includes("private") || mod.text.includes("fileprivate"))
			)
				return false;
		}
		return true;
	}

	private handleStruct(node: TSNode, description: string | undefined): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "type_identifier");
		const name = nameNode?.text;
		if (!name) return;

		if (!this.isPublic(node)) return;

		const fields: Record<string, PopType> = {};

		const body =
			node.childForFieldName("body") ||
			node.namedChildren.find(
				(n) => n && (n.type === "class_body" || n.type === "struct_body"),
			);
		if (body) {
			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "comment") {
					const text = c.text.trim();
					if (text.startsWith("///")) {
						this.docs.addCommentNode(text);
					}
					continue;
				}
				if (c.type === "declaration" || c.type === "property_declaration") {
					if (!this.isPublic(c)) {
						this.docs.clear();
						continue;
					}
					const patternNode = c.namedChildren.find(
						(n) => n?.type === "pattern",
					);
					const typeAnnotation = c.namedChildren.find(
						(n) => n?.type === "type_annotation",
					);
					const pName =
						patternNode?.namedChildren.find(
							(n) => n?.type === "simple_identifier",
						) ?? patternNode;
					const pType = typeAnnotation?.namedChildren[0] ?? typeAnnotation;
					if (pName && pType) {
						const fDoc = this.docs.consume();
						const fType = this.parseSwiftType(pType);
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

	private handleEnum(node: TSNode, description: string | undefined): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "type_identifier");
		const name = nameNode?.text;
		if (!name) return;

		if (!this.isPublic(node)) return;

		const body =
			node.childForFieldName("body") ??
			node.namedChildren.find(
				(n) => n && (n.type === "enum_class_body" || n.type === "enum_body"),
			);
		if (!body) return;

		const options: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				const text = c.text.trim();
				if (text.startsWith("///")) this.docs.addCommentNode(text);
				continue;
			}
			if (c.type === "enum_entry") {
				const ident =
					c.namedChildren.find((n) => n?.type === "simple_identifier") ?? c;
				options.push(ident.text);
			}
			this.docs.clear();
		}

		this.addItem(
			name,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private handleAlias(node: TSNode, description: string | undefined): void {
		const nameNode =
			node.childForFieldName("name") ||
			node.namedChildren.find((c) => c && c.type === "type_identifier");
		const name = nameNode?.text;
		if (!name) return;

		const typeNode =
			node.childForFieldName("type") ||
			node.namedChildren.find(
				(c) =>
					c &&
					c.type !== "type_identifier" &&
					c.type !== "comment" &&
					c.type !== "typealias",
			);
		if (!typeNode) return;

		this.addItem(name, this.parseSwiftType(typeNode), description);
	}

	private parseSwiftType(node: TSNode): PopType {
		if (node.type === "optional_type") {
			const inner = node.namedChildren[0];
			const innerType = inner
				? this.parseSwiftType(inner)
				: ({ type: "any", originalType: "Any" } as PopType);
			(innerType as any).required = false;
			return innerType;
		}
		if (node.type === "array_type") {
			const item = node.namedChildren[0];
			return {
				type: "array",
				item: item
					? this.parseSwiftType(item)
					: { type: "any", originalType: "Any" },
			} as PopType;
		}
		if (node.type === "user_type") {
			const ident = node.namedChildren.find(
				(n) => n?.type === "type_identifier",
			);
			const text = ident?.text ?? node.text;
			const args = node.namedChildren.find((n) => n?.type === "type_arguments");
			if (args) {
				const inner = args.namedChildren.find(
					(n) => n?.type === "user_type" || n?.type === "type_identifier",
				);
				if (text === "Optional" && inner) {
					const innerType = this.parseSwiftType(inner);
					(innerType as any).required = false;
					return innerType;
				}
				if (text === "Array" && inner)
					return { type: "array", item: this.parseSwiftType(inner) } as PopType;
			}
			if (text === "String") return { type: "string" } as PopType;
			const prim = SWIFT_PRIMITIVES[text];
			if (prim) {
				if (prim === "boolean")
					return { type: "boolean", binaryType: "boolean" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: text } as PopType;
		}
		if (node.type === "type_identifier") {
			const text = node.text;
			if (text === "String") return { type: "string" } as PopType;
			const prim = SWIFT_PRIMITIVES[text];
			if (prim) {
				if (prim === "boolean")
					return { type: "boolean", binaryType: "boolean" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: text } as PopType;
		}
		const text = node.text.replace(/^:\s*/, "");
		if (text === "String") return { type: "string" } as PopType;
		const prim = SWIFT_PRIMITIVES[text];
		if (prim) {
			if (prim === "boolean")
				return { type: "boolean", binaryType: "boolean" } as PopType;
			return { type: "number", binaryType: prim } as PopType;
		}
		if (text.endsWith("?")) {
			const inner = text.slice(0, -1);
			const innerType = this.parseSwiftType({
				text: inner,
				type: "type_identifier",
			} as TSNode);
			(innerType as any).required = false;
			return innerType;
		}
		if (text.startsWith("[") && text.endsWith("]")) {
			const inner = text.slice(1, -1);
			return {
				type: "array",
				item: this.parseSwiftType({
					text: inner,
					type: "type_identifier",
				} as TSNode),
			} as PopType;
		}
		return { type: "link", target: text } as PopType;
	}
}

export function walkSwiftFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkSwiftOptions = {},
): WalkResult {
	const importer = new SwiftImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
