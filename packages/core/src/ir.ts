/**
 * Canonical schema-pop IR — what every importer (arktype scope walker
 * inside `SchemaAnalyzer`, tree-sitter walkers, clang walker) produces
 * and what `computeLayoutPlan` consumes. The shape is the **superset**
 * of every source's vocabulary; individual importers are free to use
 * only the variants they can express.
 *
 * Naming history:
 *  - `option` → `optional` (matches `OptionalField` in `LayoutPlan`)
 *  - `vec { item }` collapsed into `array { item }` (no bounds)
 *  - `len` → `exactLength` (matches `ArrayField.exactLength`)
 *  - `doc` → `description` (matches `FieldPlan.description`)
 *
 * The IR carries *no layout info* (no `size`, `align`, `offset`,
 * `paddingAfter`). That's `computeLayoutPlan`'s job. Importers that
 * already know layout (clang `-fdump-record-layouts`) attach it as
 * an optional sidecar so the layout pass can skip recomputation.
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

/**
 * Source flag for primitive fields. Mirrors `PrimitiveField.popKind`
 * in the layout schema. `"binary"` is the implicit default; importers
 * only need to set this when emitting bitwise / reserved / rich-tier.
 */
export type IRPopKind = "binary" | "bitwise" | "reserved" | "rich";

/** Map / index-signature key kind. Matches `MapField.keyKind`. */
export type IRMapKeyKind = "string" | "number" | "symbol";

/**
 * How a `ref` field reaches its target.
 *  - `inline`    — value embedded directly (default in arktype scopes)
 *  - `pointer`   — Rust `&T` / C `T *` / Zig `*T`
 *  - `reference` — Rust `&T` lifetime variant, C++ `T &`
 */
export type IRReferenceIndirection = "inline" | "pointer" | "reference";

/** Migration-time metadata. Matches `MigrationMeta` in layout schema. */
export type IRMigrationMeta = {
	renamedFrom?: string;
	defaultValue?: unknown;
};

export type IRType =
	| {
			kind: "primitive";
			name: IRPrimitive;
			popKind?: IRPopKind;
			/** For bitwise primitives (u1..u7) — declared bit width <8. */
			bitSize?: number;
	  }
	| {
			kind: "ref";
			name: string;
			indirection?: IRReferenceIndirection;
			isForward?: boolean;
	  }
	/** Bounded or fixed array. `exactLength` and `maxLength` are mutually exclusive. */
	| {
			kind: "array";
			item: IRType;
			exactLength?: number;
			maxLength?: number;
	  }
	| { kind: "string"; maxLength?: number }
	| { kind: "optional"; inner: IRType }
	/** Bit-packed sub-byte field. C `uint8_t a : 3` / Rust bitfield crates. */
	| { kind: "bit"; widthBits: number; underlying: IRPrimitive }
	/** Anonymous nested struct (arktype `"...": "Base"` spread, etc.). */
	| { kind: "inlineStruct"; fields: IRField[]; layout?: IRTypeLayout }
	/** Index signature / `Record<K, V>`. Rich-tier; binary exporters skip. */
	| { kind: "map"; keyKind: IRMapKeyKind; value: IRType }
	/** Opaque value. arktype `"unknown"` / `"any"`. Rich-tier. */
	| { kind: "any"; originalType?: string }
	/** No-shape variant. Used for `void` returns, `unit` literal-union variants. */
	| { kind: "unit" }
	/** Type the importer recognised but couldn't resolve (e.g. `size_t` w/o `<stddef.h>`). */
	| { kind: "unknown"; raw: string }
	/** Type the importer didn't recognise at all (generics, lifetimes, etc.). */
	| { kind: "unsupported"; raw: string };

/**
 * Optional pre-computed layout sidecar at the *type* level. Importers
 * that already know placement (the arktype scope walker which post-
 * processes `SchemaAnalyzer`'s output, clang `-fdump-record-layouts`)
 * fill this so `computeLayoutPlan` reconstructs the plan verbatim
 * instead of re-deriving. Tree-sitter walks leave it undefined and the
 * layout pass computes from scratch (Phase 5).
 */
export type IRTypeLayout = {
	size: number;
	align: number;
	paddedSize: number;
};

/** Optional pre-computed layout sidecar at the *field* level. */
export type IRFieldLayout = {
	offset: number;
	size: number;
	paddingAfter?: number;
	bitOffset?: number;
	bitSize?: number;
};

export type IRField = {
	name: string;
	type: IRType;
	description?: string;
	pub: boolean;
	obsolete?: boolean;
	obsoleteReason?: string;
	migrationMeta?: IRMigrationMeta;
	layout?: IRFieldLayout;
};

export type IREnumVariant =
	| {
			kind: "unit";
			name: string;
			value?: number;
			description?: string;
			migrationMeta?: IRMigrationMeta;
	  }
	| {
			kind: "tuple";
			name: string;
			types: IRType[];
			description?: string;
			migrationMeta?: IRMigrationMeta;
	  }
	| {
			kind: "struct";
			name: string;
			fields: IRField[];
			description?: string;
			migrationMeta?: IRMigrationMeta;
	  };

/** Top-level tagged-union variant. */
export type IRVariant = {
	name: string;
	type: IRType;
	migrationMeta?: IRMigrationMeta;
};

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
			description?: string;
			pub: boolean;
			obsolete?: boolean;
			obsoleteReason?: string;
			migrationMeta?: IRMigrationMeta;
			layout?: IRTypeLayout;
	  }
	| {
			kind: "enum";
			name: string;
			variants: IREnumVariant[];
			underlyingType?: "u8" | "u16" | "i32";
			repr?: string[];
			description?: string;
			pub: boolean;
			obsolete?: boolean;
			obsoleteReason?: string;
			migrationMeta?: IRMigrationMeta;
			layout?: IRTypeLayout;
	  }
	| {
			kind: "union";
			name: string;
			tagType: "u8" | "u16" | "u32";
			variants: IRVariant[];
			description?: string;
			pub: boolean;
			obsolete?: boolean;
			obsoleteReason?: string;
			migrationMeta?: IRMigrationMeta;
			layout?: IRTypeLayout;
			/** Tag byte offset within the union body. Layout sidecar. */
			tagOffset?: number;
			/** Tag size in bytes. Layout sidecar (matches `tagType` width). */
			tagSize?: number;
	  }
	| {
			kind: "alias";
			name: string;
			type: IRType;
			description?: string;
			pub: boolean;
			obsolete?: boolean;
			obsoleteReason?: string;
			migrationMeta?: IRMigrationMeta;
			layout?: IRTypeLayout;
	  }
	| {
			kind: "function";
			name: string;
			args: IRFnArg[];
			returnType: IRType;
			/**
			 * Calling convention as written in source: `C` (Rust `extern "C"`),
			 * `system`, `cdecl`, `stdcall`, `fastcall`. Undefined for the
			 * language's default (Rust default, plain C cdecl).
			 */
			abi?: string;
			description?: string;
			pub: boolean;
			obsolete?: boolean;
			obsoleteReason?: string;
	  };

export type SchemaPopIR = {
	source: string; // origin file path (relative or absolute, caller's choice)
	items: IRItem[];
	/** Items skipped because they had unrecognized shape (generics/etc.). */
	skipped: { name: string; reason: string }[];
};
