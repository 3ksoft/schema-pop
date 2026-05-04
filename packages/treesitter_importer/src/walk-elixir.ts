import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkElixirOptions {
	extraKnownNames?: readonly string[];
}

const ELIXIR_PRIMITIVES: Record<string, IRType> = {
	integer: { kind: "primitive", name: "i64" },
	float: { kind: "primitive", name: "f64" },
	boolean: { kind: "primitive", name: "bool" },
	"String.t": { kind: "string" },
};

export function walkElixirFile(tree: Tree, sourcePath: string, opts: WalkElixirOptions = {}): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		function walk(n: TSNode) {
			// Tree-sitter Elixir parses defmodule as a call
			if (n.type === "call" && n.namedChildren[0]?.text === "defmodule") {
				const nameNode = n.namedChildren[1];
				const name = nameNode?.text.replace(/^[^A-Z]+/, ""); // strip aliases if parsed weirdly
				
				const block = n.namedChildren.find(c => c && c.type === "do_block");
				if (name && block) {
					// Look for @type t :: %{...} or %__MODULE__{...} inside the module
					const typeCall = findTypeCall(block);
					if (typeCall) {
						const item = handleTypeCall(typeCall, name);
						if (item) items.push(item);
					} else {
						// Fallback to plain defstruct if @type not found
						const defstruct = findDefstruct(block);
						if (defstruct) {
							const item = handleDefstruct(defstruct, name);
							if (item) items.push(item);
						}
					}
				}
			}
			for (const child of n.namedChildren) {
				if (child) walk(child);
			}
		}
		walk(node);
	}

	traverse(tree.rootNode);
	downgradeUnknownRefs(items, opts.extraKnownNames);
	return { source: sourcePath, items, skipped };
}

function findTypeCall(block: TSNode): TSNode | null {
	for (const c of block.namedChildren) {
		if (c && c.type === "unary_operator" && c.text.startsWith("@type")) return c;
		const found = c ? findTypeCall(c) : null;
		if (found) return found;
	}
	return null;
}

function findDefstruct(block: TSNode): TSNode | null {
	for (const c of block.namedChildren) {
		if (c && c.type === "call" && c.namedChildren[0]?.text === "defstruct") return c;
		const found = c ? findDefstruct(c) : null;
		if (found) return found;
	}
	return null;
}

function handleTypeCall(node: TSNode, moduleName: string): IRItem | null {
	const fields: IRField[] = [];

	// Elixir AST: unary_operator(@type) → call → arguments → binary_operator → map
	const callNode = node.namedChildren.find(n => n?.type === "call");
	const argsNode = callNode?.namedChildren.find(n => n?.type === "arguments");
	const binaryOp = argsNode?.namedChildren.find(n => n?.type === "binary_operator");
	if (!binaryOp) return null;

	const mapNode = binaryOp.namedChildren.find(n => n?.type === "map");
	if (mapNode) {
		// map → map_content → keywords → pair(s)
		const content = mapNode.namedChildren.find(n => n?.type === "map_content");
		const keywords = content?.namedChildren.find(n => n?.type === "keywords") ?? content;
		const pairNodes = keywords?.namedChildren ?? [];
		for (const pair of pairNodes) {
			if (!pair || pair.type !== "pair") continue;
			const key = pair.namedChildren[0]?.text.replace(/:\s*$/, "").trim();
			const typeStr = pair.namedChildren[1]?.text;
			if (key && typeStr) {
				fields.push({ name: key, type: parseElixirType(typeStr), pub: true });
			}
		}
	}

	return fields.length > 0 ? { kind: "struct", name: moduleName, fields, pub: true } : null;
}

function handleDefstruct(node: TSNode, moduleName: string): IRItem | null {
	const fields: IRField[] = [];
	const args = node.namedChildren.find(n => n?.type === "arguments");
	if (!args) return null;

	const list = args.namedChildren.find(n => n?.type === "list" || n?.type === "keyword_list");
	if (list) {
		// Elixir list can be atoms [:x, :y] or keyword list [items: [], tag: nil]
		// keyword list is stored as list → keywords → pair(s)
		const keywords = list.namedChildren.find(n => n?.type === "keywords");
		const children = keywords?.namedChildren ?? list.namedChildren;
		for (const child of children) {
			if (!child) continue;
			if (child.type === "atom") {
				const key = child.text.replace(/^:/, "");
				if (key) fields.push({ name: key, type: { kind: "unknown", raw: "any" }, pub: true });
			} else if (child.type === "pair" || child.type === "keyword_pair") {
				const key = child.namedChildren[0]?.text.replace(/:\s*$/, "").trim();
				if (key) fields.push({ name: key, type: { kind: "unknown", raw: "any" }, pub: true });
			}
		}
	}
	return { kind: "struct", name: moduleName, fields, pub: true };
}

function parseElixirType(text: string): IRType {
	const clean = text.replace(/\(\)$/, ""); // strip t() -> t
	const prim = ELIXIR_PRIMITIVES[clean] || ELIXIR_PRIMITIVES[text];
	if (prim) return prim;

	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1).trim();
		return { kind: "array", item: parseElixirType(inner) };
	}

	return { kind: "ref", name: clean };
}
