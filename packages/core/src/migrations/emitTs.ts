import type { Field, LayoutPlan, TypePlan } from "@schema-pop/schema";
import type { FieldOp, MigrationPlan, TypeMigration } from "./resolve";

/**
 * TypeScript emitter for a resolved `MigrationPlan` (codec-level migrations).
 *
 * Emits, per migrated type:
 *  - `transform<T>(v1: V1.T): V2.T` — the pure data transform (auto ops + hook
 *    calls), the "functions modifying data" surface.
 *  - `migrate<T>(v1Bytes): Uint8Array` — a thin byte wrapper that runs the v1
 *    codec's `deserialize`, the transform, then the v2 codec's `serialize`
 *    (emitted only for fixed-size types; variable-size types get transform only).
 *
 * NOTE this is imperative, not a standard single-plan `ExporterPlugin` — it
 * takes a two-version `MigrationPlan`. It is excluded from the CLI single-plan
 * dispatch (like the GPU trio); call it directly. See docs/migrations-plan.md.
 */
export interface TsMigrationConfig {
	/** Import specifier for the v1 TYPE declarations (default export namespace). */
	v1TypesImport: string;
	/** Import specifier for the v2 TYPE declarations. */
	v2TypesImport: string;
	/** Import specifier for the v1 codec (serialize/deserialize/SIZEOF). */
	v1CodecImport: string;
	/** Import specifier for the v2 codec. */
	v2CodecImport: string;
	/** Import specifier for the user's MigrationHooks registry (omit if none). */
	hooksImport?: string;
	/** Named export of the hooks registry in `hooksImport`. Default "migrationHooks". */
	hooksExport?: string;
	/** Namespace alias for v1 types. Default "V1". */
	v1Alias?: string;
	/** Namespace alias for v2 types. Default "V2". */
	v2Alias?: string;
	/** Emit `migrate<T>` byte wrappers. Default true. */
	emitByteWrappers?: boolean;
}

