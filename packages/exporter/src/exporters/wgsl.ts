import type {
	ArkMeta,
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldPlan,
	LayoutPlan,
	TypePlan,
} from "@schema-pop/schema";
import { WGSL_PREDECLARED_ALIASES } from "@schema-pop/schema";
import { ExporterTools, toSnakeCase } from "../exporterTools";

export interface WgslConfig extends BaseConfig {
	paddingStyle?: "size" | "fields";
	outputStyle?: "types" | "helpers" | "structs" | "combined";
}

interface FieldLayout {
	wordIndex: number;
	bitShift: number;
	bitSize: number;
	isBitfield: boolean;
	wordsNeeded: number;
}

export function wgsl(config: WgslConfig): ExporterPlugin<WgslConfig> {
	const cfg = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		paddingStyle: "fields",
		outputStyle: "combined",
		...config,
	} as Required<Pick<WgslConfig, "paddingStyle" | "outputStyle">> & WgslConfig;

	const { isRichType, typeName, fieldName } = ExporterTools(cfg);

	return {
		name: "wgsl",
		extension: "wgsl",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const typesMap = new Map<string, TypePlan>(plan.types.map(t => [t.name, t]));

			const getSizeInWords = (paddedSize: number) => Math.max(1, Math.ceil(paddedSize / 4));

			const getTypeSizeInWords = (name: string): number => {
				const t = typesMap.get(name);
				if (!t) return 1;
				if (t.kind === "enum") return 1;
				if (t.kind === "alias") return getFieldSizeInWords(t.type as Field);
				return getSizeInWords(t.paddedSize ?? t.size ?? 4);
			};

			const getFieldSizeInWords = (f: Field): number => {
				if (f.kind === "primitive") return 1;
				if (f.kind === "reference") return getTypeSizeInWords(f.name);
				if (f.kind === "array") {
					const len = f.exactLength || f.maxLength || 0;
					// U8 vector packing do 1 słowa
					if (len >= 2 && len <= 4 && f.item.kind === "primitive" && f.item.name === "u8") return 1;
					if (len >= 2 && len <= 4 && f.item.kind === "primitive") return len;
					return len * getFieldSizeInWords(f.item);
				}
				return 1;
			};

			const getFieldLayout = (f: FieldPlan): FieldLayout => {
				const wordIndex = Math.floor(f.offset / 4);
				const bitShift = (f.offset % 4) * 8 + (f.bitOffset || 0);
				const bitSize = f.bitSize || (f.size * 8);
				const isBitfield = bitShift > 0 || bitSize < 32;
				const wordsNeeded = getFieldSizeInWords(f.type);
				return { wordIndex, bitShift, bitSize, isBitfield, wordsNeeded };
			};

			const getCleanWgslType = (f: Field): string => {
				if (f.kind === "primitive") {
					if (f.atomic) return `atomic<${f.binaryType || "u32"}>`;
					if (f.name === "bool" || f.name === "boolean") return "bool";
					if (f.name === "f32") return "f32";
					if (f.name === "i32" || f.name === "i16" || f.name === "i8") return "i32";
					return "u32";
				}
				if (f.kind === "reference") return typeName(f.name);
				if (f.kind === "array") {
					const itemType = getCleanWgslType(f.item);
					const len = f.exactLength || f.maxLength || 0;
					if (len >= 2 && len <= 4 && f.item.kind === "primitive") {
						return `vec${len}<${itemType}>`;
					}
					return `array<${itemType}, ${len}>`;
				}
				return "u32";
			};

			const hasAtomics = (t: TypePlan): boolean => {
				const visited = new Set<string>();
				const check = (typePlan: TypePlan): boolean => {
					if (visited.has(typePlan.name)) return false;
					visited.add(typePlan.name);

					if (typePlan.kind === "struct") {
						return typePlan.fields.some(f => {
							if ((f.type as any).atomic) return true;
							if (f.type.kind === "reference") {
								const ref = typesMap.get(f.type.name);
								return ref ? check(ref) : false;
							}
							if (f.type.kind === "array") {
								let item = f.type.item;
								while (item.kind === "array") item = item.item;
								if (item.kind === "reference") {
									const ref = typesMap.get(item.name);
									return ref ? check(ref) : false;
								}
								return !!(item as any).atomic;
							}
							return false;
						});
					}
					if (typePlan.kind === "alias") {
						if ((typePlan.type as any).atomic) return true;
						if (typePlan.type.kind === "reference") {
							const ref = typesMap.get(typePlan.type.name);
							return ref ? check(ref) : false;
						}
						if (typePlan.type.kind === "array") {
							let item = typePlan.type.item;
							while (item.kind === "array") item = item.item;
							if (item.kind === "reference") {
								const ref = typesMap.get(item.name);
								return ref ? check(ref) : false;
							}
							return !!(item as any).atomic;
						}
					}
					return false;
				};
				return check(t);
			};

			let typesCode = "";
			let helpersCode = "";

			// ====================================================================
			// ETAP 1: Deklaracje "Ładnych" Typów Shaderowych
			// ====================================================================
			for (const t of plan.types) {
				if (isRichType(t)) continue;

				if (t.kind === "enum") {
					const name = typeName(t.name);
					const underlying = t.underlyingType === "i32" ? "i32" : "u32";
					const suffix = underlying === "u32" ? "u" : "";
					typesCode += `alias ${name} = ${underlying};\n`;
					for (const v of t.variants) {
						typesCode += `const ${name}_${v.name}: ${name} = ${v.value}${suffix};\n`;
					}
					typesCode += `\n`;
				}

				if (t.kind === "alias" && !WGSL_PREDECLARED_ALIASES.has(t.name)) {
					const aliasName = typeName(t.name);
					const target = getCleanWgslType(t.type as Field);
					typesCode += `alias ${aliasName} = ${target};\n\n`;
					if (t.type.kind === "array") {
						const len = t.type.exactLength ?? t.type.maxLength ?? 0;
						if (len > 0) {
							typesCode += `const ${toSnakeCase(t.name).toUpperCase()}_LEN: u32 = ${len}u;\n\n`;
						}
					}
				}

				if (t.kind === "struct") {
					const cleanName = typeName(t.name);
					typesCode += `struct ${cleanName} {\n`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						typesCode += `\t${fieldName(f.name)}: ${getCleanWgslType(f.type)},\n`;
					}
					typesCode += `};\n\n`;
					for (const f of t.fields) {
						if (f.type.kind === "array") {
							const len = f.type.exactLength ?? f.type.maxLength ?? 0;
							if (len > 0) {
								typesCode += `const ${toSnakeCase(t.name).toUpperCase()}_${fieldName(f.name).toUpperCase()}_LEN: u32 = ${len}u;\n`;
							}
						}
					}
					typesCode += `\n`;
				}

				if (t.kind === "union") {
					const cleanName = typeName(t.name);
					const words = getSizeInWords(t.paddedSize);
					if (words === 1) typesCode += `alias ${cleanName} = u32;\n\n`;
					else typesCode += `alias ${cleanName} = array<u32, ${words}>;\n\n`;
				}
			}

			// ====================================================================
			// Generator Rekurencyjny dla Pakowania i Rozpakowywania (Rozwiązuje Arrays + Unions)
			// ====================================================================
			const genUnpack = (f: Field, baseWord: string, target: string, depth: number, parentWords: number): string => {
				const cleanType = getCleanWgslType(f);
				const w = getFieldSizeInWords(f);
				const rawAt = (offset: string) => parentWords === 1 ? `raw` : `raw[${offset}]`;

				if (f.kind === "primitive") {
					if (cleanType === "bool") return `${target} = ${rawAt(baseWord)} != 0u;\n`;
					return `${target} = bitcast<${cleanType}>(${rawAt(baseWord)});\n`;
				}
				if (f.kind === "reference") {
					const refKind = typesMap.get(f.name)?.kind;
					if (refKind === "enum") {
						return `${target} = ${cleanType}(${rawAt(baseWord)});\n`;
					} else if (refKind === "union") {
						if (w === 1) return `${target} = ${rawAt(baseWord)};\n`;
						return `for (var j_${depth} = 0u; j_${depth} < ${w}u; j_${depth}++) { ${target}[j_${depth}] = ${rawAt(`${baseWord} + j_${depth}`)}; }\n`;
					} else {
						const snake = toSnakeCase(f.name);
						if (w === 1) return `${target} = unpack_words_to_${snake}(${rawAt(baseWord)});\n`;
						return `{\n\t\tvar tmp: array<u32, ${w}>;\n\t\tfor (var j_${depth} = 0u; j_${depth} < ${w}u; j_${depth}++) { tmp[j_${depth}] = ${rawAt(`${baseWord} + j_${depth}`)}; }\n\t\t${target} = unpack_words_to_${snake}(tmp);\n\t}\n`;
					}
				}
				if (f.kind === "array") {
					if (cleanType.startsWith("vec")) {
						const len = f.exactLength || f.maxLength || 0;
						if (f.item.kind === "primitive" && f.item.name === "u8") {
							// Unpacking małych u8 (np. Color) z jednego słowa (extractBits)
							const args = Array.from({ length: len }, (_, i) => `extractBits(${rawAt(baseWord)}, ${i * 8}u, 8u)`);
							return `${target} = vec${len}<u32>(${args.join(", ")});\n`;
						} else {
							// Unpacking klasycznych wektorów rozłożonych na słowa (np. vec3<f32>)
							const innerType = getCleanWgslType(f.item);
							const args = Array.from({ length: len }, (_, i) => `bitcast<${innerType}>(${rawAt(`${baseWord} + ${i}u`)})`);
							return `${target} = ${cleanType}(${args.join(", ")});\n`;
						}
					} else {
						const len = f.exactLength || f.maxLength || 0;
						const itemWords = getFieldSizeInWords(f.item);
						let out = `for (var i_${depth} = 0u; i_${depth} < ${len}u; i_${depth}++) {\n\t\t`;
						out += genUnpack(f.item, `${baseWord} + (i_${depth} * ${itemWords}u)`, `${target}[i_${depth}]`, depth + 1, parentWords);
						out += `\t}\n`;
						return out;
					}
				}
				return "";
			};

			const genPack = (f: Field, baseWord: string, source: string, depth: number, parentWords: number): string => {
				const cleanType = getCleanWgslType(f);
				const w = getFieldSizeInWords(f);
				const outAt = (offset: string) => parentWords === 1 ? `out` : `out[${offset}]`;

				if (f.kind === "primitive") {
					if (cleanType === "bool") return `${outAt(baseWord)} = select(0u, 1u, ${source});\n`;
					return `${outAt(baseWord)} = bitcast<u32>(${source});\n`;
				}
				if (f.kind === "reference") {
					const refKind = typesMap.get(f.name)?.kind;
					if (refKind === "enum") {
						return `${outAt(baseWord)} = u32(${source});\n`;
					} else if (refKind === "union") {
						if (w === 1) return `${outAt(baseWord)} = ${source};\n`;
						return `for (var j_${depth} = 0u; j_${depth} < ${w}u; j_${depth}++) { ${outAt(`${baseWord} + j_${depth}`)} = ${source}[j_${depth}]; }\n`;
					} else {
						const snake = toSnakeCase(f.name);
						if (w === 1) return `${outAt(baseWord)} = pack_${snake}_to_words(${source});\n`;
						return `{\n\t\tlet tmp = pack_${snake}_to_words(${source});\n\t\tfor (var j_${depth} = 0u; j_${depth} < ${w}u; j_${depth}++) { ${outAt(`${baseWord} + j_${depth}`)} = tmp[j_${depth}]; }\n\t}\n`;
					}
				}
				if (f.kind === "array") {
					if (cleanType.startsWith("vec")) {
						const len = f.exactLength || f.maxLength || 0;
						const comps = ["x", "y", "z", "w"];

						if (f.item.kind === "primitive" && f.item.name === "u8") {
							// Packing małych u8 (np. Color) z powrotem do jednego słowa (insertBits)
							let p = `${outAt(baseWord)} = 0u;\n\t\t`;
							for (let i = 0; i < len; i++) {
								p += `${outAt(baseWord)} = insertBits(${outAt(baseWord)}, ${source}.${comps[i]}, ${i * 8}u, 8u);\n\t\t`;
							}
							return p;
						} else {
							let p = "";
							for (let i = 0; i < len; i++) p += `${outAt(`${baseWord} + ${i}u`)} = bitcast<u32>(${source}.${comps[i]});\n\t\t`;
							return p;
						}
					} else {
						const len = f.exactLength || f.maxLength || 0;
						const itemWords = getFieldSizeInWords(f.item);
						let p = `for (var i_${depth} = 0u; i_${depth} < ${len}u; i_${depth}++) {\n\t\t\t`;
						p += genPack(f.item, `${baseWord} + (i_${depth} * ${itemWords}u)`, `${source}[i_${depth}]`, depth + 1, parentWords);
						p += `\t\t}\n`;
						return p;
					}
				}
				return "";
			};

			// ====================================================================
			// ETAP 2: Generowanie Helperów odczytu/zapisu dla pamięci
			// ====================================================================
			for (const t of plan.types) {
				if (isRichType(t)) continue;

				if ((t.kind === "struct" || (t.kind === "alias" && !WGSL_PREDECLARED_ALIASES.has(t.name))) && !hasAtomics(t)) {
					const cleanName = typeName(t.name);
					const snakeName = toSnakeCase(t.name);
					const words = getSizeInWords(t.paddedSize ?? t.size ?? 4);
					const rawType = words === 1 ? "u32" : `array<u32, ${words}>`;
					const rawAt = (idx: string) => words === 1 ? `raw` : `raw[${idx}]`;
					const outAt = (idx: string) => words === 1 ? `out` : `out[${idx}]`;

					// --- Unpacker ---
					let unpackBody = `\tvar out: ${cleanName};\n`;

					if (t.kind === "alias") {
						unpackBody += `\t` + genUnpack(t.type as Field, "0u", "out", 0, words);
					} else {
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;

							const l = getFieldLayout(f);
							const fname = fieldName(f.name);
							const cleanType = getCleanWgslType(f.type);
							const target = `out.${fname}`;

							if (l.isBitfield) {
								const ext = `extractBits(${rawAt(`${l.wordIndex}u`)}, ${l.bitShift}u, ${l.bitSize}u)`;
								if (cleanType === "bool") {
									unpackBody += `\t${target} = ${ext} != 0u;\n`;
								} else if (f.type.kind === "reference") {
									const refKind = typesMap.get(f.type.name)?.kind;
									if (refKind === "struct" || refKind === "alias") {
										unpackBody += `\t${target} = unpack_words_to_${toSnakeCase(f.type.name)}(${ext});\n`;
									} else {
										unpackBody += `\t${target} = ${cleanType}(${ext});\n`;
									}
								} else {
									unpackBody += `\t${target} = ${cleanType}(${ext});\n`;
								}
							} else {
								unpackBody += `\t` + genUnpack(f.type, `${l.wordIndex}u`, target, 0, words);
							}
						}
					}
					unpackBody += `\treturn out;\n`;
					helpersCode += `fn unpack_words_to_${snakeName}(raw: ${rawType}) -> ${cleanName} {\n${unpackBody}}\n\n`;
					helpersCode += `fn unpack_${snakeName}(raw: ${rawType}) -> ${cleanName} {\n\treturn unpack_words_to_${snakeName}(raw);\n}\n\n`;

					// --- Packer ---
					let packBody = `\tvar out: ${rawType};\n`;
					const initializedWords = new Set<number>();

					if (t.kind === "alias") {
						packBody += `\t` + genPack(t.type as Field, "0u", "unpacked", 0, words);
					} else {
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const l = getFieldLayout(f);
							const fname = fieldName(f.name);
							const source = `unpacked.${fname}`;
							const cleanType = getCleanWgslType(f.type);

							if (l.isBitfield) {
								if (!initializedWords.has(l.wordIndex)) {
									packBody += `\t${outAt(`${l.wordIndex}u`)} = 0u;\n`;
									initializedWords.add(l.wordIndex);
								}
								let valExpr = "";
								if (cleanType === "bool") valExpr = `select(0u, 1u, ${source})`;
								else if (f.type.kind === "reference") {
									const refKind = typesMap.get(f.type.name)?.kind;
									if (refKind === "struct" || refKind === "alias") {
										valExpr = `pack_${toSnakeCase(f.type.name)}_to_words(${source})`;
									} else {
										valExpr = `u32(${source})`;
									}
								} else {
									valExpr = `u32(${source})`;
								}
								packBody += `\t${outAt(`${l.wordIndex}u`)} = insertBits(${outAt(`${l.wordIndex}u`)}, ${valExpr}, ${l.bitShift}u, ${l.bitSize}u);\n`;
							} else {
								packBody += `\t` + genPack(f.type, `${l.wordIndex}u`, source, 0, words);
							}
						}
					}
					packBody += `\treturn out;\n`;
					helpersCode += `fn pack_${snakeName}_to_words(unpacked: ${cleanName}) -> ${rawType} {\n${packBody}}\n\n`;
					helpersCode += `fn pack_${snakeName}(unpacked: ${cleanName}) -> ${rawType} {\n\treturn pack_${snakeName}_to_words(unpacked);\n}\n\n`;
				}

				if (t.kind === "union") {
					const snakeName = toSnakeCase(t.name);
					const rawWords = getSizeInWords(t.paddedSize);
					const rawType = rawWords === 1 ? "u32" : `array<u32, ${rawWords}>`;
					const rawAt = (idx: string) => rawWords === 1 ? `val` : `val[${idx}]`;

					const tagWord = Math.floor(t.tagOffset / 4);
					const tagShift = (t.tagOffset % 4) * 8;
					const tagSize = t.tagSize * 8;

					// Variant payloads are packed AFTER the tag/header region, at the
					// union's payloadOffset (same formula tsCodec uses). Without this
					// word offset the payload aliases the tag word (out[0]) and the
					// insertBits() below clobbers the low byte of the first field.
					const unionAlign = t.align || 1;
					const payloadByteOffset =
						Math.ceil((t.tagOffset + t.tagSize) / unionAlign) * unionAlign;
					const payloadWord = Math.floor(payloadByteOffset / 4);
					const pOff =
						rawWords > 1 && payloadWord > 0 ? ` + ${payloadWord}u` : "";

					// 1. Wyciąganie taga
					helpersCode += `fn get_${snakeName}_tag(val: ${rawType}) -> u32 {\n`;
					helpersCode += `\treturn extractBits(${rawAt(`${tagWord}u`)}, ${tagShift}u, ${tagSize}u);\n}\n\n`;

					// 2. Unpack/Pack wariantów
					for (let i = 0; i < t.variants.length; i++) {
						const v = t.variants[i];
						if (v.type.kind !== "reference") continue;

						const vStruct = typesMap.get(v.type.name);
						if (!vStruct || vStruct.kind !== "struct") continue;

						const cleanVarName = typeName(vStruct.name);
						const snakeVarName = toSnakeCase(vStruct.name);
						const vWords = getSizeInWords(vStruct.paddedSize ?? vStruct.size ?? 4);

						// Unpack variant
						helpersCode += `fn unpack_${snakeName}_as_${snakeVarName}(val: ${rawType}) -> ${cleanVarName} {\n`;
						if (vWords === 1) {
							helpersCode += `\treturn unpack_words_to_${snakeVarName}(${rawAt(`0u${pOff}`)});\n`;
						} else {
							helpersCode += `\tvar tmp: array<u32, ${vWords}>;\n`;
							helpersCode += `\tfor (var w = 0u; w < ${vWords}u; w++) {\n`;
							helpersCode += `\t\ttmp[w] = ${rawAt(`w${pOff}`)};\n`;
							helpersCode += `\t}\n`;
							helpersCode += `\treturn unpack_words_to_${snakeVarName}(tmp);\n`;
						}
						helpersCode += `}\n\n`;

						// Pack variant
						const tagVal = v.tag !== undefined ? v.tag : (v as any).tag ?? (i + 1);
						helpersCode += `fn pack_${snakeName}_from_${snakeVarName}(unpacked: ${cleanVarName}) -> ${rawType} {\n`;
						helpersCode += `\tvar out: ${rawType};\n`;
						if (vWords === 1) {
							helpersCode += `\t${rawWords === 1 ? "out" : `out[0u${pOff}]`} = pack_${snakeVarName}_to_words(unpacked);\n`;
						} else {
							helpersCode += `\tlet tmp = pack_${snakeVarName}_to_words(unpacked);\n`;
							helpersCode += `\tfor (var w = 0u; w < ${vWords}u; w++) {\n`;
										helpersCode += `\t\t${rawWords === 1 ? "out" : `out[w${pOff}]`} = tmp[w];\n`;
										helpersCode += `\t}\n`;
						}
						helpersCode += `\t${rawWords === 1 ? "out" : `out[${tagWord}u]`} = insertBits(${rawWords === 1 ? "out" : `out[${tagWord}u]`}, ${tagVal}u, ${tagShift}u, ${tagSize}u);\n`;
						helpersCode += `\treturn out;\n}\n\n`;
					}
				}
			}

			if (cfg.outputStyle === "types") return typesCode;
			if (cfg.outputStyle === "helpers") return helpersCode;

			return `${typesCode}\n// ==========================================\n// MEMORY HELPERS (Storage Buffers interop)\n// ==========================================\n\n${helpersCode}`;
		},
	};
}