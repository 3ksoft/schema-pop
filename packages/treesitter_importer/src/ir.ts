/**
 * Canonical schema-pop importer IR — what every walker (rust /
 * c / cpp / typescript / clang) produces and what `emitArktypeScope`
 * consumes. Deliberately narrow: covers FFI / wire-format types
 * only. Generics, lifetimes, traits are out of scope; an
 * unrecognized shape becomes `{ kind: "unsupported", raw }`.
 *
 * Naming history: types used to be `Rust*`-prefixed because the
 * importer started Rust-only. They've been agnostic since the C /
 * C++ / TypeScript walkers landed; the `Rust*` aliases at the
 * bottom of this file are kept as `@deprecated` shims so external
 * consumers don't break on the rename.
 */

export type IRPrimitive =
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

export type IRType =
	| { kind: "primitive"; name: IRPrimitive }
	| { kind: "ref"; name: string }
	| { kind: "array"; item: IRType; len: number }
	| { kind: "option"; inner: IRType }
	| { kind: "vec"; item: IRType }
	| { kind: "string" }
	/**
	 * Bit-packed field — typically C `uint8_t a : 3` or Rust bitfields via
	 * a crate. `widthBits` is the declared width; `underlying` is the
	 * storage type as written in source (used to render `Bit<u32, 12>`
	 * when the width exceeds the schema-pop u1..u7 aliases).
	 */
	| { kind: "bit"; widthBits: number; underlying: IRPrimitive }
	/**
	 * Type that resolved to a name we don't have in scope (e.g. `size_t`
	 * with no `<stddef.h>` available, or a project-local typedef from a
	 * header we didn't import). Renders as the arktype `"unknown"`
	 * keyword so loading the scope doesn't throw — `raw` carries the
	 * original spelling for the doc trail.
	 */
	| { kind: "unknown"; raw: string }
	| { kind: "unsupported"; raw: string };

export type IRField = {
	name: string;
	type: IRType;
	doc?: string;
	pub: boolean;
};

export type IREnumVariant =
	| { kind: "unit"; name: string; doc?: string }
	| { kind: "tuple"; name: string; types: IRType[]; doc?: string }
	| { kind: "struct"; name: string; fields: IRField[]; doc?: string };

export type IRFnArg = {
	name?: string;
	type: IRType;
};

export type IRItem =
	| {
			kind: "struct";
			name: string;
			fields: IRField[];
			repr?: string[];
			doc?: string;
			pub: boolean;
	  }
	| {
			kind: "enum";
			name: string;
			variants: IREnumVariant[];
			repr?: string[];
			doc?: string;
			pub: boolean;
	  }
	| {
			kind: "alias";
			name: string;
			type: IRType;
			doc?: string;
			pub: boolean;
	  }
	| {
			kind: "function";
			name: string;
			args: IRFnArg[];
			returnType: IRType;
			/**
			 * Calling convention as written in source: `C` (Rust `extern "C"`),
			 * `system`, `cdecl`, `stdcall`, `fastcall`. `null` for the
			 * language's default (Rust default, plain C cdecl).
			 */
			abi?: string;
			doc?: string;
			pub: boolean;
	  };

export type SchemaPopIR = {
	source: string; // origin file path (relative or absolute, caller's choice)
	items: IRItem[];
	/** Items skipped because they had unrecognized shape (generics/etc.). */
	skipped: { name: string; reason: string }[];
};
