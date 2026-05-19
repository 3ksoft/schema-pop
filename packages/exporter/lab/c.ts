import { parseSource } from "@schema-pop/importer";
import type { FieldPlan, LayoutPlan, StructPlan } from "@schema-pop/schema";
import type { Node } from "web-tree-sitter";

const C_TYPES: Record<string, string> = {
	u8: "uint8_t",
	u16: "uint16_t",
	u32: "uint32_t",
	u64: "uint64_t",
	i8: "int8_t",
	i16: "int16_t",
	i32: "int32_t",
	i64: "int64_t",
	f32: "float",
	f64: "double",
	bool: "bool",
	boolean: "bool",
};

function cType(f: FieldPlan): string {
	const t = f.type;
	if (t.kind === "primitive") return C_TYPES[(t as any).name] ?? "uint32_t";
	if (t.kind === "reference") return C_TYPES[(t as any).name] ?? "uint32_t";
	return "uint8_t";
}

function structMap(plan: LayoutPlan): Map<string, StructPlan> {
	const m = new Map<string, StructPlan>();
	for (const t of plan.types)
		if (t.kind === "struct") m.set(t.name, t as StructPlan);
	return m;
}

function buildChain(node: Node, paramName: string): string[] | null {
	if (node.type === "identifier") return node.text === paramName ? [] : null;
	if (node.type !== "member_expression") return null;
	const obj = node.childForFieldName("object")!;
	const prop = node.childForFieldName("property")?.text ?? "";
	const chain = buildChain(obj, paramName);
	if (!chain) return null;
	return [...chain, prop];
}

function resolveMember(
	node: Node,
	structs: Map<string, StructPlan>,
	paramName: string,
	paramTypeName: string,
): { ct: string; offset: number } | null {
	if (node.type !== "member_expression") return null;

	const objNode = node.childForFieldName("object")!;
	const prop = node.childForFieldName("property")?.text ?? "";

	if (objNode.type === "identifier" && objNode.text === paramName) {
		const struct = structs.get(paramTypeName);
		const field = struct?.fields.find((f) => f.name === prop);
		if (!field) return null;
		return { ct: cType(field), offset: field.offset };
	}

	// Nested access: v1.rx_pattern_pos.wr — walk the chain to accumulate offset.
	const chain = buildChain(objNode, paramName);
	if (!chain) return null;

	let currentStruct = structs.get(paramTypeName);
	let baseOffset = 0;
	for (const fieldName of chain) {
		const field = currentStruct?.fields.find((f) => f.name === fieldName);
		if (!field) return null;
		baseOffset += field.offset;
		const ref =
			field.type.kind === "reference" ? (field.type as any).name : null;
		if (ref) currentStruct = structs.get(ref);
	}
	const leafField = currentStruct?.fields.find((f) => f.name === prop);
	if (!leafField) return null;
	return { ct: cType(leafField), offset: baseOffset + leafField.offset };
}

