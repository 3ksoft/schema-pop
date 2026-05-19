import type {
	AliasPlan,
	BaseConfig,
	EnumPlan,
	ExporterPlugin,
	Field,
	LayoutPlan,
	StructPlan,
	UnionPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

/**
 * Go exporter — emits ABI-compatible `struct` declarations matching the
 * LayoutPlan byte-for-byte.
 *
 * Mapping summary:
 *  - bool/u8…u64/i8…i64/f32/f64 → native Go types
 *  - u128 / i128                 → `[16]byte` (no native 128-bit int)
 *  - string-literal enums        → `type X string` + typed constants
 *  - tagged unions               → `type X struct { Tag uint8; Payload [N]byte }`
 *                                  with N = max variant size; opaque payload
 *                                  keeps the wire layout stable while leaving
 *                                  decode to user code
 *  - struct refs                 → bare type name (Go field order = layout order)
 *  - aliases                     → `type X = Y` (transparent alias)
 *  - optional<T>                 → `*T`
 *  - fixed array                 → `[N]T`, bounded array → `[]T`
 *  - explicit padding            → `_ [N]byte` blank fields
 *  - bitfields (u1..u7)          → packed `_bitfield_<offset> uint8` byte; user
 *                                  code masks/shifts (matches the zig pattern)
 *  - obsolete                    → `// Deprecated: <reason>` (lints recognise this)
 *
 * Multi-version output: Go has no in-file submodules, so when multiple
 * versions share one file we type-prefix every emitted name with the
 * version slug (`V1Reading`, `V2Reading`). Enable via
 * `versionNamespace: true`. Pattern matches protobuf-go's per-version
 * type prefixing. With `versionNamespace: false` (default), only the
 * latest version emits — matching what the builder does for any
 * exporter without `wrapVersion`.
 */
export interface GoConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "PascalCase" | "camelCase";
	typeNaming?: "PascalCase";
	commentStyle?: "slash";
	/**
	 * Go package declaration. Defaults to the schema name lowercased
	 * (Go convention: short, all-lowercase). Override when the file
	 * lives in a package with a different name.
	 */
	package?: string;
	/**
	 * Emit `var _ = ...` compile-time size assertions using `unsafe.Sizeof`.
	 * Default `true` — catches alignment mismatches at `go build` time.
	 */
	includeSizeAssertions?: boolean;
	/**
	 * Prefix every emitted type / const with the version slug
	 * (`V1Reading`, `V2Reading`). Required for multi-version Go output —
	 * Go has no in-file namespacing so prefixing is the only way many
	 * versions of a schema can coexist in one package. Default `false`
	 * (single-version, clean type names).
	 */
	versionNamespace?: boolean;
	/**
	 * Generate a buildable test harness next to the schema file. Same
	 * `layout` / `roundtrip` CLI as the rust / cpp / zig harnesses, so
	 * this Go output participates in the cross-language ABI suite.
	 */
	harness?: boolean;
}

/**
 * True if every field of `t` renders as a Go type whose `unsafe.Sizeof`
 * matches the analyzer's `paddedSize`. Optional → `*T` (pointer, 8 B
 * on 64-bit), string → header (16 B), and slice → header (24 B) all
 * diverge from the schema-pop wire layout, so we skip the size
 * assertion for structs containing them rather than emit a check that
 * always fails.
 */
function hasGoCompatibleLayout(t: { kind: string } & object): boolean {
	const fields: Field[] =
		(t as any).kind === "struct"
			? (t as any).fields.map((fp: any) => fp.type as Field)
			: (t as any).kind === "union"
				? (t as any).variants.map((v: any) => v.type as Field)
				: [];
	for (const f of fields) {
		if (!isGoLayoutCompatible(f)) return false;
	}
	return true;
}

function isGoLayoutCompatible(f: Field): boolean {
	switch (f.kind) {
		case "primitive":
			return true;
		case "reference":
			// Reference might point at an alias / enum — assume compatible.
			// Round-tripping through every referenced type would need a full
			// graph walk; the current emit collapses aliases at the analyzer
			// level so most refs end up as primitives anyway.
			return true;
		case "array":
			return f.exactLength !== undefined && isGoLayoutCompatible(f.item);
		case "inlineStruct":
			return f.fields.every((fp) => isGoLayoutCompatible(fp.type));
		case "optional":
		case "string":
			return false;
		default:
			return false;
	}
}

const GO_PRIMITIVES: Record<string, string> = {
	bool: "bool",
	boolean: "bool",
	u8: "uint8",
	i8: "int8",
	u16: "uint16",
	i16: "int16",
	u32: "uint32",
	i32: "int32",
	u64: "uint64",
	i64: "int64",
	f32: "float32",
	f64: "float64",
	// 128-bit ints have no native Go type — opaque byte buffer keeps layout
	u128: "[16]byte",
	i128: "[16]byte",
};

