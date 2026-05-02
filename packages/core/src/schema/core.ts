import { type Type, generic, Hkt, scope } from "arktype";

export const SCHEMA_POP_KIND = " _pop_kind";

declare global {
	interface ArkEnv {
		meta(): {
			SCHEMA_POP_KIND?: "bitwise" | "binary" | "reserved";
			size?: number;
			align?: number;
			type?: string;
			scale?: number;
			addr?: number;
			isBinary?: boolean;
			description?: string;
			obsolete?: boolean;
			obsoleteReason?: string;
			renamedFrom?: string;
		};
	}
}

/**
 * Attaches a text description to the field metadata.
 */
export const Describe = generic(["t", "unknown"], ["d", "string"])(
	(args) =>
		(args.t as Type).configure({
			description: String((args.d as any).unit),
		}),
	class extends Hkt<[t: unknown, d: string]> {
		declare body: this[0];
	},
);

/**
 * Binary metadata wrapper
 */
export const Binary = generic(
	["t", "unknown"],
	["size", "number"],
	["align", "number"],
	["type", "string"],
)(
	(args) => {
		return (args.t as Type).configure({
			size: (args.size as any).unit,
			align: (args.align as any).unit,
			type: (args.type as any).unit,
			SCHEMA_POP_KIND: "binary",
		});
	},
	class extends Hkt<[t: unknown, size: number, align: number, type: string]> {
		declare body: this[0];
	},
);

/**
 * Wrapper for bit-packed fields
 */
export const Bit = generic(["t", "unknown"], ["size", "number"])(
	(args) => {
		return (args.t as Type).configure({
			size: (args.size as any).unit,
			SCHEMA_POP_KIND: "bitwise",
		});
	},
	class extends Hkt<[t: unknown, size: number]> {
		declare body: this[0];
	},
);

/**
 * Defines a reserved block of memory that is not exposed to the user API.
 */
export const Reserved = generic(["t", "unknown"], ["size", "number"])(
	(args) => {
		return (args.t as Type).configure({
			size: (args.size as any).unit,
			SCHEMA_POP_KIND: "reserved",
		});
	},
	class extends Hkt<[]> {
		declare body: this[0];
	},
);

/**
 * Defines a physical scaling factor for values (e.g., raw integer to float representation).
 */
export const Scale = generic(["t", "unknown"], ["s", "number"])(
	(args) => (args.t as Type).configure({ scale: (args.s as any).unit }),
	class extends Hkt<[t: unknown, s: number]> {
		declare body: this[0];
	},
);

/**
 * Forces a specific memory offset for the field.
 */
export const At = generic(["t", "unknown"], ["addr", "number"])(
	(args) => (args.t as Type).configure({ addr: (args.addr as any).unit }),
	class extends Hkt<[t: unknown, addr: number]> {
		declare body: this[0];
	},
);

/**
 * Marks the field or type as obsolete. Pass an optional reason string —
 * exporters render this as language-native deprecation (Rust #[deprecated],
 * C++ [[deprecated]], TS JSDoc @deprecated, OpenAPI deprecated: true) and
 * docs surface it as a strikethrough/pill.
 */
export const Obsolete = generic(["t", "unknown"], ["reason", "string"])(
	(args) =>
		(args.t as Type).configure({
			obsolete: true,
			obsoleteReason: String((args.reason as any).unit),
		}),
	class extends Hkt<[t: unknown, reason: string]> {
		declare body: this[0];
	},
);

/**
 * Marks a field/type as renamed in this schema version: in the previous
 * version it was called `oldName`. Migration emit uses this to map values
 * across the rename instead of treating the change as (removed, added).
 *
 * The marker affects migration metadata only — the v2 layout/output is
 * identical to the un-marked version. The marker resets per migration step;
 * v3 doesn't need to know what v1 called the field, only what v2 called it.
 */
export const Renamed = generic(["t", "unknown"], ["oldName", "string"])(
	(args) =>
		(args.t as Type).configure({
			renamedFrom: String((args.oldName as any).unit),
		}),
	class extends Hkt<[t: unknown, oldName: string]> {
		declare body: this[0];
	},
);

/**
 * Records the source-language spelling for a type the schema-pop pipeline
 * couldn't resolve into a native shape — typically set by importers
 * (clang_importer / treesitter_importer) when they hit a system typedef
 * outside the bundled scopes (`size_t`, `const char *`, project-local
 * templates, etc.).
 *
 * Round-trips as arktype meta `originalType: 'X'`. Binary-language
 * exporters (c, cpp, rust) with `useOriginalType: true` use it as the
 * "splat the original spelling verbatim" cheat path so the output
 * compiles against the original headers, even though schema-pop has
 * no honest layout for the field.
 *
 * Usage:
 * ```ts
 * Buf: { handle: "OriginalType<unknown, 'void *'>" }
 * ```
 */
export const OriginalType = generic(["t", "unknown"], ["name", "string"])(
	(args) =>
		(args.t as Type).configure({
			originalType: String((args.name as any).unit),
		} as any),
	class extends Hkt<[t: unknown, name: string]> {
		declare body: this[0];
	},
);

export const $schemaPop = scope({
	Describe,
	Binary,
	Bit,
	Reserved,
	Scale,
	At,
	Obsolete,
	Renamed,
	OriginalType,
});