function emitExpr(
	node: Node,
	structs: Map<string, StructPlan>,
	paramName: string,
	paramTypeName: string,
): string {
	switch (node.type) {
		case "member_expression": {
			const r = resolveMember(node, structs, paramName, paramTypeName);
			if (r) return `*(${r.ct}*)(src + ${r.offset})`;
			return `/* unresolved: ${node.text} */`;
		}
		case "binary_expression": {
			const left = node.childForFieldName("left");
			const right = node.childForFieldName("right");
			const op =
				node.children
					.find(
						(n) =>
							n !== null &&
							!n.isNamed &&
							/^([+\-*/%^]|&&?|\|\|?|\?\?|<<=?|>>=?|[<>!=]=?|[&|^]=?)$/.test(
								n.text.trim(),
							),
					)
					?.text.trim() ?? "+";
			const l = left ? emitExpr(left, structs, paramName, paramTypeName) : "0";
			const r = right
				? emitExpr(right, structs, paramName, paramTypeName)
				: "0";
			// ?? has no C equivalent; double-evaluation of lhs is safe for field reads.
			if (op === "??") return `((${l}) != 0 ? (${l}) : (${r}))`;
			return `(${l} ${op} ${r})`;
		}
		// Older tree-sitter-typescript versions emit a dedicated node for ??.
		case "nullish_coalescing_expression": {
			const left = node.childForFieldName("left");
			const right = node.childForFieldName("right");
			const l = left ? emitExpr(left, structs, paramName, paramTypeName) : "0";
			const r = right
				? emitExpr(right, structs, paramName, paramTypeName)
				: "0";
			return `((${l}) != 0 ? (${l}) : (${r}))`;
		}
		case "ternary_expression": {
			const cond = node.childForFieldName("condition");
			const cons = node.childForFieldName("consequence");
			const alt = node.childForFieldName("alternative");
			return `(${cond ? emitExpr(cond, structs, paramName, paramTypeName) : "0"} ? ${cons ? emitExpr(cons, structs, paramName, paramTypeName) : "0"} : ${alt ? emitExpr(alt, structs, paramName, paramTypeName) : "0"})`;
		}
		case "parenthesized_expression": {
			const inner = node.namedChildren[0];
			return inner
				? `(${emitExpr(inner, structs, paramName, paramTypeName)})`
				: "0";
		}
		case "unary_expression": {
			const op =
				node.children.find((n) => n !== null && !n.isNamed)?.text ?? "!";
			const arg = node.namedChildren[0];
			return `${op}${arg ? emitExpr(arg, structs, paramName, paramTypeName) : "0"}`;
		}
		case "as_expression": {
			// `expr as Type` — strip the cast, emit the inner expression.
			const inner =
				node.childForFieldName("value") ??
				node.namedChildren.find((n) => n !== null) ??
				null;
			return inner ? emitExpr(inner, structs, paramName, paramTypeName) : "0";
		}
		case "call_expression": {
			const callee = node.childForFieldName("function");
			const argsNode = node.childForFieldName("arguments");
			const args = (argsNode?.namedChildren ?? []).filter(
				(n): n is Node => n !== null,
			);
			const a0 = args[0]
				? emitExpr(args[0], structs, paramName, paramTypeName)
				: "0";
			const a1 = args[1]
				? emitExpr(args[1], structs, paramName, paramTypeName)
				: "0";
			if (!callee) return `/* unresolved call */`;
			// Global cast/conversion functions.
			if (callee.type === "identifier") {
				switch (callee.text) {
					case "Number":
						return `(double)(${a0})`;
					case "BigInt":
						return `(int64_t)(${a0})`;
					case "Boolean":
						return `((${a0}) != 0)`;
					case "parseInt":
						return `(int32_t)(${a0})`;
					case "parseFloat":
						return `(float)(${a0})`;
				}
			}
			// Math.* — requires <math.h> (included in the file header).
			if (callee.type === "member_expression") {
				const obj = callee.childForFieldName("object");
				const method = callee.childForFieldName("property")?.text ?? "";
				if (obj?.text === "Math") {
					switch (method) {
						case "floor":
							return `floor(${a0})`;
						case "ceil":
							return `ceil(${a0})`;
						case "round":
							return `round(${a0})`;
						case "trunc":
							return `trunc(${a0})`;
						case "abs":
							return `((${a0}) < 0 ? -(${a0}) : (${a0}))`;
						case "max":
							return `((${a0}) > (${a1}) ? (${a0}) : (${a1}))`;
						case "min":
							return `((${a0}) < (${a1}) ? (${a0}) : (${a1}))`;
					}
				}
			}
			return `/* unresolved call: ${node.text} */`;
		}
		case "number":
			return node.text;
		case "string":
			return node.text;
		case "true":
			return "1";
		case "false":
			return "0";
		case "null":
		case "undefined":
			return "0";
		case "identifier":
			return `/* unresolved identifier: ${node.text} */`;
		default:
			return `/* ${node.type}: ${node.text} */`;
	}
}

