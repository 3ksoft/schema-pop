import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
} from "@schema-pop/schema";
import { WGSL_PREDECLARED_ALIASES } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface WgslConfig extends BaseConfig {
	/**
	 * How to express trailing padding on a field.
	 * - "fields": emit explicit `_pad_<name>: u32` filler fields. More verbose
	 *   but self-documenting; copy-paste-safe to other WGSL files.
	 * - "size":   use the WGSL `@size(N)` annotation on the field. Compact,
	 *   but the padding becomes invisible in casual reading.
	 * Default: "fields".
	 */
	paddingStyle?: "size" | "fields";
}

function getWgslType(f: Field, atomic = false): string {
	if (f.kind === "primitive") {
		const scalar = (() => {
			if (f.name === "f32") return "f32";
			if (f.name === "f64") {
				throw new Error(
					`wgsl: f64 has no WGSL equivalent. Narrow the schema field to f32 explicitly, or omit it from this exporter target.`,
				);
			}
			if (f.name === "i32" || f.name === "i16" || f.name === "i8") return "i32";
			if (f.name === "u32" || f.name === "u16" || f.name === "u8") return "u32";
			if (f.name === "bool" || f.name === "boolean") return "u32"; // WGSL host-shareable structs cannot contain bool
			console.warn(
				`  ⚠ wgsl: unknown primitive "${f.name}", falling back to u32. Add explicit support if this type is intentional.`,
			);
			return "u32";
		})();
		if (atomic && scalar !== "u32" && scalar !== "i32") {
			console.warn(
				`  ⚠ wgsl: atomic requested on non-integer scalar "${scalar}" — WGSL only allows atomic<u32>/atomic<i32>. Emitting non-atomic.`,
			);
			return scalar;
		}
		return atomic ? `atomic<${scalar}>` : scalar;
	}
	if (f.kind === "reference") return f.name;
	if (f.kind === "array") {
		// atomic propagates to the element type — `array<atomic<i32>, N>`.
		// Vectors cannot be atomic, so atomic suppresses the vec packing.
		const itemType = getWgslType(f.item, atomic);
		const isVector =
			!atomic &&
			f.exactLength !== undefined &&
			f.item.kind === "primitive" &&
			f.exactLength >= 2 &&
			f.exactLength <= 4;
		if (isVector) {
			return `vec${f.exactLength}<${itemType}>`;
		}
		const len = f.exactLength || f.maxLength;
		return len ? `array<${itemType}, ${len}>` : `array<${itemType}>`;
	}
	console.warn(
		`  ⚠ wgsl: unsupported field kind "${(f as Field).kind}", emitting u32 placeholder.`,
	);
	return "u32";
}

