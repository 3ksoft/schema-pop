import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldChange,
	FieldPlan,
	StructPlan,
	TypeDiff,
} from "schema-pop";
import { diffPlans, ExporterTools } from "schema-pop";
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
use core::ops::{Deref, DerefMut};
use core::fmt;

/// Bounded UTF-8 string carried inline.
/// Wire format: \`[len: u32][data: u8; N]\`.
/// no_std compatible — does not pull in \`alloc\` or \`std\`.
#[repr(C)]
pub struct SharedString<const N: usize> {
	pub len: u32,
	pub data: [u8; N],
}

impl<const N: usize> SharedString<N> {
	pub const fn new() -> Self { Self { len: 0, data: [0; N] } }
	pub fn from_str(s: &str) -> Self {
		let mut res = Self::new();
		let bytes = s.as_bytes();
		let len = bytes.len().min(N);
		res.data[..len].copy_from_slice(&bytes[..len]);
		res.len = len as u32;
		res
	}
	#[inline] pub fn as_str(&self) -> &str {
		let len = (self.len as usize).min(N);
		core::str::from_utf8(&self.data[..len]).unwrap_or("")
	}
	#[inline] pub fn is_empty(&self) -> bool { self.len == 0 }
	#[inline] pub fn capacity() -> usize { N }
}

