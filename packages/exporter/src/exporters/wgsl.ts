import type {
	ArkMeta,
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
	TypePlan,
} from "@schema-pop/schema";
import { WGSL_PREDECLARED_ALIASES } from "@schema-pop/schema";
import { ExporterTools, toSnakeCase } from "../exporterTools";

export interface WgslConfig extends BaseConfig {
	paddingStyle?: "size" | "fields";
	outputStyle?: "types" | "helpers" | "structs" | "combined";
}

function getWgslType(f: Field, singletonEnumNames?: Set<string>): string {
	if (f.kind === "primitive") {
		const scalar = (() => {
			if (f.atomic && f.binaryType === "i32") return "atomic<i32>";
			if (f.atomic && f.binaryType === "u32") return "atomic<u32>";
			if (f.name === "f32") return "f32";
			if (f.name === "f64") {
				throw new Error(
					`wgsl: f64 has no WGSL equivalent. Narrow the schema field to f32 explicitly, or omit it from this exporter target.`,
				);
			}
			if (f.name === "i32" || f.name === "i16" || f.name === "i8") return "i32";
			if (f.name === "u32" || f.name === "u16" || f.name === "u8") return "u32";
			if (f.name === "bool" || f.name === "boolean") return "u32";
			console.warn(`  ⚠ wgsl: unknown primitive "${f.name}", falling back to u32.`);
			return "u32";
		})();
		if (f.atomic && scalar !== "u32" && scalar !== "i32") {
			if (!scalar.startsWith("atomic"))
				console.warn(` ⚠ wgsl: atomic requested on non-integer scalar "${scalar}". Emitting non-atomic.`);
			return scalar;
		}
		return f.atomic ? `atomic<${scalar}>` : scalar;
	}
	if (f.kind === "reference") {
		if (singletonEnumNames?.has(f.name)) return "u32";
		return f.name;
	}
	if (f.kind === "array") {
		const itemType = getWgslType(f.item, singletonEnumNames);
		const isVector = !f.atomic && f.exactLength !== undefined && f.item.kind === "primitive" && f.exactLength >= 2 && f.exactLength <= 4;
		if (isVector) return `vec${f.exactLength}<${itemType}>`;

		const len = f.exactLength || f.maxLength;
		return len ? `array<${itemType}, ${len}>` : `array<${itemType}>`;
	}
	return "u32";
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
			const singletonEnumNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "enum" && t.variants.length === 1 && t.syntetic) {
					singletonEnumNames.add(t.name);
				}
			}

			// Ponownie odnajdujemy struktury z pakowanymi polami (do generowania bindingów)
			const packedStructNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "struct") {
					const hasSmallFields = t.fields.some(f => f.type.kind !== "unit" && (f.size < 4 || (f.offset % 4) !== 0));
					if (hasSmallFields) packedStructNames.add(t.name);
				}
			}

			const getTypeKind = (name: string) => plan.types.find(pt => pt.name === name)?.kind;

			const isU8Vec = (f: Field): boolean => {
				return f.kind === "array" &&
					f.exactLength !== undefined &&
					f.exactLength >= 2 &&
					f.exactLength <= 4 &&
					f.item.kind === "primitive" &&
					f.item.name === "u8";
			};

			const getFieldSizeInWords = (f: Field): number => {
				if (f.kind === "primitive") return 1;
				if (f.kind === "reference") {
					if (singletonEnumNames.has(f.name)) return 1;
					return getTypeSizeInWords(f.name);
				}
				if (f.kind === "array") {
					if (isU8Vec(f)) return 1;
					const len = f.exactLength || f.maxLength || 0;
					const isVector = len >= 2 && len <= 4 && f.item.kind === "primitive";
					if (isVector) return len;
					return len * getFieldSizeInWords(f.item);
				}
				return 1;
			};

			const getTypeSizeInWords = (name: string): number => {
				const t = plan.types.find(pt => pt.name === name);
				if (!t) return 1;
				if (t.kind === "enum") return 1;
				if (t.kind === "alias") {
					return getFieldSizeInWords(t.type as Field);
				}
				return Math.max(1, Math.ceil((t.paddedSize ?? t.size ?? 4) / 4));
			};

			const getPackValExpr = (f: Field, name: string): string => {
				if (f.kind === "primitive") {
					if (f.name === "bool" || f.name === "boolean") {
						return `select(0u, 1u, unpacked.${name})`;
					}
					return `bitcast<u32>(unpacked.${name})`;
				}
				if (f.kind === "reference") {
					if (singletonEnumNames.has(f.name)) return "0u";
					const refKind = getTypeKind(f.name);
					if (refKind === "enum") return `u32(unpacked.${name})`;

					const itemSnake = toSnakeCase(f.name);
					return `pack_${itemSnake}_to_words(unpacked.${name})[0u]`;
				}
				return `bitcast<u32>(unpacked.${name})`;
			};

			// ====================================================================
			// Płaskie czytanie prosto z tablicy array<u32>
			// ====================================================================
			const genReadStmts = (f: Field, rawVar: string, wordIdxExpr: string, targetExpr: string): string[] => {
				const wgslType = getWgslType(f, singletonEnumNames);

				if (f.kind === "primitive") {
					return [`${targetExpr} = bitcast<${wgslType}>(${rawVar}[${wordIdxExpr}]);`];
				}

				if (f.kind === "reference") {
					if (singletonEnumNames.has(f.name)) return [];
					const refKind = getTypeKind(f.name);
					if (refKind === "enum") return [`${targetExpr} = ${typeName(f.name)}(${rawVar}[${wordIdxExpr}]);`];

					const sizeWords = getTypeSizeInWords(f.name);
					const itemSnake = toSnakeCase(f.name);
					const unpackFn = `unpack_words_to_${itemSnake}`;

					if (sizeWords === 1) {
						return [`${targetExpr} = ${unpackFn}(u32(${rawVar}[${wordIdxExpr}]));`];
					}

					return [
						`{`,
						`\tvar tmp: array<u32, ${sizeWords}>;`,
						`\tfor (var j = 0u; j < ${sizeWords}u; j = j + 1u) {`,
						`\t\ttmp[j] = ${rawVar}[(${wordIdxExpr}) + j];`,
						`\t}`,
						`\t${targetExpr} = ${unpackFn}(tmp);`,
						`}`
					];
				}

				if (f.kind === "array") {
					const len = f.exactLength || f.maxLength || 0;

					if (isU8Vec(f)) {
						const args = Array.from({ length: len }, (_, idx) => {
							const bitShift = idx * 8;
							return wgslType === "i32"
								? `extractBits(bitcast<i32>(${rawVar}[${wordIdxExpr}]), ${bitShift}u, 8u)`
								: `extractBits(${rawVar}[${wordIdxExpr}], ${bitShift}u, 8u)`;
						}).join(", ");
						return [`${targetExpr} = vec${len}<u32>(${args});`];
					}

					const isVector = len >= 2 && len <= 4 && f.item.kind === "primitive";
					if (isVector) {
						const itemType = getWgslType(f.item, singletonEnumNames);
						const args = Array.from({ length: len }, (_, i) => `bitcast<${itemType}>(${rawVar}[(${wordIdxExpr}) + ${i}u])`).join(", ");
						return [`${targetExpr} = vec${len}<${itemType}>(${args});`];
					}

					const itemWords = getFieldSizeInWords(f.item);
					const stmts = [
						`{`,
						`\tfor (var i = 0u; i < ${len}u; i = i + 1u) {`
					];
					const innerStmts = genReadStmts(f.item, rawVar, `(${wordIdxExpr}) + i * ${itemWords}u`, `${targetExpr}[i]`);
					stmts.push(...innerStmts.map(s => `\t\t${s}`));
					stmts.push(`\t}`);
					stmts.push(`}`);
					return stmts;
				}
				return [];
			};

			// ====================================================================
			// Płaskie zapisywanie prosto do tablicy array<u32>
			// ====================================================================
			const genWriteStmts = (f: Field, sourceExpr: string, rawVar: string, wordIdxExpr: string): string[] => {
				if (f.kind === "primitive") {
					return [`${rawVar}[${wordIdxExpr}] = bitcast<u32>(${sourceExpr});`];
				}

				if (f.kind === "reference") {
					if (singletonEnumNames.has(f.name)) return [];
					const refKind = getTypeKind(f.name);
					if (refKind === "enum") return [`${rawVar}[${wordIdxExpr}] = u32(${sourceExpr});`];

					const sizeWords = getTypeSizeInWords(f.name);
					const itemSnake = toSnakeCase(f.name);
					const packFn = `pack_${itemSnake}_to_words`;

					if (sizeWords === 1) {
						return [`${rawVar}[${wordIdxExpr}] = ${packFn}(${sourceExpr})[0u];`];
					}

					return [
						`{`,
						`\tlet tmp = ${packFn}(${sourceExpr});`,
						`\tfor (var j = 0u; j < ${sizeWords}u; j = j + 1u) {`,
						`\t\t${rawVar}[(${wordIdxExpr}) + j] = tmp[j];`,
						`\t}`,
						`}`
					];
				}

				if (f.kind === "array") {
					const len = f.exactLength || f.maxLength || 0;
					const comps = ["x", "y", "z", "w"];

					if (isU8Vec(f)) {
						const lines = [`${rawVar}[${wordIdxExpr}] = 0u;`];
						for (let idx = 0; idx < len; idx++) {
							const bitShift = idx * 8;
							lines.push(`${rawVar}[${wordIdxExpr}] = insertBits(${rawVar}[${wordIdxExpr}], u32(${sourceExpr}.${comps[idx]}), ${bitShift}u, 8u);`);
						}
						return lines;
					}

					const isVector = len >= 2 && len <= 4 && f.item.kind === "primitive";
					if (isVector) {
						const lines = [];
						for (let i = 0; i < len; i++) {
							lines.push(`${rawVar}[(${wordIdxExpr}) + ${i}u] = bitcast<u32>(${sourceExpr}.${comps[i]});`);
						}
						return lines;
					}

					const itemWords = getFieldSizeInWords(f.item);
					const stmts = [
						`{`,
						`\tfor (var i = 0u; i < ${len}u; i = i + 1u) {`
					];
					const innerStmts = genWriteStmts(f.item, `${sourceExpr}[i]`, rawVar, `(${wordIdxExpr}) + i * ${itemWords}u`);
					stmts.push(...innerStmts.map(s => `\t\t${s}`));
					stmts.push(`\t}`);
					stmts.push(`}`);
					return stmts;
				}
				return [];
			};

			const generateEnum = (t: TypePlan) => {
				if (t.kind === "enum") {
					if (singletonEnumNames.has(t.name)) return "";
					const name = typeName(t.name);
					const underlying = t.underlyingType === "i32" ? "i32" : "u32";
					const suffix = underlying === "u32" ? "u" : "";

					typesCode += `alias ${name} = ${underlying};\n`;
					for (const v of t.variants) {
						typesCode += `const ${name}_${v.name}: ${name} = ${v.value}${suffix};\n`;
					}
					typesCode += `\n`;
				}
			}

			const generateAlias = (t: TypePlan) => {
				if (t.kind === "alias") {
					if (WGSL_PREDECLARED_ALIASES.has(t.name)) return;
					const aliasName = typeName(t.name);
					const target = getWgslType(t.type, singletonEnumNames);
					typesCode += `alias ${aliasName} = ${target};\n\n`;

					if (!(t.type as any).atomic) {
						const words = getFieldSizeInWords(t.type as Field);
						const snakeName = toSnakeCase(t.name);
						const packedType = words > 1 ? `array<u32, ${words}>` : "u32";

						helpersCode += `fn unpack_words_to_${snakeName}(raw: ${packedType}) -> ${aliasName} {\n`;
						helpersCode += `\tvar out: ${aliasName};\n`;
						const readStmts = genReadStmts(t.type as Field, "raw", "0u", "out");
						helpersCode += readStmts.map(l => `\t${l}\n`).join("");
						helpersCode += `\treturn out;\n`;
						helpersCode += `}\n\n`;

						helpersCode += `fn pack_${snakeName}_to_words(unpacked: ${aliasName}) -> ${packedType} {\n`;
						helpersCode += `\tvar out: ${packedType};\n`;
						const writeStmts = genWriteStmts(t.type as Field, "unpacked", "out", "0u");
						helpersCode += writeStmts.map(l => `\t${l}\n`).join("");
						helpersCode += `\treturn out;\n`;
						helpersCode += `}\n\n`;
					}
				}
			}

			const generateUnion = (t: TypePlan) => {
				if (t.kind === "union") {
					const structDeclName = typeName(t.name);
					const rawWords = Math.max(1, Math.ceil(t.paddedSize / 4));
					let tType = rawWords > 1 ? `array<u32, ${rawWords}>` : 'u32'

					typesCode += `struct ${structDeclName} {\n`;
					typesCode += `\t_raw: ${tType},\n`;
					typesCode += `};\n\n`;

					const align = t.align || 1;
					const payloadOffset = Math.ceil((t.tagOffset + t.tagSize) / align) * align;
					const tagWord = Math.floor(t.tagOffset / 4);
					const tagShift = (t.tagOffset % 4) * 8;
					const tagSize = t.tagSize;

					helpersCode += `fn get_${fieldName(t.name)}_tag(val: ${structDeclName}) -> u32 {\n`;
					helpersCode += `\treturn extractBits(val._raw[${tagWord}], ${tagShift}u, ${tagSize * 8}u);\n}\n\n`;

					for (let i = 0; i < t.variants.length; i++) {
						const v = t.variants[i];
						if (v.type.kind !== "reference") continue;
						const vStruct = plan.types.find(pt => pt.name === (v.type as any).name);
						if (!vStruct || vStruct.kind !== "struct") continue;

						const variantTypeName = typeName(vStruct.name);
						const vSnakeName = toSnakeCase(vStruct.name);
						const unpackFnName = `unpack_${toSnakeCase(t.name)}_${toSnakeCase(v.name)}`;
						const packFnName = `pack_${toSnakeCase(t.name)}_${toSnakeCase(v.name)}`;

						const words = Math.max(1, Math.ceil((vStruct as any).paddedSize / 4));
						const payloadWordOffset = Math.floor(payloadOffset / 4);
						tType = tType = rawWords > 1 ? `array<u32, ${words}>` : 'u32'
						if (variantTypeName === "none") continue;
						if (words == 1) {
							helpersCode += `fn ${unpackFnName}(val: u32) -> ${variantTypeName} {\n`;
							helpersCode += `\treturn unpack_words_to_${vSnakeName}(val);\n`;
							helpersCode += `}\n\n`;
						} else {
							helpersCode += `fn ${unpackFnName}(val: ${structDeclName}) -> ${variantTypeName} {\n`;
							helpersCode += `\tvar tmp: ${tType};\n`;
							helpersCode += `\tfor (var i = 0u; i < ${words}u; i++) {\n`;
							helpersCode += `\t\ttmp[i] = val._raw[${payloadWordOffset}u + i];\n`;
							helpersCode += `\t}\n`;
							helpersCode += `\treturn unpack_words_to_${vSnakeName}(tmp);\n`;
							helpersCode += `}\n\n`;
						}

						if (words == 1) {
							helpersCode += `fn ${packFnName}(unpacked: ${variantTypeName}) -> ${structDeclName} {\n`;
							helpersCode += `\treturn ${structDeclName}(unpacked._raw);\n`;
							helpersCode += `}\n\n`;
						} else {
							helpersCode += `fn ${packFnName}(unpacked: ${variantTypeName}) -> ${structDeclName} {\n`;
							helpersCode += `\tvar out: ${structDeclName};\n`;
							const tagVal = i + 1;
							helpersCode += `\tout._raw[${tagWord}] = insertBits(out._raw[${tagWord}], ${tagVal}u, ${tagShift}u, ${tagSize * 8}u);\n`;
							helpersCode += `\tlet tmp = pack_${vSnakeName}_to_words(unpacked);\n`;
							helpersCode += `\tfor (var i = 0u; i < ${words}u; i++) {\n`;
							helpersCode += `\t\tout._raw[${payloadWordOffset}u + i] = tmp[i];\n`;
							helpersCode += `\t}\n`;
							helpersCode += `\treturn out;\n`;
							helpersCode += `}\n\n`;
						}
					}
					typesCode += `\n`;
				}
			};

			const generateStruct = (t: TypePlan) => {
				if (t.kind === "struct") {
					const snakeName = toSnakeCase(t.name);
					const cleanName = typeName(t.name);
					const words = Math.max(1, Math.ceil(t.paddedSize / 4));
					const hasPacking = packedStructNames.has(t.name);

					let hasConstants = false;
					for (const f of t.fields) {
						if (f.type.kind === "array" && (f.type.exactLength || f.type.maxLength)) {
							if (!isU8Vec(f.type as any) && (f.type.exactLength !== undefined && f.type.item.kind === "primitive" && f.type.exactLength >= 2 && f.type.exactLength <= 4)) continue;
							const len = f.type.exactLength || f.type.maxLength;
							const constName = `${snakeName.toUpperCase()}_${toSnakeCase(f.name).toUpperCase()}_LEN`;
							typesCode += `const ${constName}: u32 = ${len}u;\n`;
							hasConstants = true;
						}
					}
					if (hasConstants) typesCode += `\n`;

					// 1. Odbudowa struktur *Packed dla bindingów WebGPU Storage
					if (hasPacking) {
						const pName = `${cleanName}Packed`;
						typesCode += `struct ${pName} {\n`;
						let offset = 0;
						while (offset < t.paddedSize) {
							const f = t.fields.find(field => field.type.kind !== "unit" && field.offset === offset);
							if (f) {
								const isLarge = f.size >= 4 && (f.offset % 4) === 0;
								if (isLarge) {
									const name = fieldName(f.name);
									typesCode += `\t${name}: ${getWgslType(f.type, singletonEnumNames)},\n`;
									offset += f.size;
								} else {
									typesCode += `\t_word_${offset}: u32,\n`;
									offset += 4;
								}
							} else {
								const overlapping = t.fields.find(field => field.type.kind !== "unit" && field.offset < offset + 4 && field.offset + field.size > offset);
								typesCode += `\t${overlapping ? `_word_${offset}` : `_pad_${offset}`}: u32,\n`;
								offset += 4;
							}
						}
						typesCode += `};\n\n`;


						// Konwersja Packed -> Struct
						helpersCode += `fn unpack_${snakeName}(packed: ${pName}) -> ${cleanName} {\n`;
						helpersCode += `\tvar out: ${cleanName};\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const isLarge = f.size >= 4 && (f.offset % 4) === 0;
							if (isLarge) {
								helpersCode += `\tout.${name} = packed.${name};\n`;
							} else {
								const wordOffset = Math.floor(f.offset / 4) * 4;
								const byteShift = (f.offset % 4) * 8;
								const bitShift = byteShift + (f.bitOffset ?? 0);
								const bitSize = f.bitSize ?? (f.size * 8);

								const extractedExpr = `extractBits(packed._word_${wordOffset}, ${bitShift}u, ${bitSize}u)`;
								const targetType = f.type.kind === "primitive" && (f.type.name === "bool") ? "bool" : getWgslType(f.type, singletonEnumNames);

								if (targetType === "bool") {
									helpersCode += `\tout.${name} = bool(${extractedExpr});\n`;
								} else if (f.type.kind === "reference" && getTypeKind(f.type.name) === "enum") {
									helpersCode += `\tout.${name} = ${targetType}(${extractedExpr});\n`;
								} else if (f.type.kind === "reference" && getTypeKind(f.type.name) === "struct") {
									const refSnake = toSnakeCase(f.type.name);
									helpersCode += `\tout.${name} = unpack_words_to_${refSnake}(${extractedExpr});\n`;
								} else {
									helpersCode += `\tout.${name} = ${targetType}(${extractedExpr});\n`;
								}
							}
						}
						helpersCode += `\treturn out;\n}\n\n`;

						// Konwersja Struct -> Packed
						helpersCode += `fn pack_${snakeName}(unpacked: ${cleanName}) -> ${pName} {\n`;
						helpersCode += `\tvar out: ${pName};\n`;

						const wordsToInit = new Set<number>();
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							if (!(f.size >= 4 && (f.offset % 4) === 0)) wordsToInit.add(Math.floor(f.offset / 4) * 4);
						}
						for (const wordOffset of wordsToInit) helpersCode += `\tvar w_${wordOffset} = 0u;\n`;

						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const isLarge = f.size >= 4 && (f.offset % 4) === 0;

							if (isLarge) {
								helpersCode += `\tout.${name} = unpacked.${name};\n`;
							} else {
								const wordOffset = Math.floor(f.offset / 4) * 4;
								const byteShift = (f.offset % 4) * 8;
								const bitShift = byteShift + (f.bitOffset ?? 0);
								const bitSize = f.bitSize ?? (f.size * 8);

								const valExpr = getPackValExpr(f.type, name);
								helpersCode += `\tw_${wordOffset} = insertBits(w_${wordOffset}, ${valExpr}, ${bitShift}u, ${bitSize}u);\n`;
							}
						}

						for (const wordOffset of wordsToInit) helpersCode += `\tout._word_${wordOffset} = w_${wordOffset};\n`;
						helpersCode += `\treturn out;\n}\n\n`;
					}

					// 2. Ostateczna, spłaszczona deklaracja "ładnej" struktury
					typesCode += `struct ${cleanName} {\n`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const name = fieldName(f.name);
						const wgslType = f.type.kind === "primitive" && (f.type.name === "bool") ? "bool" : getWgslType(f.type, singletonEnumNames);
						typesCode += `\t${name}: ${wgslType},\n`;
					}
					typesCode += `};\n\n`;

					const hasAtomicFields = t.fields.some(f => !!(f.type as any).atomic);

					// 3. Spłaszczone funkcje array<u32> <-> Struct (niezależne od Packed)
					if (!hasAtomicFields) {
						const packedType = words === 1 ? "u32" : `array<u32, ${words}>`;

						let unpackBody = `\tvar out: ${cleanName};\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const isLarge = f.size >= 4 && (f.offset % 4) === 0;
							const wordIdx = Math.floor(f.offset / 4);

							if (isLarge) {
								const readStmts = genReadStmts(f.type, "raw", `${wordIdx}u`, `out.${name}`);
								unpackBody += readStmts.map(l => `\t${l}\n`).join("");
							} else {
								const byteShift = (f.offset % 4) * 8;
								const bitShift = byteShift + (f.bitOffset ?? 0);
								const bitSize = f.bitSize ?? (f.size * 8);

								const extrVar = words > 2 ? `raw[${wordIdx}u]` : `raw`;

								const extractedExpr = `extractBits(${extrVar}, ${bitShift}u, ${bitSize}u)`;

								const targetType = f.type.kind === "primitive" && (f.type.name === "bool") ? "bool" : getWgslType(f.type, singletonEnumNames);

								if (targetType === "bool") {
									unpackBody += `\tout.${name} = select(true, false, extractBits(${extrVar}, ${bitShift}u, ${bitSize}u) > 0u);\n`;
								} else if (f.type.kind === "reference" && getTypeKind(f.type.name) === "enum") {
									unpackBody += `\tout.${name} = ${targetType}(${extractedExpr});\n`;
								} else if (f.type.kind === "reference" && getTypeKind(f.type.name) === "struct") {
									const refSnake = toSnakeCase(f.type.name);
									unpackBody += `\tout.${name} = unpack_words_to_${refSnake}(${extractedExpr});\n`;
								} else {
									unpackBody += `\tout.${name} = ${targetType}(${extractedExpr});\n`;
								}
							}
						}
						unpackBody += `\treturn out;\n`;

						let packBody = `\tvar out: ${packedType};\n`;

						const wordsToInit = new Set<number>();
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							if (!(f.size >= 4 && (f.offset % 4) === 0)) {
								wordsToInit.add(Math.floor(f.offset / 4));
							}
						}

						for (const wIdx of wordsToInit) {
							packBody += words > 2 ? `\tout[${wIdx}u] = 0u;\n` : `\tout = 0u;\n`;
						}

						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const isLarge = f.size >= 4 && (f.offset % 4) === 0;
							const wordIdx = Math.floor(f.offset / 4);

							if (isLarge) {
								const writeStmts = genWriteStmts(f.type, `unpacked.${name}`, "out", `${wordIdx}u`);
								packBody += writeStmts.map(l => `\t${l}\n`).join("");
							} else {
								const byteShift = (f.offset % 4) * 8;
								const bitShift = byteShift + (f.bitOffset ?? 0);
								const bitSize = f.bitSize ?? (f.size * 8);
								const valExpr = getPackValExpr(f.type, name);
								const outVar = words > 2 ? `out[${wordIdx}u]` : `out`;
								packBody += `\t${outVar} = insertBits(${outVar}, ${valExpr}, ${bitShift}u, ${bitSize}u);\n`;
							}
						}
						packBody += `\treturn out;\n`;

						helpersCode += `fn unpack_words_to_${snakeName}(raw: ${packedType}) -> ${cleanName} {\n${unpackBody}}\n\n`;
						helpersCode += `fn pack_${snakeName}_to_words(unpacked: ${cleanName}) -> ${packedType} {\n${packBody}}\n\n`;
					}
				}
			}

			let typesCode = "";
			let helpersCode = "";

			for (const v of plan.types) {
				const t = v as TypePlan;
				if (isRichType(t)) {
					console.warn(`  ⚠ wgsl: skipping "${t.name}" — contains rich-tier types`);
					continue;
				}
				generateEnum(t);
				generateUnion(t);
				generateStruct(t);
				generateAlias(t);
			}

			if (cfg.outputStyle === "types") return typesCode;
			if (cfg.outputStyle === "helpers") return helpersCode;

			return `${typesCode}\n// ==========================================\n// HELPERS\n// ==========================================\n\n${helpersCode}`;
		},
	};
}