export function wgsl(config: WgslConfig): ExporterPlugin<WgslConfig> {
	const cfg = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		paddingStyle: "fields",
		...config,
	} as Required<Pick<WgslConfig, "paddingStyle">> & WgslConfig;
	const { isRichType, typeName, fieldName } = ExporterTools(cfg);
	return {
		name: "wgsl",
		extension: "wgsl",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			// Index structs and enums upfront. We use this to:
			//  (a) skip union-tag enums (synthetic enums whose variants are
			//      themselves struct names — useless in WGSL which has no
			//      tagged unions and would collide with the struct decls),
			//  (b) recognise enum-typed struct fields so we can drop their
			//      schema-pop tail padding (WGSL promotes 1/2-byte enums to
			//      u32/i32, naturally consuming those bytes).
			const structNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "struct") structNames.add(t.name);
			}
			const isUnionTagEnum = (t: { variants: { name: string }[] }) =>
				t.variants.length > 0 &&
				t.variants.every((v) => structNames.has(v.name));

			const enums = new Map<
				string,
				{ underlying: "u32" | "i32"; size: number }
			>();
			for (const t of plan.types) {
				if (t.kind === "enum" && !isUnionTagEnum(t)) {
					enums.set(t.name, {
						underlying: t.underlyingType === "i32" ? "i32" : "u32",
						size: t.size,
					});
				}
			}

			const isEnumRef = (f: Field) =>
				f.kind === "reference" && enums.has(f.name);

			// Pure-bitfield structs (e.g. packed flags) are emitted as one or more
			// `_bitfield_N: u32` words, so WGSL rounds their footprint up to a
			// multiple of 4 bytes. A reference to such a struct therefore eats more
			// space than schema-pop's byte-packed size — track the widening so we
			// can drop the now-redundant trailing padding the layout planner
			// reserved (same idea as the enum promotion above).
			const bitfieldStructWidening = new Map<string, number>();
			for (const t of plan.types) {
				if (t.kind !== "struct") continue;
				const nonUnit = t.fields.filter((f) => f.type.kind !== "unit");
				if (
					nonUnit.length === 0 ||
					!nonUnit.every((f) => !!f.bitSize && f.bitSize < 8)
				)
					continue;
				const codecSize =
					(t as { paddedSize?: number; size?: number }).paddedSize ??
					(t as { size?: number }).size ??
					0;
				const wgslSize = Math.ceil(codecSize / 4) * 4;
				bitfieldStructWidening.set(t.name, wgslSize - codecSize);
			}
			const bitfieldRefWidening = (f: Field) =>
				f.kind === "reference"
					? (bitfieldStructWidening.get(f.name) ?? 0)
					: 0;

			let code = "";
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ wgsl: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				if (t.kind === "enum") {
					if (isUnionTagEnum(t)) continue;
					const name = typeName(t.name);
					const underlying = t.underlyingType === "i32" ? "i32" : "u32";
					const suffix = underlying === "u32" ? "u" : "";
					code += `alias ${name} = ${underlying};\n`;
					for (const v of t.variants) {
						code += `const ${name}_${v.name}: ${name} = ${v.value}${suffix};\n`;
					}
					code += `\n`;
					continue;
				}
				if (t.kind === "alias") {
					if (WGSL_PREDECLARED_ALIASES.has(t.name)) continue;
					const aliasName = typeName(t.name);
					const target = getWgslType(t.type);
					code += `alias ${aliasName} = ${target};\n\n`;
					continue;
				}
				if (t.kind === "struct") {
					code += `struct ${typeName(t.name)} {\n`;
					let currentBitfieldOffset = -1;
					const bitfields: typeof t.fields = [];
					for (const f of t.fields) {
						if (f.type.kind !== "unit") {
							if (f.bitSize && f.bitSize < 8) {
								bitfields.push(f);
								if (currentBitfieldOffset !== f.offset) {
									code += `\t_bitfield_${f.offset}: u32,\n`;
									currentBitfieldOffset = f.offset;
								}
								if (f.paddingAfter > 0) {
									const padWords = Math.ceil(f.paddingAfter / 4);
									code += `\t_pad_bits_${f.name}: array<u32, ${padWords}>,\n`;
								}
							} else {
								const wgslType = getWgslType(
									f.type,
									!!(f as { atomic?: boolean }).atomic,
								);
								const name = fieldName(f.name);

								// Enum ref: WGSL promotes 1/2-byte enums to u32, eating
								// schema-pop's tail padding for this field naturally.
								const enumMeta = isEnumRef(f.type)
									? enums.get((f.type as { name: string }).name)!
									: null;
								const widening = enumMeta
									? 4 - enumMeta.size
									: bitfieldRefWidening(f.type);
								const effectivePadAfter = Math.max(
									0,
									f.paddingAfter - widening,
								);

								if (effectivePadAfter > 0) {
									if (cfg.paddingStyle === "size") {
										const totalSize = f.size + effectivePadAfter;
										code += `\t@size(${totalSize}) ${name}: ${wgslType},\n`;
									} else {
										// "fields" — explicit named padding slot(s)
										code += `\t${name}: ${wgslType},\n`;
										const padWords = Math.ceil(effectivePadAfter / 4);
										if (padWords === 1) {
											code += `\t_pad_${name}: u32,\n`;
										} else {
											code += `\t_pad_${name}: array<u32, ${padWords}>,\n`;
										}
									}
								} else {
									code += `\t${name}: ${wgslType},\n`;
								}
							}
						}
					}
					code += `};\n\n`;
					if (bitfields.length > 0) {
						const sName = typeName(t.name);
						const unpackedName = `${sName}Unpacked`;
						const snakeName = t.name.replace(/([A-Z])/g, (_m, c, i) =>
							i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`,
						);
						const unpackFnName = `unpack_${snakeName}`;
						const packFnName = `pack_${snakeName}`;
						code += `struct ${unpackedName} {\n`;
						for (const f of bitfields) {
							const wType = f.bitSize === 1 ? "bool" : "u32";
							code += `\t${fieldName(f.name)}: ${wType},\n`;
						}
						code += `};\n\n`;
						code += `fn ${unpackFnName}(packed: ${sName}) -> ${unpackedName} {\n`;
						code += `\tvar out: ${unpackedName};\n`;
						const seenBytes = new Set<number>();
						for (const f of bitfields) {
							if (!seenBytes.has(f.offset)) {
								seenBytes.add(f.offset);
								code += `\tlet _raw${f.offset} = packed._bitfield_${f.offset};\n`;
							}
							const mask = `0x${((1 << f.bitSize) - 1).toString(16).toUpperCase()}u`;
							// At bitOffset 0 the shift is a no-op — skip it for
							// cleaner generated WGSL.
							const shifted =
								f.bitOffset === 0
									? `_raw${f.offset}`
									: `(_raw${f.offset} >> ${f.bitOffset}u)`;
							if (f.bitSize === 1) {
								code += `\tout.${fieldName(f.name)} = bool(${shifted} & ${mask});\n`;
							} else {
								code += `\tout.${fieldName(f.name)} = ${shifted} & ${mask};\n`;
							}
						}
						code += `\treturn out;\n}\n\n`;

						// Symmetric pack: write each named bit back into its
						// `_bitfield_N` word and return a fresh struct value.
						// For pure-bitfield structs this is a full round-trip;
						// for mixed structs (bitfield + plain fields) any
						// non-bitfield members come out zero-initialized — the
						// caller is responsible for repopulating them after.
						code += `fn ${packFnName}(unpacked: ${unpackedName}) -> ${sName} {\n`;
						code += `\tvar out: ${sName};\n`;
						const initBytes = new Set<number>();
						for (const f of bitfields) {
							if (!initBytes.has(f.offset)) {
								initBytes.add(f.offset);
								code += `\tout._bitfield_${f.offset} = 0u;\n`;
							}
							const mask = `0x${((1 << f.bitSize) - 1).toString(16).toUpperCase()}u`;
							const srcExpr =
								f.bitSize === 1
									? `select(0u, 1u, unpacked.${fieldName(f.name)})`
									: `(unpacked.${fieldName(f.name)} & ${mask})`;
							// Skip `<< 0u` at the bottom of the word.
							const shiftSuffix =
								f.bitOffset === 0 ? "" : ` << ${f.bitOffset}u`;
							code += `\tout._bitfield_${f.offset} |= ${srcExpr}${shiftSuffix};\n`;
						}
						code += `\treturn out;\n}\n\n`;
					}
				}
			}
			return code;
		},
	};
}