/**
 * Compiles a TypeScript migration function (erasable-syntax, `return { ... }`
 * body) into a C function that operates on raw byte buffers using the field
 * offsets from `fromPlan` / `toPlan`.
 *
 * Signature of emitted C: `void <fnName>(const uint8_t* src, uint8_t* dst)`
 */
export async function compileMigration(
	source: string,
	fromPlan: LayoutPlan,
	toPlan: LayoutPlan,
): Promise<string> {
	const tree = await parseSource("typescript", source);
	const fn = tree.rootNode.namedChildren.find(
		(n) => n !== null && n.type === "function_declaration",
	);
	if (!fn) throw new Error("No function declaration found");

	const fnName = fn.childForFieldName("name")?.text ?? "migrate";

	const firstParam = fn
		.childForFieldName("parameters")
		?.namedChildren.find((n) => n !== null && n.type === "required_parameter");
	const paramName = firstParam?.childForFieldName("pattern")?.text ?? "v1";
	const paramTypeNode = firstParam
		?.childForFieldName("type")
		?.namedChildren.find(
			(n) =>
				n !== null &&
				(n.type === "type_identifier" || n.type === "member_expression"),
		);
	const paramTypeName =
		paramTypeNode?.type === "member_expression"
			? (paramTypeNode.childForFieldName("property")?.text ?? "")
			: (paramTypeNode?.text ?? "");

	const body = fn.childForFieldName("body");
	const returnObj = body?.namedChildren
		.find((n) => n !== null && n.type === "return_statement")
		?.namedChildren.find((n) => n !== null && n.type === "object");
	if (!returnObj)
		throw new Error("Expected `return { ... }` in migration body");

	const fromStructs = structMap(fromPlan);
	const toStructs = structMap(toPlan);

	const retTypeNode = fn
		.childForFieldName("return_type")
		?.namedChildren.find(
			(n) =>
				n !== null &&
				(n.type === "type_identifier" || n.type === "member_expression"),
		);
	const retTypeName =
		retTypeNode?.type === "member_expression"
			? (retTypeNode.childForFieldName("property")?.text ?? "")
			: (retTypeNode?.text ?? "");
	const dstStruct = toStructs.get(retTypeName) ?? toStructs.get(paramTypeName);
	if (!dstStruct)
		throw new Error(
			`Cannot find destination struct "${retTypeName || paramTypeName}" in toPlan`,
		);

	const dstFieldsByName = new Map(dstStruct.fields.map((f) => [f.name, f]));

	const lines: string[] = [
		`#include <stdint.h>`,
		`#include <stdbool.h>`,
		`#include <math.h>`,
		``,
		`void ${fnName}(const uint8_t* src, uint8_t* dst) {`,
	];

	for (const pair of returnObj.namedChildren.filter(
		(n): n is Node => n !== null,
	)) {
		if (pair.type === "pair") {
			const destName = pair.childForFieldName("key")?.text ?? "";
			const valueNode = pair.childForFieldName("value");
			const dstField = dstFieldsByName.get(destName);
			if (!dstField || !valueNode) continue;
			const expr = emitExpr(valueNode, fromStructs, paramName, paramTypeName);
			lines.push(
				`    *(${cType(dstField)}*)(dst + ${dstField.offset}) = ${expr};`,
			);
		} else if (pair.type === "shorthand_property_identifier") {
			const name = pair.text;
			const dstField = dstFieldsByName.get(name);
			const srcField = fromStructs
				.get(paramTypeName)
				?.fields.find((f) => f.name === name);
			if (!dstField || !srcField) continue;
			lines.push(
				`    *(${cType(dstField)}*)(dst + ${dstField.offset}) = *(${cType(srcField)}*)(src + ${srcField.offset});`,
			);
		}
	}

	lines.push(`}`);
	return lines.join("\n") + "\n";
}