impl<const N: usize> Default for SharedString<N> { fn default() -> Self { Self::new() } }
impl<const N: usize> Clone for SharedString<N> { fn clone(&self) -> Self { *self } }
impl<const N: usize> Copy for SharedString<N> {}
impl<const N: usize> PartialEq for SharedString<N> { fn eq(&self, other: &Self) -> bool { self.as_str() == other.as_str() } }
impl<const N: usize> fmt::Debug for SharedString<N> { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{:?}", self.as_str()) } }
impl<const N: usize> Deref for SharedString<N> { type Target = str; fn deref(&self) -> &str { self.as_str() } }
impl<const N: usize> From<&str> for SharedString<N> { fn from(s: &str) -> Self { Self::from_str(s) } }
impl<const N: usize, const M: usize> From<&SharedString<M>> for SharedString<N> {
	fn from(other: &SharedString<M>) -> Self { Self::from_str(other.as_str()) }
}

/// Bounded array of T carried inline.
/// Wire format: \`[len: u32][data: T; N]\`. Layout matches the analyzer
/// exactly, including any padding Rust inserts between \`len\` and \`data\`
/// for alignment of T.
#[repr(C)]
pub struct SharedVec<T, const N: usize> {
	pub len: u32,
	pub data: [T; N],
}

impl<T: Copy + Default, const N: usize> SharedVec<T, N> {
	pub fn new() -> Self { Self { len: 0, data: [T::default(); N] } }
	pub fn push(&mut self, item: T) -> core::result::Result<(), T> {
		if (self.len as usize) < N {
			self.data[self.len as usize] = item;
			self.len += 1;
			Ok(())
		} else { Err(item) }
	}
}

impl<T, const N: usize> SharedVec<T, N> {
	#[inline] pub fn len(&self) -> usize { self.len as usize }
	#[inline] pub fn is_empty(&self) -> bool { self.len == 0 }
	#[inline] pub fn capacity(&self) -> usize { N }
	#[inline] pub fn iter(&self) -> core::slice::Iter<'_, T> { self.data[..self.len as usize].iter() }
	#[inline] pub fn as_slice(&self) -> &[T] { &self.data[..self.len as usize] }
}

impl<T: Default + Copy, const N: usize> Default for SharedVec<T, N> { fn default() -> Self { Self::new() } }
impl<T: Clone, const N: usize> Clone for SharedVec<T, N> { fn clone(&self) -> Self { Self { len: self.len, data: self.data.clone() } } }
impl<T: Copy, const N: usize> Copy for SharedVec<T, N> {}
impl<T: PartialEq, const N: usize> PartialEq for SharedVec<T, N> {
	fn eq(&self, other: &Self) -> bool {
		if self.len != other.len { return false; }
		self.data[..self.len as usize] == other.data[..other.len as usize]
	}
}
impl<T: fmt::Debug, const N: usize> fmt::Debug for SharedVec<T, N> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.debug_list().entries(self.iter()).finish() }
}
impl<T, const N: usize> Deref for SharedVec<T, N> { type Target = [T]; fn deref(&self) -> &[T] { self.as_slice() } }
impl<T, const N: usize> DerefMut for SharedVec<T, N> { fn deref_mut(&mut self) -> &mut [T] { &mut self.data[..self.len as usize] } }
impl<T: Default + Copy, const N: usize> From<[T; N]> for SharedVec<T, N> { fn from(data: [T; N]) -> Self { Self { len: N as u32, data } } }
impl<T: Default + Copy, const N: usize, const M: usize> From<&SharedVec<T, M>> for SharedVec<T, N> {
	fn from(other: &SharedVec<T, M>) -> Self {
		let mut res = Self::new();
		for item in other.iter().take(N) { let _ = res.push(*item); }
		res
	}
}
impl<'a, T, const N: usize> IntoIterator for &'a SharedVec<T, N> {
	type Item = &'a T;
	type IntoIter = core::slice::Iter<'a, T>;
	fn into_iter(self) -> Self::IntoIter { self.iter() }
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
		const t = fieldInnerType(field);
		if (t !== undefined) return t;
		return `[u8; ${fieldSize}]`;
	}

	/**
	 * Resolve a Rust type for a Field, but only when fully expressible —
	 * primitive, reference, string-with-bound, or array of either. Returns
	 * undefined for shapes we can't represent transparently (rich kinds,
	 * optionals, inline structs), so the caller can fall back to opaque
	 * bytes.
	 */
	function fieldInnerType(field: Field): string | undefined {
		const scalar = mapScalarField(field, RUST_PRIMITIVES, typeName);
		if (scalar !== undefined) return scalar;
		if (field.kind === "string") {
			if (field.maxLength !== undefined) {
				return `SharedString<${field.maxLength}>`;
			}
			return undefined;
		}
		if (field.kind === "array") {
			const inner = fieldInnerType(field.item);
			if (!inner) return undefined;
			if (field.exactLength !== undefined) {
				return `[${inner}; ${field.exactLength}]`;
			}
			if (field.maxLength !== undefined) {
				return `SharedVec<${inner}, ${field.maxLength}>`;
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
		generateMigration: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => {
			const diff = diffPlans(fromPlan, toPlan);
			const fromNs = fromPlan.version;
			const toNs = toPlan.version;
			const blocks: string[] = [];
			for (const td of diff.types) {
				const code = renderRustMigration(td, fromNs, toNs);
				if (code) blocks.push(code);
			}
			if (blocks.length === 0) return "";
			return `\n// migrations: ${fromNs} → ${toNs}\n${blocks.join("\n")}`;
		},
		getHarness: cfg.harness ? (plans) => rustHarness(plans) : undefined,
	};

	function rustLiteral(value: unknown, field: Field): string {
		if (typeof value === "bigint") return `${value}`;
		if (typeof value === "boolean") {
			// bool maps to u8 in our repr — emit 0/1
			return value ? "1" : "0";
		}
		if (typeof value === "number") {
			const t = fieldInnerType(field);
			if (t === "f32" || t === "f64") {
				return Number.isInteger(value) ? `${value}.0` : `${value}`;
			}
			return `${value}`;
		}
		if (typeof value === "string") {
			// strings need to land in SharedString<N> when applicable
			if (field.kind === "string" && field.maxLength !== undefined) {
				return `SharedString::<${field.maxLength}>::from_str(${JSON.stringify(value)})`;
			}
			return JSON.stringify(value);
		}
		return "Default::default()";
	}

	function languageDefault(_field: Field): string {
		// Most types implement Default — fall through to that. SharedString /
		// SharedVec / primitive arrays / numerics all have Default impls in
		// the runtime prelude or via core.
		return "Default::default()";
	}

	function rustCastSuffix(from: Field, to: Field): string {
		// Same-family widening primitives: emit `as <toType>` cast only when
		// the inner Rust type actually differs (no-op cast otherwise is noise).
		if (from.kind === "primitive" && to.kind === "primitive") {
			const fnT = fieldInnerType(from);
			const tnT = fieldInnerType(to);
			if (tnT && tnT !== fnT) return ` as ${tnT}`;
		}
		return "";
	}

	function emitFieldExpr(
		change: FieldChange | undefined,
		toField: FieldPlan,
		fromVar: string,
	): string {
		if (change?.kind === "renamed") {
			const cast = rustCastSuffix(change.from.type, change.to.type);
			return `${fromVar}.${fieldName(change.from.name)}${cast}`;
		}
		if (change?.kind === "type-widened") {
			const cast = rustCastSuffix(change.from.type, change.to.type);
			return `${fromVar}.${fieldName(change.from.name)}${cast}`;
		}
		if (change?.kind === "added" && change.default.kind === "literal") {
			return rustLiteral(change.default.value, toField.type);
		}
		if (
			change?.kind === "added" &&
			change.default.kind === "language-default"
		) {
			return languageDefault(toField.type);
		}
		if (toField.migrationMeta?.defaultValue !== undefined) {
			return rustLiteral(toField.migrationMeta.defaultValue, toField.type);
		}
		return `${fromVar}.${fieldName(toField.name)}`;
	}

	function renderStructFromImpl(
		td: TypeDiff & { kind: "changed" | "renamed" },
		fromNs: string,
		toNs: string,
	): string {
		const fromType = (td as any).from as StructPlan;
		const toType = (td as any).to as StructPlan;
		const changeByToName = new Map<string, FieldChange>();
		for (const c of td.fieldChanges) {
			if (c.kind === "added") changeByToName.set(c.field.name, c);
			else if (c.kind === "renamed") changeByToName.set(c.to.name, c);
			else if (
				c.kind === "type-widened" ||
				c.kind === "type-narrowed" ||
				c.kind === "type-changed" ||
				c.kind === "reordered"
			)
				changeByToName.set(c.to.name, c);
		}

		let s = "";
		s += `// status: ${td.status}\n`;
		if (td.kind === "renamed") s += `// renamed from "${td.oldName}"\n`;
		s += `impl From<${fromNs}::${typeName(fromType.name)}> for ${toNs}::${typeName(toType.name)} {\n`;
		s += `${INDENT()}fn from(v1: ${fromNs}::${typeName(fromType.name)}) -> Self {\n`;
		s += `${INDENT()}${INDENT()}Self {\n`;
		for (const f of toType.fields) {
			if (f.type.kind === "unit") continue;
			if (f.bitSize && f.bitSize < 8) {
				// Bitfield handling: copy through (the analyzer emits one
				// `_bitfield_<offset>: u8` per packed group). User-supplied
				// migrations are required for changed bit layouts.
				continue;
			}
			const ch = changeByToName.get(f.name);
			const expr = emitFieldExpr(ch, f, "v1");
			s += `${INDENT()}${INDENT()}${INDENT()}${fieldName(f.name)}: ${expr},\n`;
			if (f.paddingAfter > 0) {
				s += `${INDENT()}${INDENT()}${INDENT()}_pad_${fieldName(f.name)}: [0; ${f.paddingAfter}],\n`;
			}
		}
		s += `${INDENT()}${INDENT()}}\n`;
		s += `${INDENT()}}\n`;
		s += `}\n`;
		return s;
	}

	function renderRustMigration(
		td: TypeDiff,
		fromNs: string,
		toNs: string,
	): string {
		if (td.kind !== "changed" && td.kind !== "renamed") return "";
		const toType = (td as any).to;
		const fromType = (td as any).from;
		if (td.status === "user-supplied") {
			const reasons = td.fieldChanges
				.filter((c) => c.status === "user-supplied")
				.map((c) => {
					switch (c.kind) {
						case "type-narrowed":
							return `field '${c.to.name}': narrowing ${(c.from.type as any).name ?? c.from.type.kind} → ${(c.to.type as any).name ?? c.to.type.kind}`;
						case "type-changed":
							return `field '${c.to.name}': structural type change`;
						case "added":
							return `field '${c.field.name}': new field with no auto default`;
						case "renamed":
							return `field '${c.to.name}': renamed AND type changed`;
						default:
							return c.kind;
					}
				});
			let s = `// schema-pop: write \`impl From<${fromNs}::${typeName(fromType.name)}> for ${toNs}::${typeName(toType.name)}\` yourself\n`;
			for (const r of reasons) s += `//   reason: ${r}\n`;
			if (reasons.length === 0)
				s += `//   reason: see build summary\n`;
			return s;
		}
		if (toType.kind === "struct") {
			return renderStructFromImpl(td as any, fromNs, toNs);
		}
		// alias / enum / union auto cases — emit identity From impl
		const tn = typeName(toType.name);
		const fn = typeName(fromType.name);
		return (
			`// status: ${td.status}\n` +
			`impl From<${fromNs}::${fn}> for ${toNs}::${tn} {\n` +
			`${INDENT()}fn from(v1: ${fromNs}::${fn}) -> Self {\n` +
			`${INDENT()}${INDENT()}// SAFETY: same wire layout in both versions\n` +
			`${INDENT()}${INDENT()}unsafe { core::mem::transmute(v1) }\n` +
			`${INDENT()}}\n` +
			`}\n`
		);
	}
}
