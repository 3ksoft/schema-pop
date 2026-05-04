import type { Node as TSNode, Tree } from "web-tree-sitter";
import type { IRField, IRItem, SchemaPopIR, IRType } from "schema-pop";
import { downgradeUnknownRefs } from "./known-names";

export interface WalkGoOptions {
	extraKnownNames?: readonly string[];
}

const GO_PRIMITIVES: Record<string, IRType> = {
	int: { kind: "primitive", name: "i64" },
	int8: { kind: "primitive", name: "i8" },
	int16: { kind: "primitive", name: "i16" },
	int32: { kind: "primitive", name: "i32" },
	int64: { kind: "primitive", name: "i64" },
	uint: { kind: "primitive", name: "u64" },
	uint8: { kind: "primitive", name: "u8" },
	uint16: { kind: "primitive", name: "u16" },
	uint32: { kind: "primitive", name: "u32" },
	uint64: { kind: "primitive", name: "u64" },
	float32: { kind: "primitive", name: "f32" },
	float64: { kind: "primitive", name: "f64" },
	bool: { kind: "primitive", name: "bool" },
	string: { kind: "string" },
	byte: { kind: "primitive", name: "u8" },
	rune: { kind: "primitive", name: "i32" },
};

function isExported(name: string) {
	return name.length > 0 && name[0] === name[0].toUpperCase();
}

export function walkGoFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkGoOptions = {},
): SchemaPopIR {
	const items: IRItem[] = [];
	const skipped: { name: string; reason: string }[] = [];

	function traverse(node: TSNode) {
		let pendingDoc: string[] = [];

		function walk(n: TSNode) {
			for (const child of n.namedChildren) {
				if (!child) continue;

				if (child.type === "comment") {
					pendingDoc.push(child.text.replace(/^\/\/\s?/, ""));
					continue;
				}

				const description = pendingDoc.length
					? pendingDoc.join("\n")
					: undefined;
				pendingDoc = [];

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
							if (!isExported(name)) continue;

							if (typeNode.type === "struct_type") {
								const list =
									typeNode.namedChildren.find(
										(c) => c && c.type === "field_declaration_list",
									) || typeNode;
								const fields: IRField[] = [];
								let fieldDoc: string[] = [];

								for (const c of list.namedChildren) {
									if (!c) continue;
									if (c.type === "comment") {
										fieldDoc.push(c.text.replace(/^\/\/\s?/, ""));
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
											fieldDoc = [];
											continue;
										}

										const t = parseGoType(tNode);
										const fDoc = fieldDoc.length
											? fieldDoc.join("\n")
											: undefined;

										if (names.length === 0) {
											const embedName =
												tNode.text.split(".").pop()?.replace(/^\*/, "") ||
												tNode.text;
											if (isExported(embedName)) {
												fields.push({
													name: embedName,
													type: t,
													description: fDoc,
													pub: true,
												});
											}
										} else {
											for (const nNode of names) {
												if (nNode && isExported(nNode.text)) {
													fields.push({
														name: nNode.text,
														type: t,
														description: fDoc,
														pub: true,
													});
												}
											}
										}
									}
									fieldDoc = [];
								}
								items.push({
									kind: "struct",
									name,
									fields,
									description,
									pub: true,
								});
							} else if (typeNode.type !== "interface_type") {
								items.push({
									kind: "alias",
									name,
									type: parseGoType(typeNode),
									description,
									pub: true,
								});
							}
						}
					}
				} else {
					walk(child);
				}
			}
		}
		walk(node);
	}
	traverse(tree.rootNode);
	downgradeUnknownRefs(items, opts.extraKnownNames);
	return { source: sourcePath, items, skipped };
}

function parseGoType(node: TSNode): IRType {
	if (node.type === "type_identifier" || node.type === "identifier") {
		const prim = GO_PRIMITIVES[node.text];
		if (prim) return prim;
		return { kind: "ref", name: node.text };
	}
	if (node.type === "pointer_type") {
		const inner = node.namedChildren[0];
		return {
			kind: "optional",
			inner: inner ? parseGoType(inner) : { kind: "unknown", raw: "any" },
		};
	}
	if (node.type === "slice_type") {
		const inner = node.childForFieldName("element") || node.namedChildren[0];
		return {
			kind: "array",
			item: inner ? parseGoType(inner) : { kind: "unknown", raw: "any" },
		};
	}
	if (node.type === "array_type") {
		const lenNode = node.childForFieldName("length");
		const elNode = node.childForFieldName("element");
		const item = (
			elNode ? parseGoType(elNode) : { kind: "unknown", raw: "any" }
		) as IRType;
		const len = lenNode ? parseInt(lenNode.text, 10) : NaN;
		if (!isNaN(len)) {
			return { kind: "array", item, exactLength: len };
		}
		return { kind: "array", item };
	}
	if (node.type === "qualified_type") {
		const pkg = node.childForFieldName("package")?.text;
		const name = node.childForFieldName("name")?.text;
		if (pkg && name) return { kind: "ref", name: `${pkg}.${name}` };
	}
	return { kind: "unknown", raw: node.text };
}
