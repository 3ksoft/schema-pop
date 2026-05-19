import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import type { WalkResult } from "../toolkit";
import { BaseImporter } from "../toolkit";

export interface WalkRustOptions {
	extraKnownNames?: readonly string[];
}

const RUST_PRIMITIVES: Record<string, string> = {
	u8: "u8",
	u16: "u16",
	u32: "u32",
	u64: "u64",
	u128: "u128",
	i8: "i8",
	i16: "i16",
	i32: "i32",
	i64: "i64",
	i128: "i128",
	f32: "f32",
	f64: "f64",
	bool: "bool",
};

export class RustImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Rust",
		supportedExtensions: [".rs"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode, "");
		return this.finalize();
	}

	private visit(node: TSNode, scopePrefix: string): void {
		const children = node.namedChildren;

		for (const child of children) {
			if (!child) continue;
			if (child.type === "attribute_item") {
				continue;
			}
			if (child.type === "line_comment" || child.type === "block_comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}

			const description = this.docs.consume();

			if (child.type === "struct_item") {
				this.handleStruct(child, description, scopePrefix);
			} else if (child.type === "enum_item") {
				this.handleEnum(child, description, scopePrefix);
			} else if (child.type === "type_item") {
				this.handleAlias(child, description, scopePrefix);
			} else if (
				child.type === "function_item" ||
				child.type === "function_signature_item"
			) {
				this.handleFunction(child, description, scopePrefix);
			} else if (child.type === "foreign_mod_item") {
				const abi = this.findExternAbi(child);
				const body = child.childForFieldName("body");
				if (body) {
					for (const fn of body.namedChildren) {
						if (!fn) continue;
						if (fn.type !== "function_signature_item") continue;
						this.handleFunction(fn, undefined, scopePrefix, abi);
					}
				}
			} else if (child.type === "mod_item") {
				const nameNode = child.childForFieldName("name");
				const bodyNode = child.childForFieldName("body");
				if (bodyNode) {
					this.visit(
						bodyNode,
						scopePrefix
							? `${scopePrefix}::${nameNode?.text ?? "mod"}`
							: (nameNode?.text ?? "mod"),
					);
				}
			}
		}
	}

	private findExternAbi(node: TSNode): string | undefined {
		function walk(n: TSNode): string | undefined {
			if (n.type === "extern_modifier") {
				for (const cc of n.namedChildren) {
					if (cc?.type === "string_literal") {
						return cc.text.replace(/^"|"$/g, "");
					}
				}
				return "C";
			}
			for (const c of n.namedChildren) {
				if (!c) continue;
				if (
					c.type === "function_modifiers" ||
					c.type === "extern_modifier" ||
					c.type === "foreign_mod_item"
				) {
					const r = walk(c);
					if (r) return r;
				}
			}
			return undefined;
		}
		return walk(node);
	}

	private handleFunction(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
		overrideAbi?: string,
	): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) {
			this.skip("<anon>", "no name");
			return;
		}
		const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

		if (node.childForFieldName("type_parameters")) {
			this.skip(qName, "generic function");
			return;
		}

		const abi = overrideAbi ?? this.findExternAbi(node);

		const params = node.childForFieldName("parameters");
		const args: any[] = [];
		if (params) {
			for (const p of params.namedChildren) {
				if (!p) continue;
				if (p.type !== "parameter") continue;
				const pNameNode = p.childForFieldName("pattern");
				const typeNode = p.childForFieldName("type");
				if (!typeNode) continue;
				const argName =
					pNameNode && pNameNode.type === "identifier"
						? pNameNode.text
						: undefined;
				const argType = this.parseRustType(typeNode);
				args.push(argName ? { ...argType, label: argName } : argType);
			}
		}

		const returnTypeNode = node.childForFieldName("return_type");
		const returns: PopType = returnTypeNode
			? this.parseRustType(returnTypeNode)
			: ({ type: "unit" } as PopType);

		this.addItem(
			qName,
			{
				type: "function",
				args,
				returns,
				...(abi ? { abi } : {}),
			},
			description,
		);
	}

	private handleStruct(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) {
			this.skip("<anon>", "no name");
			return;
		}
		const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

		if (node.childForFieldName("type_parameters")) {
			this.skip(qName, "generic struct");
			return;
		}

		const body = node.childForFieldName("body");
		if (!body) {
			this.addItem(
				name,
				{ type: "object", typeString: name, fields: {} } as PopType,
				description,
			);
			return;
		}
		if (body.type !== "field_declaration_list") {
			this.skip(qName, `tuple struct (${body.type})`);
			return;
		}

		const fields: Record<string, PopType> = {};
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "line_comment" || c.type === "block_comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type === "attribute_item") {
				continue;
			}
			if (c.type !== "field_declaration") continue;
			const fnameNode = c.childForFieldName("name");
			const ftypeNode = c.childForFieldName("type");
			const fname = fnameNode?.text;
			if (!fname || !ftypeNode) continue;

			const t = this.parseRustType(ftypeNode);
			const fieldDoc = this.docs.consume();
			if (fieldDoc) t.description = fieldDoc;
			fields[fname] = t;
		}

		this.addItem(
			name,
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
		if (!name) {
			this.skip("<anon>", "no name");
			return;
		}
		const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

		if (node.childForFieldName("type_parameters")) {
			this.skip(qName, "generic enum");
			return;
		}

		const body = node.childForFieldName("body");
		if (!body) {
			this.skip(qName, "no body");
			return;
		}

		const variants: PopType[] = [];
		let isSimpleEnum = true;
		const options: string[] = [];

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "line_comment" || c.type === "block_comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type !== "enum_variant") continue;
			const vnameNode = c.childForFieldName("name");
			const vname = vnameNode?.text;
			if (!vname) continue;

			const vbody = c.childForFieldName("body");
			const vDoc = this.docs.consume();

			if (!vbody) {
				variants.push({
					type: "any",
					originalType: "unit",
					label: vname,
					...(vDoc ? { description: vDoc } : {}),
				} as PopType);
				options.push(vname);
				continue;
			}
			isSimpleEnum = false;
			if (vbody.type === "ordered_field_declaration_list") {
				variants.push({
					type: "any",
					originalType: "tuple",
					label: vname,
					...(vDoc ? { description: vDoc } : {}),
				} as PopType);
			} else if (vbody.type === "field_declaration_list") {
				const fields: Record<string, PopType> = {};
				for (const f of vbody.namedChildren) {
					if (!f || f.type !== "field_declaration") continue;
					const fnameNode = f.childForFieldName("name");
					const ftypeNode = f.childForFieldName("type");
					const fname = fnameNode?.text;
					if (!fname || !ftypeNode) continue;
					fields[fname] = this.parseRustType(ftypeNode);
				}
				variants.push({
					type: "object",
					typeString: vname,
					label: vname,
					fields,
					...(vDoc ? { description: vDoc } : {}),
				} as PopType);
			} else {
				variants.push({
					type: "any",
					originalType: "unit",
					label: vname,
					...(vDoc ? { description: vDoc } : {}),
				} as PopType);
			}
		}

		if (isSimpleEnum) {
			this.addItem(
				name,
				{ type: "enum", typeString: name, options } as PopType,
				description,
			);
		} else {
			this.addItem(name, { type: "union", variants } as PopType, description);
		}
	}

	private handleAlias(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) {
			this.skip("<anon>", "no name");
			return;
		}
		const qName = scopePrefix ? `${scopePrefix}::${name}` : name;

		if (node.childForFieldName("type_parameters")) {
			this.skip(qName, "generic alias");
			return;
		}

		const typeNode = node.childForFieldName("type");
		if (!typeNode) {
			this.skip(qName, "no type");
			return;
		}
		const t = this.parseRustType(typeNode);
		this.addItem(name, t, description);
	}

	private parseRustType(node: TSNode): PopType {
		switch (node.type) {
			case "primitive_type": {
				const n = node.text;
				const mapped = RUST_PRIMITIVES[n];
				if (mapped) {
					if (mapped === "bool")
						return { type: "boolean", binaryType: "bool" } as PopType;
					return { type: "number", binaryType: mapped } as PopType;
				}
				return { type: "any", originalType: n } as PopType;
			}
			case "type_identifier": {
				const n = node.text;
				if (n === "String") return { type: "string" } as PopType;
				return { type: "link", target: n } as PopType;
			}
			case "array_type": {
				const itemNode = node.childForFieldName("element");
				const lenNode = node.childForFieldName("length");
				if (!itemNode || !lenNode) {
					return { type: "any", originalType: node.text } as PopType;
				}
				const item = this.parseRustType(itemNode);
				const lenText = lenNode.text;
				const len = parseInt(lenText, 10);
				if (Number.isNaN(len)) {
					return { type: "any", originalType: node.text } as PopType;
				}
				return { type: "array", item, minLength: len, maxLength: len } as PopType;
			}
			case "generic_type": {
				const typeNode = node.childForFieldName("type");
				const argsNode = node.childForFieldName("type_arguments");
				const baseName = typeNode?.text ?? "";
				const args = argsNode
					? argsNode.namedChildren.filter((c) => c && c.type !== "lifetime")
					: [];
				if (baseName === "Option" && args.length === 1) {
					const inner = this.parseRustType(args[0]!);
					(inner as any).required = false;
					return inner;
				}
				if (baseName === "Vec" && args.length === 1) {
					return {
						type: "array",
						item: this.parseRustType(args[0]!),
					} as PopType;
				}
				return { type: "any", originalType: node.text } as PopType;
			}
			case "reference_type":
			case "pointer_type":
			case "tuple_type":
			case "function_type":
			case "dynamic_type":
				return { type: "any", originalType: node.text } as PopType;
			default:
				return { type: "any", originalType: node.text } as PopType;
		}
	}
}

export function walkRustFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkRustOptions = {},
): WalkResult {
	const importer = new RustImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
