import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter } from "../toolkit";

export interface WalkCOptions {
	extraKnownNames?: readonly string[];
}

import type { WalkResult } from "../toolkit";

const STDINT_ALIASES: Record<string, string> = {
	uint8_t: "u8",
	uint16_t: "u16",
	uint32_t: "u32",
	uint64_t: "u64",
	int8_t: "i8",
	int16_t: "i16",
	int32_t: "i32",
	int64_t: "i64",
	uint_least8_t: "u8",
	uint_least16_t: "u16",
	uint_least32_t: "u32",
	uint_least64_t: "u64",
	uint_fast8_t: "u8",
	uint_fast16_t: "u16",
	uint_fast32_t: "u32",
	uint_fast64_t: "u64",
	int_least8_t: "i8",
	int_least16_t: "i16",
	int_least32_t: "i32",
	int_least64_t: "i64",
	int_fast8_t: "i8",
	int_fast16_t: "i16",
	int_fast32_t: "i32",
	int_fast64_t: "i64",
	float32_t: "f32",
	float64_t: "f64",
};

function resolveCPrimitive(text: string): string | null {
	const t = text.replace(/\s+/g, " ").trim();
	switch (t) {
		case "char":
		case "unsigned char":
			return "u8";
		case "signed char":
			return "i8";
		case "unsigned short":
		case "unsigned short int":
			return "u16";
		case "short":
		case "short int":
		case "signed short":
		case "signed short int":
			return "i16";
		case "unsigned long long":
		case "unsigned long long int":
			return "u64";
		case "long long":
		case "long long int":
		case "signed long long":
		case "signed long long int":
			return "i64";
		case "float":
			return "f32";
		case "double":
			return "f64";
		case "_Bool":
		case "bool":
			return "bool";
		default:
			return null;
	}
}

function resolveTextToPrimitive(text: string): string | null {
	return STDINT_ALIASES[text] ?? resolveCPrimitive(text) ?? null;
}

function findFirstChild(node: TSNode, types: string[]): TSNode | null {
	for (const c of node.namedChildren) {
		if (c && types.includes(c.type)) return c;
	}
	return null;
}

