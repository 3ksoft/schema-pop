import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface RustConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
	commentStyle?: "slash";
	namespace?: string;
	traits?: string[];
	harness?: boolean;
	/**
	 * Wrap each version's types in a `pub mod <slug>` namespace.
	 * `true` (default): slugify version (e.g. "1.0" → "v1_0").
	 * `false`: emit types at the top level (no wrapping).
	 * string: use the given identifier verbatim.
	 */
	versionNamespace?: boolean | string;
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
	#[inline] pub fn empty() -> Self {
		Self {
			len: 0,
			data: unsafe { core::mem::zeroed() },
		}
	}
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
impl<T: Default + Copy, const N: usize> From<&[T]> for SharedVec<T, N> {
	fn from(v: &[T]) -> Self {
		let mut res = Self::new();
		for &item in v.iter().take(N) { let _ = res.push(item); }
		res
	}
}
#[cfg(feature = "alloc")]
extern crate alloc;
#[cfg(feature = "alloc")]
impl<const N: usize> From<alloc::string::String> for SharedString<N> {
	fn from(s: alloc::string::String) -> Self { Self::from_str(s.as_str()) }
}
#[cfg(feature = "alloc")]
impl<const N: usize> From<&alloc::string::String> for SharedString<N> {
	fn from(s: &alloc::string::String) -> Self { Self::from_str(s.as_str()) }
}
#[cfg(feature = "alloc")]
impl<T: Default + Copy, const N: usize> From<alloc::vec::Vec<T>> for SharedVec<T, N> {
	fn from(v: alloc::vec::Vec<T>) -> Self {
		let mut res = Self::new();
		for item in v.into_iter().take(N) { let _ = res.push(item); }
		res
	}
}
#[cfg(feature = "alloc")]
pub trait PopAlloc: Sized {
    /// Heap-allocate a zeroed instance. Safe for large zero-copy structs.
    fn boxed_zeroed() -> alloc::boxed::Box<Self> {
        use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
        let layout = Layout::new::<Self>();
        unsafe {
            let ptr = alloc_zeroed(layout) as *mut Self;
            if ptr.is_null() { handle_alloc_error(layout); }
            alloc::boxed::Box::from_raw(ptr)
        }
    }
}
// END COMMON RUST RUNTIME
`;

export function rust(config: RustConfig): ExporterPlugin<RustConfig> {
	const cfg: RustConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		...config,
	};
	const { typeName, fieldName, indent, mapScalarField, isRichType } =
		ExporterTools(cfg);

	function fieldRustType(field: Field, fieldSize: number, singletonNames: Set<string>): string {
		const t = fieldInnerType(field, singletonNames);
		if (t !== undefined) return t;
		return `[u8; ${fieldSize}]`;
	}

	function fieldInnerType(field: Field, singletonNames: Set<string>): string | undefined {
		if (field.kind === "reference") {
			// Single-variant synthesized enums (kind discriminators like `kind: "'LoadModel'"`)
			// are always value 0 and carry no information in binary layout — emit `u8` instead
			// of a bespoke one-variant enum type.
			if (singletonNames.has(field.name)) return "u8";
			const inner = RUST_PRIMITIVES[field.name] ?? typeName(field.name);
			if (field.indirection === "pointer") {
				return `*mut ${inner}`;
			}
			if (field.indirection === "reference") {
				return `&'static ${inner}`;
			}
		}
		const scalar = mapScalarField(field, RUST_PRIMITIVES, typeName);
		if (scalar !== undefined) return scalar;
		if (field.kind === "string") {
			if (field.maxLength !== undefined) {
				return `SharedString<${field.maxLength}>`;
			}
			return undefined;
		}
		if (field.kind === "array") {
			const inner = fieldInnerType(field.item, singletonNames);
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

	function isPlainStruct(t: any, plan: LayoutPlan, singletonNames: Set<string>): boolean {
		const seen = new Set<string>();
		const containsEnumRef = (f: any): boolean => {
			if (!f) return false;
			switch (f.kind) {
				case "reference": {
					// Singleton enums become u8 — they don't block Default derivation.
					if (singletonNames.has(f.name)) return false;
					if (seen.has(f.name)) return false;
					seen.add(f.name);
					const ref = plan.types.find((x) => x.name === f.name);
					if (!ref) return false;
					if (ref.kind === "enum" || ref.kind === "union") return true;
					if (ref.kind === "struct")
						return ref.fields.some((ff: any) => containsEnumRef(ff.type));
					if (ref.kind === "alias") return containsEnumRef(ref.type);
					return false;
				}
				case "array":
					return containsEnumRef(f.item);
				case "optional":
					return containsEnumRef(f.inner);
				default:
					return false;
			}
		};
		for (const f of t.fields) {
			if (containsEnumRef(f.type)) return false;
		}
		return true;
	}

	function versionSlug(version: string): string {
		const slug = version.replace(/[.-]/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
		return /^[0-9]/.test(slug) ? `v${slug}` : slug;
	}

	return {
		name: "rust",
		extension: "rs",
		config: cfg,
		getFileHeader: () =>
			`#![allow(dead_code, unused_imports, non_camel_case_types, non_snake_case)]\n${RUST_RUNTIME_PRELUDE}\n`,
		wrapVersion: (version: string | undefined, code: string) => {
			const vn = cfg.versionNamespace ?? true;
			if (vn === false) return code;
			const name =
				typeof vn === "string" ? vn : versionSlug(version ?? "v");
			const indented = code
				.split("\n")
				.map((l) => (l.length > 0 ? `\t${l}` : l))
				.join("\n");
			return `pub mod ${name} {\n\tuse super::*;\n\n${indented}}\n`;
		},
		generate: (plan: LayoutPlan) => {
			let code = "";

			// Single-variant enums synthesized from `kind: "'Foo'"` literal fields.
			// They carry no information (always value 0) so we emit `u8` at reference
			// sites and skip emitting the enum type itself.
			const singletonNames = new Set<string>(
				plan.types
					.filter((t) => t.kind === "enum" && (t as any).variants?.length === 1)
					.map((t) => t.name),
			);

			const deprecatedAttr = (obsolete?: boolean, reason?: string) =>
				obsolete
					? reason
						? `#[deprecated(note = ${JSON.stringify(reason)})]\n`
						: `#[deprecated]\n`
					: "";
			for (const t of plan.types) {
				// Single-variant enums are replaced by plain `u8` at every reference site;
				// no standalone type is emitted.
				if (t.kind === "enum" && singletonNames.has(t.name)) continue;
				if (isRichType(t)) {
					console.warn(
						`  ⚠ rust: opaque stub for "${t.name}" — contains rich-tier fields (Record / unknown / unbounded / nested-anon-struct)`,
					);
					const size = (t as any).paddedSize ?? (t as any).size ?? 0;
					const align = (t as any).align ?? 1;
					if (size > 0) {
						code += `#[repr(C, align(${align}))]\npub struct ${typeName(t.name)} {\n${indent()}_opaque: [u8; ${size}],\n}\n\n`;
					} else {
						code += `#[repr(C)]\npub struct ${typeName(t.name)} { _private: [u8; 0] }\n\n`;
					}
					continue;
				}
				const tn = typeName(t.name);
				const tAny = t as any;
				const typeDeprecate = deprecatedAttr(
					tAny.obsolete,
					tAny.obsoleteReason,
				);
				if (t.kind === "struct") {
					const derives = ["Clone", "Copy", "Debug", "PartialEq"];
					// Arrays only have Default up to size 32 in many Rust versions.
					// Skip Default for structs where any field falls back to an opaque [u8; N] with N > 32.
					const hasLargeOpaque = t.fields.some(
						(f) =>
							f.type.kind !== "unit" &&
							fieldInnerType(f.type, singletonNames) === undefined &&
							f.size > 32,
					);
					if (isPlainStruct(t, plan, singletonNames) && !hasLargeOpaque)
						derives.push("Default");
					code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(${derives.join(", ")})]\npub struct ${tn} {\n`;
					if (t.fields.length === 0)
						code += `${indent()}pub _pad: [u8; ${t.paddedSize}],\n`;
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
								code += `${indent()}pub _bitfield_${f.offset}: u8,\n`;
								currentBitfieldOffset = f.offset;
							}
							if (f.paddingAfter > 0)
								code += `${indent()}pub _pad_${f.offset}: [u8; ${f.paddingAfter}],\n`;
						} else {
							const rType = fieldRustType(f.type, f.size, singletonNames);
							const fn = fieldName(f.name);
							if (fieldDeprecate)
								code += `${indent()}${fieldDeprecate.trimEnd()}\n`;
							code += `${indent()}pub ${fn}: ${rType},\n`;
							// SharedString<N> and SharedVec<T,N> are repr(C) structs whose
							// sizeof already includes trailing alignment padding — emitting
							// an extra _pad_ field would double-count those bytes.
							if (
								f.paddingAfter > 0 &&
								!rType.startsWith("SharedString<") &&
								!rType.startsWith("SharedVec<")
							)
								code += `${indent()}pub _pad_${fn}: [u8; ${f.paddingAfter}],\n`;
						}
					}
					code += `}\n\n`;
					code += `impl PopAlloc for ${tn} {}\n\n`;
				} else if (t.kind === "enum") {
					// Emit a real `#[repr(uN)] enum` so consumers get exhaustive
					// match warnings + type-safe construction. Wire format is
					// identical to the previous `pub type X = uN` + consts shape.
					code += `${typeDeprecate}#[repr(${t.underlyingType})]\n`;
					code += `#[derive(Clone, Copy, Debug, PartialEq, Eq)]\npub enum ${tn} {\n`;
					for (const v of t.variants) {
						code += `${indent()}${typeName(v.name)} = ${v.value},\n`;
					}
					code += `}\n\n`;
					// `as_str()` on plain enums — handy for logging,
					// telemetry, web UI labels. Returns the schema's
					// variant name verbatim.
					code += `impl ${tn} {\n`;
					code += `${indent()}pub const fn as_str(&self) -> &'static str {\n`;
					code += `${indent(2)}match self {\n`;
					for (const v of t.variants) {
						const variantId = typeName(v.name);
						code += `${indent(3)}${tn}::${variantId} => ${JSON.stringify(v.name)},\n`;
					}
					code += `${indent(2)}}\n`;
					code += `${indent()}}\n}\n\n`;
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
								code += `${indent()}${variantName} = ${tagValue},\n`;
							} else {
								const inner = fieldInnerType(v.type as Field, singletonNames);
								if (inner) {
									code += `${indent()}${variantName}(${inner}) = ${tagValue},\n`;
								} else {
									code += `${indent()}${variantName} = ${tagValue}, // unsupported variant payload\n`;
								}
							}
						}
						code += `}\n\n`;
						code += `impl ${tn} {\n`;
						code += `${indent()}pub const fn as_str(&self) -> &'static str {\n`;
						code += `${indent(2)}match self {\n`;
						for (const v of t.variants) {
							const variantName = typeName(v.name);
							const arm =
								v.type.kind === "unit"
									? `${tn}::${variantName}`
									: `${tn}::${variantName}(_)`;
							code += `${indent(3)}${arm} => ${JSON.stringify(v.name)},\n`;
						}
						code += `${indent(2)}}\n`;
						code += `${indent()}}\n}\n\n`;
					} else {
						code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} { pub _bytes: [u8; ${t.paddedSize}] }\n\n`;
					}
				} else if (t.kind === "alias") {
					const inner = fieldInnerType(t.type, singletonNames);
					if (inner) {
						code += `${typeDeprecate}pub type ${tn} = ${inner};\n\n`;
					} else {
						code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq, Default)]\npub struct ${tn} { pub _bytes: [u8; ${t.paddedSize}] }\n\n`;
					}
				}
			}
			return code;
		},
	};
}
