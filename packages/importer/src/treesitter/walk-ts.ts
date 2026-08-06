import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, WalkResult } from "../toolkit";

export interface WalkTsOptions {
	extraKnownNames?: readonly string[];
}

const TS_PRIMITIVE_KEYWORDS: Record<string, PopType> = {
	number: { type: "number", binaryType: "f64" } as PopType,
	bigint: { type: "number", binaryType: "i64" } as PopType,
	boolean: { type: "boolean", binaryType: "boolean" } as PopType,
	string: { type: "string" } as PopType,
};

export class TsImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Typescript",
		supportedExtensions: [".ts", ".tsx"],
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
			if (child.type === "export_statement") {
				const inner = child.namedChildren.find(
					(c) => c && c.type !== "comment",
				);
				if (inner) {
					const description = this.docs.consume();
					this.handleDecl(inner, description);
				}
				this.docs.clear();
				continue;
			}
			const description = this.docs.consume();
			this.handleDecl(child, description);
		}
	}

	private handleDecl(node: TSNode, description: string | undefined): void {
		switch (node.type) {
			case "interface_declaration":
				this.handleInterface(node, description);
				break;
			case "type_alias_declaration":
				this.handleTypeAlias(node, description);
				break;
			case "enum_declaration":
				this.handleEnum(node, description);
				break;
			default:
				break;
		}
	}

	private handleInterface(node: TSNode, description: string | undefined): void {
		const name = node.childForFieldName("name")?.text;
		if (!name) return;
		if (node.childForFieldName("type_parameters")) {
			this.skip(name, "generic interface");
			return;
		}
		const body = node.childForFieldName("body");
		if (!body) return;
		const fields = this.collectStructFields(body, name);
		this.addItem(
			name,
			{ type: "object", typeString: name, fields } as PopType,
			description,
		);
	}

	private handleTypeAlias(node: TSNode, description: string | undefined): void {
		const name = node.childForFieldName("name")?.text;
		if (!name) return;
		if (node.childForFieldName("type_parameters")) {
			this.skip(name, "generic type alias");
			return;
		}
		const value = node.childForFieldName("value");
		if (!value) return;

		if (value.type === "object_type") {
			const fields = this.collectStructFields(value, name);
			this.addItem(
				name,
				{ type: "object", typeString: name, fields } as PopType,
				description,
			);
			return;
		}

		if (value.type === "union_type") {
			const lits = this.collectStringLiterals(value);
			if (lits) {
				this.addItem(
					name,
					{ type: "enum", typeString: name, options: lits } as PopType,
					description,
				);
				return;
			}
			this.addItem(
				name,
				{ type: "any", originalType: value.text } as PopType,
				description,
			);
			return;
		}

		const t = this.parseTsType(value);
		this.addItem(name, t, description);
	}

	private handleEnum(node: TSNode, description: string | undefined): void {
		const name = node.childForFieldName("name")?.text;
		const body = node.childForFieldName("body");
		if (!name || !body) return;

		const options: string[] = [];
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type !== "property_identifier" && c.type !== "enum_assignment")
				continue;
			const variantName =
				c.type === "property_identifier"
					? c.text
					: (c.childForFieldName("name")?.text ?? c.text);
			if (variantName) options.push(variantName);
		}
		this.addItem(
			name,
			{ type: "enum", typeString: name, options } as PopType,
			description,
		);
	}

	private collectStructFields(
		body: TSNode,
		parentName: string,
	): Record<string, PopType> {
		const fields: Record<string, PopType> = {};
		for (const c of body.namedChildren) {
			if (!c) continue;
			if (c.type === "comment") {
				this.docs.addCommentNode(c.text);
				continue;
			}
			if (c.type !== "property_signature") continue;
			const f = this.parseProperty(c);
			if (!f) {
				const fname = c.childForFieldName("name")?.text ?? "<unknown>";
				this.skip(`${parentName}.${fname}`, "unsupported field shape");
				this.docs.clear();
				continue;
			}
			const fieldDoc = this.docs.consume();
			if (fieldDoc) f.type.description = fieldDoc;
			fields[f.name] = f.type;
		}
		return fields;
	}

	private parseProperty(node: TSNode): { name: string; type: PopType } | null {
		const nameNode = node.childForFieldName("name");
		const typeAnnot = node.namedChildren.find(
			(c) => c && c.type === "type_annotation",
		);
		if (!nameNode) return null;
		const name = nameNode.text;
		const optional = node.text.includes(`${name}?:`);
		const typeNode = typeAnnot?.namedChildren.find(
			(c) => c && c.type !== "comment",
		);
		if (!typeNode) return null;
		const t = this.parseTsType(typeNode);
		if (optional) (t as any).required = false;
		return { name, type: t };
	}

	private collectStringLiterals(unionNode: TSNode): string[] | null {
		const lits: string[] = [];
		const ok = (function walk(n: TSNode): boolean {
			for (const c of n.namedChildren) {
				if (!c) continue;
				if (c.type === "union_type") {
					if (!walk(c)) return false;
					continue;
				}
				if (c.type !== "literal_type") return false;
				const inner = c.namedChild(0);
				if (!inner || inner.type !== "string") return false;
				const raw = inner.text;
				const m = raw.match(/^['"`](.*)['"`]$/);
				lits.push(m ? m[1]! : raw);
			}
			return true;
		})(unionNode);
		if (!ok) return null;
		return lits.length ? lits : null;
	}

	private parseTsType(node: TSNode): PopType {
		switch (node.type) {
			case "predefined_type": {
				const t = TS_PRIMITIVE_KEYWORDS[node.text];
				if (t) return { ...t } as PopType;
				return { type: "any", originalType: node.text } as PopType;
			}
			case "type_identifier":
				return { type: "link", target: node.text } as PopType;
			case "array_type": {
				const elem = node.namedChild(0);
				if (elem)
					return { type: "array", item: this.parseTsType(elem) } as PopType;
				return { type: "any", originalType: node.text } as PopType;
			}
			case "generic_type": {
				const ident = node.childForFieldName("name")?.text;
				const args = node.childForFieldName("type_arguments");
				if (ident === "Array" && args) {
					const inner = args.namedChild(0);
					if (inner)
						return { type: "array", item: this.parseTsType(inner) } as PopType;
				}
				return { type: "any", originalType: node.text } as PopType;
			}
			case "literal_type": {
				const inner = node.namedChild(0);
				if (inner?.type === "string") {
					const m = inner.text.match(/^['"`](.*)['"`]$/);
					return {
						type: "link",
						target: `'${m ? m[1] : inner.text}'`,
					} as PopType;
				}
				return { type: "any", originalType: node.text } as PopType;
			}
			case "union_type": {
				const lits = this.collectStringLiterals(node);
				if (lits) {
					return {
						type: "link",
						target: lits.map((l) => `'${l}'`).join(" | "),
					} as PopType;
				}
				return { type: "any", originalType: node.text } as PopType;
			}
			case "object_type":
				return { type: "any", originalType: node.text } as PopType;
			default:
				return { type: "any", originalType: node.text } as PopType;
		}
	}
}

export function walkTsFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkTsOptions = {},
): WalkResult {
	const importer = new TsImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
