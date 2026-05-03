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
	/**
	 * Controls the per-version `pub mod <version> { ... }` wrapper.
	 *  - `undefined` (default): wrap with the analyzer's safe version
	 *    identifier (e.g., `pub mod konektor_1_0 { ... }`). Required for
	 *    multi-version files.
	 *  - `false`: do not wrap. Types emit at the top level. Only safe for
	 *    single-version files; multiple versions in one file would collide.
	 *  - `string`: use the given name verbatim (e.g., `pub mod ws { ... }`).
	 */
	versionNamespace?: false | string;
	/**
	 * If `true`, fields whose `Field.originalType` is set are emitted
	 * with a Rust equivalent of the original C / C++ spelling instead
	 * of falling back to a `[u8; N]` byte blob. Common platform
	 * typedefs map to `core::ffi` / Rust primitives:
	 *   `size_t / uintptr_t` → `usize`,
	 *   `ssize_t / ptrdiff_t / intptr_t` → `isize`,
	 *   `off_t / time_t` → `i64` (LP64 assumption),
	 *   `const char *` → `*const core::ffi::c_char`,
	 *   `char *` → `*mut core::ffi::c_char`,
	 *   `void *` → `*mut core::ffi::c_void`,
	 *   `T *` / `const T *` → `*mut T` / `*const T` for known refs.
	 *
	 * Names we don't recognise stay as a `[u8; N]` byte blob — we
	 * never emit a raw C identifier into Rust source, since it would
	 * fail to compile.
	 *
	 * Defaults to `false` because the resulting fields aren't
	 * round-trippable through schema-pop's binary codec (no layout
	 * known to it). Opt in for FFI bridge / sys-crate generation.
	 */
	useOriginalType?: boolean;
}

/**
 * Map a C / C++ type spelling (carried through Field.originalType
 * by importers when they couldn't resolve the source type) to a
 * sensible Rust equivalent. LP64 assumption for `long`-shaped types.
 * Returns null when the spelling is too project-specific to handle
 * safely (the caller falls back to a `[u8; N]` byte blob).
 *
 * `typeName(name)` is used for known user-types so pointer-to-T
 * preserves the casing convention of the rest of the generated code.
 */
