import type { LayoutPlan, BaseConfig, ExporterPlugin, Field } from "schema-pop";
import { ExporterTools } from "schema-pop";
import { rustHarness } from "./rust-harness";

export interface RustConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
	commentStyle?: "slash";
	namespace?: string;
	traits?: string[];
	harness?: boolean;
}

const RUST_PRIMITIVES: Record<string, string> = {
	u8: "u8",
	i8: "i8",
	u16: "u16",
	i16: "i16",
	u32: "u32",
	i32: "i32",
	u64: "u64",
	i64: "i64",
	u128: "u128",
	i128: "i128",
	f32: "f32",
	f64: "f64",
	// `bool` in #[repr(C)] structs is unsound for zero-copy reads from
	// raw memory: any byte other than 0 or 1 is undefined behaviour.
	// We emit `u8` instead so a cast-and-read pass never gives Rust an
	// invalid bool. Convert with `value != 0` at the boundary.
	bool: "u8",
	boolean: "u8",
};

const RUST_RUNTIME_PRELUDE = `
/// Variable-length array carried inline. Wire format:
/// \`[len: u32][data: T; N]\`. Reads truncate to \`len\`, never the full
/// capacity \`N\`. Layout matches our analyzer's var-len array exactly,
/// including any padding Rust inserts between \`len\` and \`data\` for
/// alignment of T.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VarLen<T: Copy, const N: usize> {
	len: u32,
	data: [T; N],
}

impl<T: Copy, const N: usize> VarLen<T, N> {
	#[inline] pub fn len(&self) -> usize { self.len as usize }
	#[inline] pub fn is_empty(&self) -> bool { self.len == 0 }
	#[inline] pub fn capacity(&self) -> usize { N }
	#[inline] pub fn as_slice(&self) -> &[T] { &self.data[..self.len as usize] }
}
`;