export function go(config: GoConfig = {}): ExporterPlugin<GoConfig> {
	const cfg: GoConfig = {
		fieldNaming: "PascalCase",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		includeSizeAssertions: true,
		versionNamespace: false,
		harness: false,
		...config,
	};
	const {
		typeName,
		fieldName,
		indent,
		mapScalarField,
		isRichType,
		toSafeVersionIdentifier,
	} = ExporterTools(cfg);

	/**
	 * Strip the `_<digits>` suffix the analyzer adds to `version` so it
	 * becomes a clean Go-friendly camel prefix: `schema_1` → `V1`,
	 * `wifi_2_0` → `V2_0`. Always start with `V` to keep it a valid
	 * exported identifier and visually mark version-prefixed names.
	 */
	function versionTag(plan: LayoutPlan): string {
		const safe = toSafeVersionIdentifier(plan.version);
		// `safe` looks like `<schema>_<digits>` or just `<digits>`.
		// Pull the trailing digit-and-underscore tail; fall back to `safe`.
		const m = safe.match(/(\d+(_\d+)*)$/);
		const tail = m ? m[1] : safe;
		return `V${tail}`;
	}

	function makeNamer(plan: LayoutPlan): (n: string) => string {
		const prefix = cfg.versionNamespace ? versionTag(plan) : "";
		return (name: string) => `${prefix}${typeName(name)}`;
	}

	function fieldGoType(
		f: Field,
		fieldSize: number,
		vtn: (n: string) => string,
	): string {
		// Re-route reference resolution through `vtn` so version-prefixed
		// types stay self-consistent within the file. Pointer / reference
		// indirection (clang `Foo *`) wins so self-ref structs render as
		// `*Foo` not bare `Foo` (would be a recursive value type).
		// Pointer-to-primitive routes through the primitive map.
		if (f.kind === "reference") {
			if (f.indirection === "pointer" || f.indirection === "reference") {
				const inner = GO_PRIMITIVES[f.name] ?? vtn(f.name);
				return `*${inner}`;
			}
		}
		const scalar = mapScalarField(f, GO_PRIMITIVES, vtn);
		if (scalar !== undefined) return scalar;
		switch (f.kind) {
			case "string":
				return "string";
			case "optional": {
				const inner = fieldGoType(f.inner, fieldSize, vtn);
				// Avoid `**T` for `optional<optional<T>>` — collapse to one pointer.
				return inner.startsWith("*") ? inner : `*${inner}`;
			}
			case "array": {
				const itemType = fieldGoType(f.item, 0, vtn);
				if (f.exactLength !== undefined) return `[${f.exactLength}]${itemType}`;
				return `[]${itemType}`;
			}
			case "inlineStruct":
				return renderInlineStruct(f, vtn);
		}
		// Unknown / rich shape — opaque byte buffer of the right size.
		return `[${fieldSize}]byte`;
	}

	function renderInlineStruct(
		f: Field & { kind: "inlineStruct" },
		vtn: (n: string) => string,
	): string {
		let s = "struct {\n";
		for (const fp of f.fields) {
			if (fp.type.kind === "unit") continue;
			const fn = fieldName(fp.name);
			const ty = fieldGoType(fp.type, fp.size, vtn);
			s += `${indent(2)}${fn} ${ty}\n`;
			if (fp.paddingAfter > 0) s += `${indent(2)}_ [${fp.paddingAfter}]byte\n`;
		}
		s += `${indent()}}`;
		return s;
	}

	function deprecatedComment(
		obsolete?: boolean,
		reason?: string,
		ind = "",
	): string {
		if (!obsolete) return "";
		return `${ind}// Deprecated: ${reason ?? "marked obsolete"}\n`;
	}

	function descriptionComment(desc: string | undefined, ind = ""): string {
		if (!desc) return "";
		// Skip arktype's auto-stringified type form — same heuristic as nuxt-ui.
		if (looksAutoGenerated(desc)) return "";
		return (
			desc
				.split("\n")
				.map((l) => `${ind}// ${l}`)
				.join("\n") + "\n"
		);
	}

	function looksAutoGenerated(d: string): boolean {
		return /^[{("'\[]|^(a |an |at most|at least|non-negative|number |string |bigint |boolean|null|undefined)/.test(
			d,
		);
	}

	function renderStruct(t: StructPlan, vtn: (n: string) => string): string {
		const tn = vtn(t.name);
		let code = "";
		code += descriptionComment(t.description);
		code += deprecatedComment(t.obsolete, t.obsoleteReason);
		code += `type ${tn} struct {\n`;
		if (t.fields.length === 0) {
			code += `${indent()}_ [${t.paddedSize}]byte\n`;
		}
		let currentBitfieldOffset = -1;
		for (const f of t.fields) {
			if (f.type.kind === "unit") continue;
			const fn = fieldName(f.name);
			code += descriptionComment(f.description, indent());
			code += deprecatedComment(f.obsolete, f.obsoleteReason, indent());
			if (f.bitSize && f.bitSize < 8) {
				if (currentBitfieldOffset !== f.offset) {
					code += `${indent()}_bitfield_${f.offset} uint8\n`;
					currentBitfieldOffset = f.offset;
				}
				if (f.paddingAfter > 0)
					code += `${indent()}_ [${f.paddingAfter}]byte\n`;
			} else {
				const goType = fieldGoType(f.type, f.size, vtn);
				code += `${indent()}${fn} ${goType}\n`;
				if (f.paddingAfter > 0)
					code += `${indent()}_ [${f.paddingAfter}]byte\n`;
			}
		}
		code += `}\n`;
		return code;
	}

	function renderEnum(t: EnumPlan, vtn: (n: string) => string): string {
		const tn = vtn(t.name);
		let code = "";
		code += descriptionComment(t.description);
		code += deprecatedComment(t.obsolete, t.obsoleteReason);
		code += `type ${tn} string\n\n`;
		code += `const (\n`;
		for (const v of t.variants) {
			const vn = `${tn}${typeName(v.name)}`;
			code += `${indent()}${vn} ${tn} = ${JSON.stringify(v.name)}\n`;
		}
		code += `)\n`;
		return code;
	}

	function renderUnion(t: UnionPlan, vtn: (n: string) => string): string {
		const tn = vtn(t.name);
		const tag = GO_PRIMITIVES[t.tagType] ?? "uint8";
		const payloadSize = Math.max(
			0,
			t.paddedSize - t.tagSize - (t.tagOffset > 0 ? t.tagOffset : 0),
		);
		let code = "";
		code += descriptionComment(t.description);
		code += deprecatedComment(t.obsolete, t.obsoleteReason);
		code += `type ${tn}Tag ${tag}\n\n`;
		code += `const (\n`;
		t.variants.forEach((v, i) => {
			code += `${indent()}${tn}Tag${typeName(v.name)} ${tn}Tag = ${i}\n`;
		});
		code += `)\n\n`;
		code += `// ${tn} is a tagged union. Decode \`Payload\` based on \`Tag\`.\n`;
		code += `type ${tn} struct {\n`;
		if (t.tagOffset > 0) code += `${indent()}_ [${t.tagOffset}]byte\n`;
		code += `${indent()}Tag ${tn}Tag\n`;
		if (payloadSize > 0) code += `${indent()}Payload [${payloadSize}]byte\n`;
		code += `}\n`;
		return code;
	}

	function renderAlias(t: AliasPlan, vtn: (n: string) => string): string {
		const tn = vtn(t.name);
		const target = fieldGoType(t.type, t.size, vtn);
		let code = "";
		code += descriptionComment(t.description);
		code += deprecatedComment(t.obsolete, t.obsoleteReason);
		code += `type ${tn} = ${target}\n`;
		return code;
	}

	function packageName(plan: LayoutPlan): string {
		if (cfg.package) return cfg.package;
		return toSafeVersionIdentifier(plan.version);
	}

	return {
		name: "go",
		extension: "go",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const vtn = makeNamer(plan);
			const skipped: string[] = [];
			let body = "";
			const sizeAssertions: string[] = [];

			for (const t of plan.types) {
				if (isRichType(t)) {
					skipped.push(t.name);
					continue;
				}
				if (t.kind === "struct") body += renderStruct(t, vtn) + "\n";
				else if (t.kind === "enum") body += renderEnum(t, vtn) + "\n";
				else if (t.kind === "union") body += renderUnion(t, vtn) + "\n";
				else if (t.kind === "alias") body += renderAlias(t, vtn) + "\n";

				if (
					cfg.includeSizeAssertions &&
					(t.kind === "struct" || t.kind === "union") &&
					t.paddedSize > 0 &&
					hasGoCompatibleLayout(t)
				) {
					const tn = vtn(t.name);
					sizeAssertions.push(
						`var _ = [1]struct{}{}[unsafe.Sizeof(${tn}{}) - ${t.paddedSize}]`,
					);
				}
			}

			if (skipped.length > 0) {
				console.warn(
					`  ⚠ go: skipping ${skipped.length} rich-tier type(s): ${skipped.join(", ")}`,
				);
			}

			let header = `package ${packageName(plan)}\n\n`;
			if (sizeAssertions.length > 0) {
				header += `import "unsafe"\n\n`;
				body += `// Compile-time layout checks — fail to build if the\n// emitted Go layout drifts from the schema-pop LayoutPlan.\n`;
				body += sizeAssertions.join("\n") + "\n";
			}
			return header + body;
		},
	};
}
