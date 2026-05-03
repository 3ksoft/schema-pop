import type { IRItem, IRType } from "./ir";

/**
 * Names schema-pop's `binary` + `bitwise` scopes always provide, plus
 * the `string` and `unknown` arktype keywords. Any IR `ref` to one of
 * these resolves natively at scope load.
 */
export const SCHEMA_POP_KNOWN_NAMES: ReadonlySet<string> = new Set([
	"string",
	"unknown",
	// binary primitives
	"u8", "u16", "u32", "u64", "u128",
	"i8", "i16", "i32", "i64", "i128",
	"f32", "f64", "bool",
	// bitwise primitives
	"u1", "u2", "u3", "u4", "u5", "u6", "u7",
]);

/**
 * Walk every type in `items`. References whose target name isn't in
 * scope (not a primitive, not a defined item, not in `extra`) become
 * `unknown` IR variants that emit as `OriginalType<unknown, 'X'>`.
 *
 * Without this pass, a walker that sees `MyExternalType` in source and
 * emits `ref("MyExternalType")` would generate a scope that fails to
 * load with `'MyExternalType' is unresolvable`. Downgrading the ref
 * keeps the scope loadable while preserving the original spelling on
 * the field's `originalType` for downstream tooling.
 *
 * Mutates `items` in place.
 */
export function downgradeUnknownRefs(
	items: IRItem[],
	extra?: readonly string[],
): void {
	const known = new Set<string>(SCHEMA_POP_KNOWN_NAMES);
	for (const item of items) known.add(item.name);
	if (extra) for (const n of extra) known.add(n);

	for (const item of items) {
		if (item.kind === "struct") {
			for (const f of item.fields) f.type = downgradeType(f.type, known);
		} else if (item.kind === "alias") {
			item.type = downgradeType(item.type, known);
		} else if (item.kind === "function") {
			item.returnType = downgradeType(item.returnType, known);
			for (const a of item.args) a.type = downgradeType(a.type, known);
		} else if (item.kind === "enum") {
			for (const v of item.variants) {
				if (v.kind === "tuple") {
					v.types = v.types.map((t) => downgradeType(t, known));
				} else if (v.kind === "struct") {
					for (const f of v.fields) f.type = downgradeType(f.type, known);
				}
			}
		}
	}
}

function downgradeType(t: IRType, known: Set<string>): IRType {
	switch (t.kind) {
		case "ref":
			return known.has(t.name) ? t : { kind: "unknown", raw: t.name };
		case "array":
			return { ...t, item: downgradeType(t.item, known) };
		case "vec":
			return { ...t, item: downgradeType(t.item, known) };
		case "option":
			return { ...t, inner: downgradeType(t.inner, known) };
		default:
			return t;
	}
}
