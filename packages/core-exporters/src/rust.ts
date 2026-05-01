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
		getHarness: cfg.harness ? (plans) => rustHarness(plans) : undefined,
	};
}