export class CImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "C",
		supportedExtensions: [".h", ".c", ".cc", ".cxx", ".cpp", ".hxx", ".hpp"],
	};

	private allowClass: boolean;

	constructor(
		sourcePath: string,
		opts: { allowClass?: boolean; extraKnownNames?: readonly string[] } = {},
	) {
		super(sourcePath, opts);
		this.allowClass = opts.allowClass ?? false;
	}

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode, "");
		return this.finalize();
	}

	private visit(node: TSNode, scopePrefix: string): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}

			if (
				child.type === "preproc_include" ||
				child.type === "preproc_def" ||
				child.type === "preproc_function_def" ||
				child.type === "preproc_if" ||
				child.type === "preproc_ifdef" ||
				child.type === "preproc_call" ||
				child.type === "linkage_specification"
			) {
				if (child.type === "linkage_specification") {
					const body = child.childForFieldName("body");
					if (body) this.visit(body, scopePrefix);
				}
				continue;
			}

			if (child.type === "attribute_declaration") continue;

			const description = this.docs.consume();

			if (child.type === "type_definition") {
				this.handleTypedef(child, description, scopePrefix);
			} else if (child.type === "declaration") {
				this.handleBareDeclaration(child, description, scopePrefix);
			} else if (
				child.type === "struct_specifier" ||
				(this.allowClass && child.type === "class_specifier")
			) {
				this.handleStructSpecifier(child, null, description, scopePrefix);
			} else if (child.type === "enum_specifier") {
				this.handleEnumSpecifier(child, null, description, scopePrefix);
			} else if (child.type === "union_specifier") {
				this.handleUnionSpecifier(child, null);
			} else if (this.allowClass && child.type === "namespace_definition") {
				const nameNode = child.childForFieldName("name");
				const body = child.childForFieldName("body");
				const ns = nameNode?.text ?? "anon";
				if (body) this.visit(body, scopePrefix ? `${scopePrefix}::${ns}` : ns);
			} else if (this.allowClass && child.type === "alias_declaration") {
				const nameNode = child.childForFieldName("name");
				const typeNode = child.childForFieldName("type");
				const name = nameNode?.text;
				if (name && typeNode) {
					this.addItem(name, this.parseCType(typeNode), description);
				}
			}
		}
	}

	private handleTypedef(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const innerType = findFirstChild(node, [
			"struct_specifier",
			"union_specifier",
			"enum_specifier",
			"primitive_type",
			"sized_type_specifier",
			"type_identifier",
		]);
		const decl = findFirstChild(node, [
			"type_identifier",
			"identifier",
			"pointer_declarator",
			"array_declarator",
		]);
		if (!innerType) return;

		let aliasName: string | undefined;
		if (decl?.type === "type_identifier" || decl?.type === "identifier") {
			aliasName = decl.text;
		} else if (decl?.type === "pointer_declarator") {
			const inner = decl.childForFieldName("declarator");
			if (inner?.type === "type_identifier") {
				this.skip(inner.text, "typedef of pointer type");
			}
			return;
		} else {
			for (let i = node.namedChildCount - 1; i >= 0; i--) {
				const c = node.namedChild(i);
				if (c?.type === "type_identifier" || c?.type === "identifier") {
					aliasName = c.text;
					break;
				}
			}
		}

		if (!aliasName) return;

		if (
			innerType.type === "struct_specifier" ||
			(this.allowClass && innerType.type === "class_specifier")
		) {
			this.handleStructSpecifier(
				innerType,
				aliasName,
				description,
				scopePrefix,
			);
		} else if (innerType.type === "union_specifier") {
			this.handleUnionSpecifier(innerType, aliasName);
		} else if (innerType.type === "enum_specifier") {
			this.handleEnumSpecifier(innerType, aliasName, description, scopePrefix);
		} else {
			this.addItem(aliasName, this.parseCType(innerType), description);
		}
	}

	private handleBareDeclaration(
		node: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		if (node.namedChildren.some((c) => c?.type === "init_declarator")) return;

		const fnDecl = this.findNestedFunctionDeclarator(node);
		if (fnDecl) {
			this.handleFunctionPrototype(node, fnDecl, description, scopePrefix);
			return;
		}

		for (const c of node.namedChildren) {
			if (!c) continue;
			if (c.type === "struct_specifier") {
				this.handleStructSpecifier(c, null, description, scopePrefix);
			} else if (c.type === "enum_specifier") {
				this.handleEnumSpecifier(c, null, description, scopePrefix);
			} else if (c.type === "union_specifier") {
				this.handleUnionSpecifier(c, null);
			} else if (this.allowClass && c.type === "class_specifier") {
				this.handleStructSpecifier(c, null, description, scopePrefix);
			}
		}
	}

	private findNestedFunctionDeclarator(decl: TSNode): TSNode | null {
		for (const c of decl.namedChildren) {
			if (!c) continue;
			if (c.type === "function_declarator") return c;
			if (
				c.type === "pointer_declarator" ||
				c.type === "parenthesized_declarator"
			) {
				const inner = c.childForFieldName("declarator");
				if (inner?.type === "function_declarator") return inner;
			}
		}
		return null;
	}

	private handleFunctionPrototype(
		declNode: TSNode,
		fnDecl: TSNode,
		description: string | undefined,
		scopePrefix: string,
	): void {
		const nameNode = fnDecl.childForFieldName("declarator");
		const name = nameNode?.text;
		if (!name || /[*&]/.test(name)) {
			this.skip(name ?? "<anon>", "function pointer / complex declarator");
			return;
		}

		const qName = scopePrefix ? `${scopePrefix}::${name}` : name;
		const returnTypeNode = declNode.childForFieldName("type");
		let returns: PopType;

		if (returnTypeNode) {
			if (returnTypeNode.text === "void") {
				returns = { type: "unit" } as PopType;
			} else {
				returns = this.parseCType(returnTypeNode);
			}
		} else {
			returns = { type: "unit" } as PopType;
		}

		const params = fnDecl.childForFieldName("parameters");
		const args: any[] = [];
		if (params) {
			for (const p of params.namedChildren) {
				if (!p) continue;
				if (p.type !== "parameter_declaration") continue;
				const ptype = p.childForFieldName("type");
				const pdecl = p.childForFieldName("declarator");
				if (!ptype) continue;
				let argName: string | undefined;
				if (pdecl?.type === "identifier") argName = pdecl.text;
				else if (pdecl?.type === "pointer_declarator") {
					const inner = pdecl.childForFieldName("declarator");
					if (inner?.type === "identifier") argName = inner.text;
				}
				args.push({
					...(argName ? { name: argName } : {}),
					type:
						ptype.text === "void" ? { type: "unit" } : this.parseCType(ptype),
				});
			}
		}

		if (args.length === 1 && args[0]!.type.type === "unit" && !args[0]!.name) {
			args.length = 0;
		}

		this.addItem(
			qName,
			{
				type: "function",
				args,
				returns,
			},
			description,
		);
	}

	private handleStructSpecifier(
		node: TSNode,
		typedefName: string | null,
		description: string | undefined,
		scopePrefix: string,
	): void {
		if (node.parent?.type === "template_declaration") {
			this.skip(
				typedefName ?? node.childForFieldName("name")?.text ?? "<anon>",
				"template type",
			);
			return;
		}

		const tagName = node.childForFieldName("name")?.text;
		const name = typedefName ?? tagName;
		if (!name) return;

		const body = node.childForFieldName("body");
		if (!body) return;

		const qName = scopePrefix ? `${scopePrefix}::${name}` : name;
		const fields: Record<string, PopType> = {};

		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}

			if (c.type === "access_specifier") {
				const access = c.text.replace(":", "").trim();
				if (access === "private" || access === "protected") break;
				continue;
			}

			if (c.type !== "field_declaration") continue;

			const f = this.parseFieldDeclaration(c);
			const fieldDesc = this.docs.consume();

			if (f) {
				if (fieldDesc) f.type.description = fieldDesc;
				fields[f.name] = f.type;
			} else {
				const fname = c.childForFieldName("declarator")?.text ?? "<unknown>";
				this.skip(`${qName}.${fname}`, "unsupported field shape");
			}
		}

		this.addItem(
			qName,
			{ type: "object", typeString: name, fields } as PopType,
			description,
		);
	}

	private handleEnumSpecifier(
		node: TSNode,
		typedefName: string | null,
		description: string | undefined,
		_scopePrefix: string,
	): void {
		const tagName = node.childForFieldName("name")?.text;
		const name = typedefName ?? tagName;
		const body = node.childForFieldName("body");
		if (!name || !body) return;

		const options: string[] = [];
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type !== "enumerator") continue;
			const vname =
				c.childForFieldName("name")?.text ?? c.text.split("=")[0]!.trim();
			options.push(vname);
		}

		this.addItem(
			name,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private handleUnionSpecifier(node: TSNode, typedefName: string | null): void {
		const tagName = node.childForFieldName("name")?.text;
		const name = typedefName ?? tagName;
		if (!name) return;
		this.skip(name, "C union (raw — schema-pop has no native union mapping)");
	}

	private parseFieldDeclaration(
		node: TSNode,
	): { name: string; type: PopType } | null {
		if (
			node.namedChildren.some(
				(c) =>
					c?.type === "function_declarator" || c?.type === "bitfield_clause",
			)
		) {
			return null;
		}

		const typeNode = node.childForFieldName("type");
		const declNode = node.childForFieldName("declarator");
		if (!typeNode || !declNode) return null;

		if (declNode.type === "pointer_declarator") return null;

		let baseType = this.parseCType(typeNode);
		let name: string | undefined;

		if (declNode.type === "field_identifier") {
			name = declNode.text;
		} else if (declNode.type === "array_declarator") {
			const r = this.parseArrayDeclarator(declNode, baseType);
			if (!r) return null;
			baseType = r.type;
			name = r.name;
		}
		if (!name) return null;

		return { name, type: baseType };
	}

	private parseArrayDeclarator(
		node: TSNode,
		baseType: PopType,
	): { name: string; type: PopType } | null {
		const inner = node.childForFieldName("declarator");
		const sizeNode = node.childForFieldName("size");
		if (!inner || !sizeNode) return null;

		const sizeText = sizeNode.text;
		const len = parseInt(sizeText, 10);
		if (Number.isNaN(len)) return null;

		if (inner.type === "field_identifier" || inner.type === "identifier") {
			return {
				name: inner.text,
				type: {
					type: "array",
					item: baseType,
					minLength: len,
					maxLength: len,
				} as PopType,
			};
		}

		if (inner.type === "array_declarator") {
			const sub = this.parseArrayDeclarator(inner, baseType);
			if (!sub) return null;
			return {
				name: sub.name,
				type: {
					type: "array",
					item: sub.type,
					minLength: len,
					maxLength: len,
				} as PopType,
			};
		}

		return null;
	}

	private parseCType(node: TSNode): PopType {
		switch (node.type) {
			case "type_descriptor": {
				const inner =
					node.childForFieldName("type") ??
					node.namedChildren.find(
						(c): c is TSNode => !!c && c.type !== "type_qualifier",
					) ??
					null;
				if (inner) return this.parseCType(inner);
				return { type: "any", originalType: node.text } as PopType;
			}
			case "primitive_type":
			case "sized_type_specifier": {
				const text = node.text;
				const prim = resolveTextToPrimitive(text);
				if (prim) {
					if (prim === "bool")
						return { type: "boolean", binaryType: "bool" } as PopType;
					return { type: "number", binaryType: prim } as PopType;
				}
				return { type: "any", originalType: text } as PopType;
			}
			case "type_identifier": {
				const text = node.text;
				const prim = resolveTextToPrimitive(text);
				if (prim) {
					if (prim === "bool")
						return { type: "boolean", binaryType: "bool" } as PopType;
					return { type: "number", binaryType: prim } as PopType;
				}
				return { type: "link", target: text } as PopType;
			}
			case "struct_specifier":
			case "enum_specifier":
			case "union_specifier": {
				const tag = node.childForFieldName("name")?.text;
				if (tag) return { type: "link", target: tag } as PopType;
				return { type: "any", originalType: node.text } as PopType;
			}
			case "qualified_identifier": {
				const parts = node.text.split("::");
				const last = parts[parts.length - 1]!;
				const stdint = STDINT_ALIASES[last];
				if (stdint) {
					return { type: "number", binaryType: stdint } as PopType;
				}
				return { type: "link", target: last } as PopType;
			}
			default:
				return { type: "any", originalType: node.text } as PopType;
		}
	}
}

export function walkCFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkCOptions = {},
): WalkResult {
	const importer = new CImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
