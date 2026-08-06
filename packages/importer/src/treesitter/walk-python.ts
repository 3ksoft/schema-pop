import type { PopType } from "@schema-pop/schema";
import type { Tree, Node as TSNode } from "web-tree-sitter";
import { BaseImporter, WalkResult } from "../toolkit";

export interface WalkPythonOptions {
	extraKnownNames?: readonly string[];
}

const PYTHON_PRIMITIVES: Record<string, string> = {
	int: "i64",
	float: "f64",
	boolean: "boolean",
};

export class PythonImporter extends BaseImporter {
	static readonly importerInfo = {
		name: "Python",
		supportedExtensions: [".py"],
	};

	public walkTree(tree: Tree): WalkResult {
		this.visit(tree.rootNode);
		return this.finalize();
	}

	private visit(node: TSNode): void {
		for (const child of node.namedChildren) {
			if (!child) continue;

			if (child.type === "expression_statement") {
				const stringNode = child.namedChildren[0];
				if (child.namedChildren.length === 1 && stringNode?.type === "string") {
					const text = stringNode.text.replace(/^["']{3}|["']{3}$/g, "").trim();
					if (text) this.docs.addCommentNode(`/// ${text}`);
					continue;
				}
			}

			if (child.type === "comment") {
				this.docs.addCommentNode(child.text);
				continue;
			}

			const description = this.docs.consume();

			if (child.type === "class_definition") {
				this.handleClass(child, description);
			} else {
				this.visit(child);
			}
		}
	}

	private handleClass(node: TSNode, description: string | undefined): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) return;

		let isEnum = false;
		const supers = node.childForFieldName("superclasses");
		if (supers) {
			const superTexts = supers.namedChildren.map((c) => c?.text);
			if (
				superTexts.some(
					(t) => t && (t.includes("Enum") || t.includes("IntEnum")),
				)
			) {
				isEnum = true;
			}
		}

		const body = node.childForFieldName("body");
		if (!body) return;

		if (isEnum) {
			const options: string[] = [];
			const handleEnumAssignment = (assign: TSNode): void => {
				const left =
					assign.childForFieldName("left") || assign.namedChildren[0];
				if (left) options.push(left.text);
				this.docs.clear();
			};
			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "comment") {
					this.docs.addCommentNode(c.text);
					continue;
				}
				if (c.type === "assignment") {
					handleEnumAssignment(c);
					continue;
				}
				if (c.type === "expression_statement") {
					const stringNode = c.namedChildren[0];
					if (c.namedChildren.length === 1 && stringNode?.type === "string") {
						const text = stringNode.text
							.replace(/^["']{3}|["']{3}$/g, "")
							.trim();
						if (text) this.docs.addCommentNode(`/// ${text}`);
						continue;
					}

					const assign = c.namedChildren.find((n) => n?.type === "assignment");
					if (assign) handleEnumAssignment(assign);
					else this.docs.clear();
				}
			}

			this.addItem(
				name,
				{ type: "enum", typeString: name, options } as PopType,
				description,
			);
		} else {
			const fields: Record<string, PopType> = {};
			let classDescription = description;

			const handleAssignment = (assign: TSNode): void => {
				const nameNode =
					assign.childForFieldName("left") ??
					assign.namedChildren[0] ??
					null;
				const typeNode =
					assign.childForFieldName("type") ??
					assign.namedChildren.find((n) => n?.type === "type") ??
					null;
				if (nameNode && typeNode) {
					const fDoc = this.docs.consume();
					const fType = this.parsePythonType(typeNode);
					if (fDoc) fType.description = fDoc;
					fields[nameNode.text] = fType;
				}
				this.docs.clear();
			};

			const handleStringNode = (stringNode: TSNode): void => {
				const text = stringNode.text
					.replace(/^["']{3}|["']{3}$/g, "")
					.replace(/^["']|["']$/g, "")
					.trim();
				if (!text) return;
				if (Object.keys(fields).length === 0 && !classDescription) {
					classDescription = text;
				} else if (Object.keys(fields).length > 0) {
					// trailing docstring — attach to the last-added field.
					const lastFieldKey = Object.keys(fields).at(-1);
					if (lastFieldKey && !fields[lastFieldKey]!.description) {
						fields[lastFieldKey]!.description = text;
					}
				}
			};

			for (const c of body.namedChildren) {
				if (!c) continue;
				if (c.type === "comment") {
					this.docs.addCommentNode(c.text);
					continue;
				}
				if (c.type === "string") {
					handleStringNode(c);
					continue;
				}
				if (c.type === "assignment") {
					handleAssignment(c);
					continue;
				}
				if (c.type === "expression_statement") {
					const stringNode = c.namedChildren[0];
					if (c.namedChildren.length === 1 && stringNode?.type === "string") {
						handleStringNode(stringNode);
						continue;
					}

					const assign = c.namedChildren.find((n) => n?.type === "assignment");
					if (assign) {
						handleAssignment(assign);
					} else {
						const typeNode =
							c.namedChildren.find((n) => n?.type === "type") ?? null;
						const nameNode = typeNode ? c.namedChildren[0] : null;
						if (nameNode && typeNode) {
							const fDoc = this.docs.consume();
							const fType = this.parsePythonType(typeNode);
							if (fDoc) fType.description = fDoc;
							fields[nameNode.text] = fType;
						}
						this.docs.clear();
					}
				}
			}

			this.addItem(
				name,
				{ type: "object", typeString: name, fields } as PopType,
				classDescription,
			);
		}
	}

	private parsePythonType(node: TSNode): PopType {
		if (node.type === "type") {
			const inner = node.namedChildren[0];
			if (inner) return this.parsePythonType(inner);
		}

		if (node.type === "index") {
			const inner = node.namedChildren[0];
			if (inner) return this.parsePythonType(inner);
		}

		if (node.type === "identifier" || node.type === "none") {
			const text = node.text;
			if (text === "None")
				return { type: "any", originalType: "None" } as PopType;
			if (text === "str") return { type: "string" } as PopType;
			if (text === "bytes")
				return {
					type: "array",
					item: { type: "number", binaryType: "u8" },
				} as PopType;
			const prim = PYTHON_PRIMITIVES[text];
			if (prim) {
				if (prim === "boolean")
					return { type: "boolean", binaryType: "boolean" } as PopType;
				return { type: "number", binaryType: prim } as PopType;
			}
			return { type: "link", target: text } as PopType;
		}

		if (node.type === "generic_type") {
			const nameNode = node.namedChildren[0];
			const paramNode = node.namedChildren[1];
			const name = nameNode?.text;
			const firstInner = paramNode?.namedChildren[0];
			if (firstInner && name) {
				if (name === "list" || name === "List" || name === "Sequence") {
					return {
						type: "array",
						item: this.parsePythonType(firstInner),
					} as PopType;
				}
				if (name === "Optional") {
					const inner = this.parsePythonType(firstInner);
					(inner as any).required = false;
					return inner;
				}
			}
			return { type: "any", originalType: node.text } as PopType;
		}

		if (node.type === "subscript") {
			const value = node.childForFieldName("value");
			const name = value?.text;
			const subs = node.namedChildren.filter((n) => n && n !== value);
			const firstSub = subs[0];
			if (firstSub && name) {
				if (name === "list" || name === "List" || name === "Sequence") {
					return {
						type: "array",
						item: this.parsePythonType(firstSub),
					} as PopType;
				}
				if (name === "Optional") {
					const inner = this.parsePythonType(firstSub);
					(inner as any).required = false;
					return inner;
				}
			}
			return { type: "any", originalType: node.text } as PopType;
		}

		if (node.type === "binary_operator") {
			const left =
				node.childForFieldName("left") ?? node.namedChildren[0] ?? null;
			const right =
				node.childForFieldName("right") ?? node.namedChildren[1] ?? null;
			if (right?.type === "none" || right?.text === "None") {
				const inner = this.parsePythonType(left!);
				(inner as any).required = false;
				return inner;
			}
			if (left?.type === "none" || left?.text === "None") {
				const inner = this.parsePythonType(right!);
				(inner as any).required = false;
				return inner;
			}
		}

		return { type: "any", originalType: node.text } as PopType;
	}
}

export function walkPythonFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkPythonOptions = {},
): WalkResult {
	const importer = new PythonImporter(sourcePath, opts);
	return importer.walkTree(tree);
}