export function rust(config: RustConfig): ExporterPlugin<RustConfig> {
	const cfg: RustConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		...config,
	};
	const { typeName, fieldName, INDENT, mapScalarField, wrapNamespace, isRichType } =
		ExporterTools(cfg);

	function fieldRustType(field: Field, fieldSize: number): string {
		const scalar = mapScalarField(field, RUST_PRIMITIVES, typeName);
		if (scalar !== undefined) return scalar;
		if (field.kind === "array") {
			const inner = fieldInnerType(field.item);
			if (inner) {
				if (field.exactLength !== undefined) {
					return `[${inner}; ${field.exactLength}]`;
				}
				if (field.maxLength !== undefined) {
					return `VarLen<${inner}, ${field.maxLength}>`;
				}
			}
		}
		return `[u8; ${fieldSize}]`;
	}

	/**
	 * Resolve a Rust type for a Field, but only when fully expressible —
	 * primitive, reference, or array of either. Returns undefined for
	 * shapes we can't represent transparently (rich kinds, optionals,
	 * inline structs), so the caller can fall back to opaque bytes.
	 */
	function fieldInnerType(field: Field): string | undefined {
		const scalar = mapScalarField(field, RUST_PRIMITIVES, typeName);
		if (scalar !== undefined) return scalar;
		if (field.kind === "array") {
			const inner = fieldInnerType(field.item);
			if (!inner) return undefined;
			if (field.exactLength !== undefined) {
				return `[${inner}; ${field.exactLength}]`;
			}
			if (field.maxLength !== undefined) {
				return `VarLen<${inner}, ${field.maxLength}>`;
			}
		}
		return undefined;
	}

	return {
		name: "rust",
		config: cfg,
		getFileHeader: () =>
			`#![allow(dead_code, unused_imports, non_camel_case_types, non_snake_case)]\n${RUST_RUNTIME_PRELUDE}\n`,
		generate: (plan: LayoutPlan) => {
			let code = "";
			const deprecatedAttr = (obsolete?: boolean, reason?: string) =>
				obsolete
					? reason
						? `#[deprecated(note = ${JSON.stringify(reason)})]\n`
						: `#[deprecated]\n`
					: "";
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ rust: skipping "${t.name}" — contains rich-tier types (Record / unknown / unbounded number)`,
					);
					continue;
				}
				const tn = typeName(t.name);
				const tAny = t as any;
				const typeDeprecate = deprecatedAttr(
					tAny.obsolete,
					tAny.obsoleteReason,
				);
				if (t.kind === "struct") {
					code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} {\n`;
					if (t.fields.length === 0)
						code += `${INDENT()}pub _pad: [u8; ${t.paddedSize}],\n`;
					let currentBitfieldOffset = -1;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fAny = f as any;
						const fieldDeprecate = deprecatedAttr(
							fAny.obsolete,
							fAny.obsoleteReason,
						);
						if (f.bitSize && f.bitSize < 8) {
							if (currentBitfieldOffset !== f.offset) {
								code += `${INDENT()}pub _bitfield_${f.offset}: u8,\n`;
								currentBitfieldOffset = f.offset;
							}
							if (f.paddingAfter > 0)
								code += `${INDENT()}pub _pad_${f.offset}: [u8; ${f.paddingAfter}],\n`;
						} else {
							const rType = fieldRustType(f.type, f.size);
							const fn = fieldName(f.name);
							if (fieldDeprecate)
								code += `${INDENT()}${fieldDeprecate.trimEnd()}\n`;
							code += `${INDENT()}pub ${fn}: ${rType},\n`;
							if (f.paddingAfter > 0)
								code += `${INDENT()}pub _pad_${fn}: [u8; ${f.paddingAfter}],\n`;
						}
					}
					code += `}\n\n`;
				} else if (t.kind === "enum") {
					code += `${typeDeprecate}pub type ${tn} = ${t.underlyingType};\n`;
					for (const v of t.variants) {
						const constName = `${tn}_${v.name}`
							.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
							.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
							.replace(/[-\s]+/g, "_")
							.toUpperCase();
						code += `pub const ${constName}: ${tn} = ${v.value};\n`;
					}
					code += `\n`;
				} else if (t.kind === "union") {
					// `#[repr(C, u8)] enum` matches our wire format only when
					// the tag is a single byte at offset 0 (which is the
					// common case our analyzer produces). Otherwise fall
					// back to the opaque byte-array form so the layout still
					// matches even if the user can't pattern-match natively.
					if (t.tagSize === 1 && t.tagOffset === 0) {
						const tagEnumName = `${typeName(t.name)}Tag`;
						const tagEnumPlan = plan.types.find(
							(x) => x.name === tagEnumName && x.kind === "enum",
						) as any;
						const valueOf = (variantName: string): number => {
							const v = tagEnumPlan?.variants?.find(
								(vv: any) => vv.name === variantName,
							);
							return v?.value ?? 0;
						};
						code += `${typeDeprecate}#[repr(C, u8)]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub enum ${tn} {\n`;
						for (const v of t.variants) {
							const variantName = typeName(v.name);
							const tagValue = valueOf(v.name);
							if (v.type.kind === "unit") {
								code += `${INDENT()}${variantName} = ${tagValue},\n`;
							} else {
								const inner = fieldInnerType(v.type as Field);
								if (inner) {
									code += `${INDENT()}${variantName}(${inner}) = ${tagValue},\n`;
								} else {
									code += `${INDENT()}${variantName} = ${tagValue}, // unsupported variant payload\n`;
								}
							}
						}
						code += `}\n\n`;
					} else {
						code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} { pub _bytes: [u8; ${t.paddedSize}] }\n\n`;
					}
				} else if (t.kind === "alias") {
					code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} { pub _bytes: [u8; ${t.paddedSize}] }\n\n`;
				}
			}
			return code;
		},
		wrapVersion: (version, code) =>
			wrapNamespace(version, code, {
				open: (mod) => `pub mod ${mod} {\n\tuse super::*;`,
				close: "}",
			}),
		getHarness: cfg.harness ? (plans) => rustHarness(plans) : undefined,
	};
}