function mapOriginalTypeToRust(
	spelling: string,
	typeName: (n: string) => string,
): string | null {
	let s = spelling
		.replace(/\brestrict\b/g, "")
		.replace(/\b__restrict\b/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Direct platform-typedef aliases.
	const flat: Record<string, string> = {
		size_t: "usize",
		uintptr_t: "usize",
		ssize_t: "isize",
		ptrdiff_t: "isize",
		intptr_t: "isize",
		off_t: "i64",
		time_t: "i64",
		clock_t: "i64",
		pid_t: "i32",
		uid_t: "u32",
		gid_t: "u32",
		mode_t: "u32",
	};
	if (flat[s] !== undefined) return flat[s]!;

	// Pointer forms: peel off trailing `*` and pick a c_char / c_void / ref
	// based on what's left.
	const ptr = s.match(/^(.*?)\s*\*+\s*$/);
	if (ptr) {
		const innerRaw = ptr[1]!.trim();
		const isConst = /\bconst\b/.test(innerRaw);
		const inner = innerRaw.replace(/\bconst\b/g, "").replace(/\s+/g, " ").trim();
		const mut = isConst ? "*const" : "*mut";
		if (inner === "char" || inner === "signed char" || inner === "unsigned char") {
			return `${mut} core::ffi::c_char`;
		}
		if (inner === "void" || inner === "") {
			return `${mut} core::ffi::c_void`;
		}
		// Recurse for typedef aliases (e.g. `size_t *`).
		const innerMapped = mapOriginalTypeToRust(inner, typeName);
		if (innerMapped) return `${mut} ${innerMapped}`;
		// Bare identifier → assume it's a user-named type referenced
		// elsewhere in the generated module.
		if (/^[A-Za-z_]\w*$/.test(inner)) return `${mut} ${typeName(inner)}`;
		return null;
	}

	// `const X` / qualifier-only forms — strip and recurse.
	if (/\bconst\b/.test(s)) {
		const stripped = s.replace(/\bconst\b/g, "").trim();
		if (stripped !== s) return mapOriginalTypeToRust(stripped, typeName);
	}

	return null;
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

	/// Empty constructor without the \`T: Copy + Default\` bound that
	/// \`new()\` carries. Useful for generated types whose fields contain
	/// enums (which can't have a meaningful Default) — every variant of
	/// schema-pop's wire-format types is valid as zero bytes (\`#[repr(C, u8)]\`
	/// enums encode tag 0 as a real variant; struct fields are FFI-shaped
	/// primitives), so a \`mem::zeroed\` blob is always safe to construct
	/// even though it's not generally observable until \`push()\` advances
	/// \`self.len\`.
	#[inline]
	pub fn empty() -> Self {
		Self {
			len: 0,
			// SAFETY: \`len = 0\` means callers never observe the
			// zero-initialised \`data\` directly — only \`push()\` writes
			// real values, and \`as_slice()\` / \`iter()\` bound their
			// view to \`..self.len\`. Schema-pop generates only types
			// whose all-zero bit pattern is a valid representation
			// (FFI structs, repr(C, u8) enums with variant 0 valid).
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

// Slice → SharedVec is alloc-free (just a borrow + copy into the bounded
// inline buffer), so it stays always-on.
impl<T: Default + Copy, const N: usize> From<&[T]> for SharedVec<T, N> {
	fn from(v: &[T]) -> Self {
		let mut res = Self::new();
		for &item in v.iter().take(N) { let _ = res.push(item); }
		res
	}
}

// Owning conversions for std/alloc-using callers. Gated on the \`alloc\`
// feature so this stays no_std-friendly when callers opt out.
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
`;

export function rust(config: RustConfig): ExporterPlugin<RustConfig> {
	const cfg: RustConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		...config,
	};
	const {
		typeName,
		fieldName,
		indent,
		mapScalarField,
		wrapNamespace,
		isRichType,
		toSafeVersionIdentifier,
	} = ExporterTools(cfg);

	function fieldRustType(field: Field, fieldSize: number): string {
		const t = fieldInnerType(field);
		if (t !== undefined) return t;
		if (cfg.useOriginalType && field.kind === "any" && field.originalType) {
			const mapped = mapOriginalTypeToRust(field.originalType, typeName);
			if (mapped) return mapped;
		}
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
		// Pointer / reference indirection takes precedence over the
		// generic `mapScalarField` ref rendering. A `*mut Foo` is what
		// the importer recorded (clang `Foo *`), and rendering it as
		// bare `Foo` produces a recursive value type with infinite size
		// for self-referential structs (`struct Node { Node *next; }`).
		// When the pointee is a primitive (clang `int *` → ref name
		// "i32"), we look it up in the primitive map so we get
		// `*mut i32` instead of pascal-cased `*mut I32`.
		if (field.kind === "reference") {
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

	/**
	 * True if a struct can be safely `derive(Default)`-ed: every field's
	 * type recurses to a primitive / string / SharedVec-of-primitive
	 * without crossing into an enum or union (which can't have a
	 * meaningful Default). Walks references through `plan.types`.
	 *
	 * Plain structs get `Default` added to their derive list so callers
	 * can use `..Default::default()` to zero out the `_pad_*` fields the
	 * codegen inserts — see docs/requests.md P11.
	 */
	function isPlainStruct(t: any, plan: LayoutPlan): boolean {
		const seen = new Set<string>();
		const containsEnumRef = (f: any): boolean => {
			if (!f) return false;
			switch (f.kind) {
				case "reference": {
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

	return {
		name: "rust",
		extension: "rs",
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
			const richOpts = { allowOriginalType: !!cfg.useOriginalType };
			for (const t of plan.types) {
				if (isRichType(t, richOpts)) {
					// Emit an opaque byte-blob stub instead of dropping the
					// type entirely. Other types in the same plan often
					// reference this one via pointer (`*mut UartTxDataT`),
					// and dropping it would leave those refs unresolved.
					// The stub preserves layout (size + align) and lets
					// downstream code do pointer arithmetic / casting; what
					// it does NOT support is direct field access — exactly
					// the contract for "rich content we can't safely model".
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
					if (isPlainStruct(t, plan)) derives.push("Default");
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
							const rType = fieldRustType(f.type, f.size);
							const fn = fieldName(f.name);
							if (fieldDeprecate)
								code += `${indent()}${fieldDeprecate.trimEnd()}\n`;
							code += `${indent()}pub ${fn}: ${rType},\n`;
							if (f.paddingAfter > 0)
								code += `${indent()}pub _pad_${fn}: [u8; ${f.paddingAfter}],\n`;
						}
					}
					code += `}\n\n`;
					// `boxed_zeroed` for any struct whose all-zero bit
					// pattern is a valid representation — for our wire
					// types that's always true (FFI-shaped, no internal
					// pointer-with-meaning, repr(C, u8) enums treat
					// variant 0 as a real variant). Gated on `alloc`
					// so the no_std embedded path stays clean. See
					// docs/requests.md P4.
					code += `#[cfg(feature = "alloc")]\nimpl ${tn} {\n`;
					code += `${indent()}/// Heap-allocate a zeroed instance. Useful when a stack\n`;
					code += `${indent()}/// allocation would overflow (sizeof(${tn}) is large).\n`;
					code += `${indent()}pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {\n`;
					code += `${indent(2)}use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};\n`;
					code += `${indent(2)}// SAFETY: \`Self\` is repr(C) with FFI-safe fields; an\n`;
					code += `${indent(2)}// all-zero bit pattern is a valid value for every field\n`;
					code += `${indent(2)}// schema-pop generates.\n`;
					code += `${indent(2)}let layout = Layout::new::<Self>();\n`;
					code += `${indent(2)}let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;\n`;
					code += `${indent(2)}if ptr.is_null() { handle_alloc_error(layout); }\n`;
					code += `${indent(2)}unsafe { alloc::boxed::Box::from_raw(ptr) }\n`;
					code += `${indent()}}\n}\n\n`;
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
								const inner = fieldInnerType(v.type as Field);
								if (inner) {
									code += `${indent()}${variantName}(${inner}) = ${tagValue},\n`;
								} else {
									code += `${indent()}${variantName} = ${tagValue}, // unsupported variant payload\n`;
								}
							}
						}
						code += `}\n\n`;
						// `as_str()` returning the active variant's tag
						// name. Mirrors the plain-enum impl above and
						// gives consumers a single reflection point for
						// debug logs / telemetry / UI labels — works
						// against the tag without forcing the caller to
						// pattern-match every variant by hand.
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
					code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} { pub _bytes: [u8; ${t.paddedSize}] }\n\n`;
				}
			}
			return code;
		},
		wrapVersion: (version, code) => {
			if (cfg.versionNamespace === false) return code;
			const modName =
				typeof cfg.versionNamespace === "string"
					? cfg.versionNamespace
					: version;
			return wrapNamespace(modName, code, {
				open: (mod) => `pub mod ${mod} {\n\tuse super::*;`,
				close: "}",
			});
		},
		generateMigration: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => {
			const diff = diffPlans(fromPlan, toPlan);
			// Module path components must match the namespace identifiers
			// emitted by `wrapVersion` — both go through `toSafeVersionIdentifier`
			// so e.g. `1.0` / `test-schema_2.0` become `v1_0` / `test_schema_2_0`
			// instead of breaking `impl From<...>` parsing.
			const fromNs = toSafeVersionIdentifier(fromPlan.version);
			const toNs = toSafeVersionIdentifier(toPlan.version);
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
		s += `${indent()}fn from(v1: ${fromNs}::${typeName(fromType.name)}) -> Self {\n`;
		s += `${indent()}${indent()}Self {\n`;
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
			s += `${indent()}${indent()}${indent()}${fieldName(f.name)}: ${expr},\n`;
			if (f.paddingAfter > 0) {
				s += `${indent()}${indent()}${indent()}_pad_${fieldName(f.name)}: [0; ${f.paddingAfter}],\n`;
			}
		}
		s += `${indent()}${indent()}}\n`;
		s += `${indent()}}\n`;
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
			`${indent()}fn from(v1: ${fromNs}::${fn}) -> Self {\n` +
			`${indent()}${indent()}// SAFETY: same wire layout in both versions\n` +
			`${indent()}${indent()}unsafe { core::mem::transmute(v1) }\n` +
			`${indent()}}\n` +
			`}\n`
		);
	}
}
