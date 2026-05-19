import { FieldPlan, LayoutPlan, StructPlan } from "@schema-pop/schema";
import { Node } from "web-tree-sitter";

const RUST_PTR_TYPES: Record<string, string> = {
	u8: "u8",
	u16: "u16",
	u32: "u32",
	u64: "u64",
	i8: "i8",
	i16: "i16",
	i32: "i32",
	i64: "i64",
	f32: "f32",
	f64: "f64",
	// UB-safe: read/write as u8, convert with != 0 at the boundary.
	bool: "u8",
	boolean: "u8",
};

function rustPtrType(f: FieldPlan): string {
	const t = f.type;
	if (t.kind === "primitive") return RUST_PTR_TYPES[(t as any).name] ?? "u8";
	return "u8";
}

function isBool(f: FieldPlan): boolean {
	if (f.type.kind !== "primitive") return false;
	const n = (f.type as any).name;
	return n === "bool" || n === "boolean";
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
): { rt: string; offset: number; isBool: boolean } | null {
	if (node.type !== "member_expression") return null;

	const objNode = node.childForFieldName("object")!;
	const prop = node.childForFieldName("property")?.text ?? "";

	if (objNode.type === "identifier" && objNode.text === paramName) {
		const struct = structs.get(paramTypeName);
		const field = struct?.fields.find((f) => f.name === prop);
		if (!field) return null;
		return {
			rt: rustPtrType(field),
			offset: field.offset,
			isBool: isBool(field),
		};
	}

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
	return {
		rt: rustPtrType(leafField),
		offset: baseOffset + leafField.offset,
		isBool: isBool(leafField),
	};
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
			if (r) {
				if (r.isBool)
					return `(*(src.as_ptr().add(${r.offset}) as *const u8) != 0)`;
				return `*(src.as_ptr().add(${r.offset}) as *const ${r.rt})`;
			}
			return `/* unresolved: ${node.text} */`;
		}
		case "binary_expression": {
			const left = node.childForFieldName("left");
			const right = node.childForFieldName("right");
			const rawOp =
				node.children
					.find(
						(n) =>
							n !== null &&
							!n.isNamed &&
							/^([+\-*/%^]|&&?|\|\|?|\?\?|<<=?|>>=?|===|!==|[<>!=]=?|[&|^]=?)$/.test(
								n.text.trim(),
							),
					)
					?.text.trim() ?? "+";
			const l = left ? emitExpr(left, structs, paramName, paramTypeName) : "0";
			const r = right
				? emitExpr(right, structs, paramName, paramTypeName)
				: "0";
			if (rawOp === "??") return `(if (${l}) != 0 { ${l} } else { ${r} })`;
			// TS strict equality operators map to Rust equality.
			const op = rawOp === "===" ? "==" : rawOp === "!==" ? "!=" : rawOp;
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
			return `(if (${l}) != 0 { ${l} } else { ${r} })`;
		}
		case "ternary_expression": {
			const cond = node.childForFieldName("condition");
			const cons = node.childForFieldName("consequence");
			const alt = node.childForFieldName("alternative");
			const c = cond
				? emitExpr(cond, structs, paramName, paramTypeName)
				: "false";
			const t = cons ? emitExpr(cons, structs, paramName, paramTypeName) : "0";
			const f = alt ? emitExpr(alt, structs, paramName, paramTypeName) : "0";
			return `(if ${c} { ${t} } else { ${f} })`;
		}
		case "parenthesized_expression": {
			const inner = node.namedChildren[0];
			return inner
				? `(${emitExpr(inner, structs, paramName, paramTypeName)})`
				: "0";
		}
		case "unary_expression": {
			const rawOp =
				node.children.find((n) => n !== null && !n.isNamed)?.text ?? "!";
			// ~ (bitwise NOT) maps to ! in Rust; unary + is a no-op.
			const op = rawOp === "~" ? "!" : rawOp;
			const arg = node.namedChildren[0];
			const argExpr = arg
				? emitExpr(arg, structs, paramName, paramTypeName)
				: "0";
			if (rawOp === "+") return argExpr;
			return `${op}${argExpr}`;
		}
		case "as_expression": {
			// `expr as Type` — strip the TS cast, emit the inner expression.
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
			if (callee.type === "identifier") {
				switch (callee.text) {
					case "Number":
						return `(${a0}) as f64`;
					case "BigInt":
						return `(${a0}) as i64`;
					case "Boolean":
						return `(${a0}) != 0`;
					case "parseInt":
						return `(${a0}) as i32`;
					case "parseFloat":
						return `(${a0}) as f32`;
				}
			}
			if (callee.type === "member_expression") {
				const obj = callee.childForFieldName("object");
				const method = callee.childForFieldName("property")?.text ?? "";
				if (obj?.text === "Math") {
					switch (method) {
						case "floor":
							return `(${a0}).floor()`;
						case "ceil":
							return `(${a0}).ceil()`;
						case "round":
							return `(${a0}).round()`;
						case "trunc":
							return `(${a0}).trunc()`;
						case "abs":
							return `(${a0}).abs()`;
						case "max":
							return `(${a0}).max(${a1})`;
						case "min":
							return `(${a0}).min(${a1})`;
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
			return "true";
		case "false":
			return "false";
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
 * body) into a Rust function that operates on raw byte slices using the field
 * offsets from `fromPlan` / `toPlan`.
 *
 * Signature of emitted Rust: `pub fn <fnName>(src: &[u8], dst: &mut [u8])`
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
		`pub fn ${fnName}(src: &[u8], dst: &mut [u8]) {`,
		`    unsafe {`,
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
			const dstPt = rustPtrType(dstField);
			// Always cast to the destination pointer type to handle numeric widening
			// (e.g. f32 → f64) and bool → u8 without relying on implicit coercions.
			lines.push(
				`        *(dst.as_mut_ptr().add(${dstField.offset}) as *mut ${dstPt}) = (${expr}) as ${dstPt};`,
			);
		} else if (pair.type === "shorthand_property_identifier") {
			const name = pair.text;
			const dstField = dstFieldsByName.get(name);
			const srcField = fromStructs
				.get(paramTypeName)
				?.fields.find((f) => f.name === name);
			if (!dstField || !srcField) continue;
			const srcPt = rustPtrType(srcField);
			const dstPt = rustPtrType(dstField);
			const readExpr = `*(src.as_ptr().add(${srcField.offset}) as *const ${srcPt})`;
			lines.push(
				`        *(dst.as_mut_ptr().add(${dstField.offset}) as *mut ${dstPt}) = (${readExpr}) as ${dstPt};`,
			);
		}
	}

	lines.push(`    }`);
	lines.push(`}`);
	return lines.join("\n") + "\n";
}
