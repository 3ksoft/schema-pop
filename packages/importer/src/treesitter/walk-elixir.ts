import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkElixirOptions {
	extraKnownNames?: readonly string[];
}

const ELIXIR_PRIMITIVES: Record<string, string> = {
	integer: "i64",
	float: "f64",
	boolean: "bool",
};

export class ElixirImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Elixir",
		supportedExtensions: [".ex", ".exs"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode);
		return this.finalize();
	}

	private visit(node: TSNode): void {
		if (node.type === "call" && node.namedChildren[0]?.text === "defmodule") {
			const nameNode = node.namedChildren[1];
			const name = nameNode?.text.replace(/^[^A-Z]+/, "");

			const block = node.namedChildren.find((c) => c && c.type === "do_block");
			if (name && block) {
				const typeCall = this.findTypeCall(block);
				if (typeCall) {
					this.handleTypeCall(typeCall, name);
				} else {
					const defstruct = this.findDefstruct(block);
					if (defstruct) {
						this.handleDefstruct(defstruct, name);
					}
				}
			}
		}
		for (const child of node.namedChildren) {
			if (child) this.visit(child);
		}
	}

	private findTypeCall(block: TSNode): TSNode | null {
		for (const c of block.namedChildren) {
			if (c && c.type === "unary_operator" && c.text.startsWith("@type"))
				return c;
			const found = c ? this.findTypeCall(c) : null;
			if (found) return found;
		}
		return null;
	}

	private findDefstruct(block: TSNode): TSNode | null {
		for (const c of block.namedChildren) {
			if (c && c.type === "call" && c.namedChildren[0]?.text === "defstruct")
				return c;
			const found = c ? this.findDefstruct(c) : null;
			if (found) return found;
		}
		return null;
	}

	private handleTypeCall(node: TSNode, moduleName: string): void {
		const fields: Record<string, PopType> = {};

		const callNode = node.namedChildren.find((n) => n?.type === "call");
		const argsNode = callNode?.namedChildren.find(
			(n) => n?.type === "arguments",
		);
		const binaryOp = argsNode?.namedChildren.find(
			(n) => n?.type === "binary_operator",
		);
		if (!binaryOp) return;

		const mapNode = binaryOp.namedChildren.find((n) => n?.type === "map");
		if (mapNode) {
			const content = mapNode.namedChildren.find(
				(n) => n?.type === "map_content",
			);
			const keywords =
				content?.namedChildren.find((n) => n?.type === "keywords") ?? content;
			const pairNodes = keywords?.namedChildren ?? [];
			for (const pair of pairNodes) {
				if (!pair || pair.type !== "pair") continue;
				const key = pair.namedChildren[0]?.text.replace(/:\s*$/, "").trim();
				const typeStr = pair.namedChildren[1]?.text;
				if (key && typeStr) {
					fields[key] = this.parseElixirType(typeStr);
				}
			}
		}

		if (Object.keys(fields).length > 0) {
			this.addItem(moduleName, {
				type: "object",
				typeString: moduleName,
				fields,
			} as PopType);
		}
	}

	private handleDefstruct(node: TSNode, moduleName: string): void {
		const fields: Record<string, PopType> = {};
		const args = node.namedChildren.find((n) => n?.type === "arguments");
		if (!args) return;

		const list = args.namedChildren.find(
			(n) => n?.type === "list" || n?.type === "keyword_list",
		);
		if (list) {
			const keywords = list.namedChildren.find((n) => n?.type === "keywords");
			const children = keywords?.namedChildren ?? list.namedChildren;
			for (const child of children) {
				if (!child) continue;
				if (child.type === "atom") {
					const key = child.text.replace(/^:/, "");
					if (key)
						fields[key] = { type: "any", originalType: "any" } as PopType;
				} else if (child.type === "pair" || child.type === "keyword_pair") {
					const key = child.namedChildren[0]?.text.replace(/:\s*$/, "").trim();
					if (key)
						fields[key] = { type: "any", originalType: "any" } as PopType;
				}
			}
		}

		this.addItem(moduleName, {
			type: "object",
			typeString: moduleName,
			fields,
		} as PopType);
	}

	private parseElixirType(text: string): PopType {
		const clean = text.replace(/\(\)$/, "");
		if (clean === "String.t" || text === "String.t") {
			return { type: "string" } as PopType;
		}

		const prim = ELIXIR_PRIMITIVES[clean] || ELIXIR_PRIMITIVES[text];
		if (prim) {
			if (prim === "bool")
				return { type: "boolean", binaryType: "bool" } as PopType;
			return { type: "number", binaryType: prim } as PopType;
		}

		if (text.startsWith("[") && text.endsWith("]")) {
			const inner = text.slice(1, -1).trim();
			return { type: "array", item: this.parseElixirType(inner) } as PopType;
		}

		return { type: "link", target: clean } as PopType;
	}
}

export function walkElixirFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkElixirOptions = {},
): WalkResult {
	const importer = new ElixirImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
