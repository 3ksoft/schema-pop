/**
 * Intermediate representation for Rust types extracted via tree-sitter.
 * Deliberately narrow — covers only what schema-pop's binary layout cares
 * about (FFI / wire-format types). Generics, lifetimes, traits are out of
 * scope; an unrecognized shape becomes `{ kind: "unsupported", raw }`.
 */

export type RustPrimitive =
	| "u8"
	| "u16"
	| "u32"
	| "u64"
	| "u128"
	| "i8"
	| "i16"
	| "i32"
	| "i64"
	| "i128"
	| "f32"
	| "f64"
	| "bool";

export type RustType =
	| { kind: "primitive"; name: RustPrimitive }
	| { kind: "ref"; name: string }
	| { kind: "array"; item: RustType; len: number }
	| { kind: "option"; inner: RustType }
	| { kind: "vec"; item: RustType }
	| { kind: "string" }
	/**
	 * Bit-packed field — typically C `uint8_t a : 3` or Rust bitfields via
	 * a crate. `widthBits` is the declared width; `underlying` is the
	 * storage type as written in source (used to render `Bit<u32, 12>`
	 * when the width exceeds the schema-pop u1..u7 aliases).
	 */
	| { kind: "bit"; widthBits: number; underlying: RustPrimitive }
	/**
	 * Type that resolved to a name we don't have in scope (e.g. `size_t`
	 * with no `<stddef.h>` available, or a project-local typedef from a
	 * header we didn't import). Renders as the arktype `"unknown"`
	 * keyword so loading the scope doesn't throw — `raw` carries the
	 * original spelling for the doc trail.
	 */
	| { kind: "unknown"; raw: string }
	| { kind: "unsupported"; raw: string };

export type RustField = {
	name: string;
	type: RustType;
	doc?: string;
	pub: boolean;
};

export type RustEnumVariant =
	| { kind: "unit"; name: string; doc?: string }
	| { kind: "tuple"; name: string; types: RustType[]; doc?: string }
	| { kind: "struct"; name: string; fields: RustField[]; doc?: string };

export type RustFnArg = {
	name?: string;
	type: RustType;
};

export type RustItem =
	| {
			kind: "struct";
			name: string;
			fields: RustField[];
			repr?: string[];
			doc?: string;
			pub: boolean;
	  }
	| {
			kind: "enum";
			name: string;
			variants: RustEnumVariant[];
			repr?: string[];
			doc?: string;
			pub: boolean;
	  }
	| {
			kind: "alias";
			name: string;
			type: RustType;
			doc?: string;
			pub: boolean;
	  }
	| {
			kind: "function";
			name: string;
			args: RustFnArg[];
			returnType: RustType;
			/**
			 * Calling convention as written in source: `C` (Rust `extern "C"`),
			 * `system`, `cdecl`, `stdcall`, `fastcall`. `null` for the
			 * language's default (Rust default, plain C cdecl).
			 */
			abi?: string;
			doc?: string;
			pub: boolean;
	  };

export type RustModuleIR = {
	source: string; // origin file path (relative or absolute, caller's choice)
	items: RustItem[];
	/** Items skipped because they had unrecognized shape (generics/etc.). */
	skipped: { name: string; reason: string }[];
};