/** Sanitize a schema type name into a safe TS identifier fragment. */
function ident(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Zero value literal for an auto-added field with no explicit default. */
function zeroValue(field: Field): string {
	switch (field.kind) {
		case "primitive": {
			const n = (field as any).name;
			if (n === "bool" || n === "boolean") return "false";
			if (n === "u64" || n === "i64") return "0";
			return "0";
		}
		case "string":
			return '""';
		case "array":
			return "[]";
		case "optional":
			return "undefined";
		default:
			return "undefined as any";
	}
}

/** Does a type serialize to a fixed byte size (so `SIZEOF_<T>` is allocatable)? */
function isFixedSize(t: TypePlan, plan: LayoutPlan): boolean {
	if (t.kind === "enum") return false;
	const sz = (t as any).paddedSize ?? (t as any).size ?? 0;
	if (sz <= 0) return false;

	const byName = new Map(plan.types.map((x) => [x.name, x]));
	const seen = new Set<string>();
	const fieldFixed = (f: Field): boolean => {
		switch (f.kind) {
			case "primitive":
			case "unit":
				return true;
			case "string":
				return false; // length-prefixed, variable
			case "array":
				// Fixed only when the length is compile-time known.
				return (f as any).exactLength !== undefined && fieldFixed((f as any).item);
			case "optional":
				return false; // presence byte + variable payload
			case "map":
			case "any":
				return false;
			case "inlineStruct":
				return (f as any).fields.every((sf: any) => fieldFixed(sf.type));
			case "reference": {
				const name = (f as any).name;
				if (seen.has(name)) return true;
				seen.add(name);
				const ref = byName.get(name);
				return ref ? typeFixed(ref) : false;
			}
			default:
				return false;
		}
	};
	const typeFixed = (tp: TypePlan): boolean => {
		if (tp.kind === "struct")
			return (tp as any).fields.every((f: any) => fieldFixed(f.type));
		if (tp.kind === "alias") return fieldFixed((tp as any).type);
		if (tp.kind === "union" || tp.kind === "enum") return true;
		return false;
	};
	return typeFixed(t);
}

/** Expression for a non-hook op. `hookField` is handled by the caller (it needs
 * the enclosing type name to index the hooks registry). */
function opExpr(op: Exclude<FieldOp, { kind: "hookField" }>): string {
	switch (op.kind) {
		case "copy":
			return `v1.${op.from}`;
		case "copyTransformed":
			return `transform${ident(op.refType)}(v1.${op.from} as any)`;
		case "defaultLiteral":
			return JSON.stringify(op.value);
		case "defaultZero":
			return zeroValue(op.field.type);
	}
}

export function emitTsMigration(
	plan: MigrationPlan,
	config: TsMigrationConfig,
): string {
	const v1 = config.v1Alias ?? "V1";
	const v2 = config.v2Alias ?? "V2";
	const hooksExport = config.hooksExport ?? "migrationHooks";
	const hooksRef = config.hooksImport ? hooksExport : null;
	const emitBytes = config.emitByteWrappers ?? true;

	const toByName = new Map(plan.to.types.map((t) => [t.name, t]));

	let header = "";
	header += `import type * as ${v1} from ${JSON.stringify(config.v1TypesImport)};\n`;
	header += `import type * as ${v2} from ${JSON.stringify(config.v2TypesImport)};\n`;
	if (emitBytes) {
		header += `import * as __v1codec from ${JSON.stringify(config.v1CodecImport)};\n`;
		header += `import * as __v2codec from ${JSON.stringify(config.v2CodecImport)};\n`;
	}
	if (config.hooksImport) {
		header += `import { ${hooksExport} } from ${JSON.stringify(config.hooksImport)};\n`;
	}
	header += "\n";

	let body = "";

	const transformFn = (tm: TypeMigration): string => {
		if (tm.kind === "added" || tm.kind === "removed") return "";
		const toName = tm.toName;
		const fromName = tm.name;
		const sig = `export function transform${ident(toName)}(v1: ${v1}.${ident(fromName)}): ${v2}.${ident(toName)}`;

		if (tm.kind === "identity") {
			return `${sig} {\n\treturn v1 as unknown as ${v2}.${ident(toName)};\n}\n\n`;
		}
		if (tm.kind === "wholeHook") {
			return (
				`${sig} {\n` +
				`\treturn (${hooksRef}!.${ident(toName)} as (v1: any) => any)(v1);\n}\n\n`
			);
		}
		// fields
		let fn = `${sig} {\n\treturn {\n`;
		for (const op of tm.ops) {
			const expr =
				op.kind === "hookField"
					? `(${hooksRef}!.${ident(toName)} as any).${op.to}(v1)`
					: opExpr(op);
			fn += `\t\t${op.to}: ${expr},\n`;
		}
		fn += `\t} as ${v2}.${ident(toName)};\n}\n\n`;
		return fn;
	};

	const migrateFn = (tm: TypeMigration): string => {
		if (!emitBytes) return "";
		if (tm.kind === "added" || tm.kind === "removed") return "";
		const toName = tm.toName;
		const fromName = tm.name;
		const fromType = plan.from.types.find((t) => t.name === fromName);
		const toType = toByName.get(toName);
		if (!fromType || !toType) return "";
		// Byte wrapper needs a codec on both sides + a fixed alloc size on v2.
		if (!isFixedSize(fromType, plan.from) || !isFixedSize(toType, plan.to)) {
			return (
				`// migrate${ident(toName)}: skipped byte wrapper — ${ident(toName)} is variable-size;\n` +
				`//   use transform${ident(toName)} with your own (de)serialization.\n\n`
			);
		}
		return (
			`export function migrate${ident(toName)}(v1Bytes: Uint8Array): Uint8Array {\n` +
			`\tconst v1View = new DataView(v1Bytes.buffer, v1Bytes.byteOffset, v1Bytes.byteLength);\n` +
			`\tconst v1Obj = __v1codec.deserialize${ident(fromName)}(v1View, 0);\n` +
			`\tconst v2Obj = transform${ident(toName)}(v1Obj);\n` +
			`\tconst out = new Uint8Array(__v2codec.SIZEOF_${ident(toName)});\n` +
			`\tconst v2View = new DataView(out.buffer);\n` +
			`\t__v2codec.serialize${ident(toName)}(v2Obj, v2View, 0);\n` +
			`\treturn out;\n}\n\n`
		);
	};

	// Build summary comment.
	if (plan.hookedTypes.length > 0) {
		body += `// schema-pop migrations — user hooks in use: ${plan.hookedTypes
			.map(ident)
			.join(", ")}\n\n`;
	}

	for (const tm of plan.types) body += transformFn(tm);
	for (const tm of plan.types) body += migrateFn(tm);

	return header + body;
}
