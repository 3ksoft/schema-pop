import type {
	ArkMeta,
	ArrayField,
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

function getWgslType(f: Field, packedStructNames?: Set<string>, singletonEnumNames?: Set<string>): string {
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
			if (f.name === "bool" || f.name === "boolean") return "u32"; // Host-shareable structs cannot contain bool
			console.warn(
				`  ⚠ wgsl: unknown primitive "${f.name}", falling back to u32.`,
			);
			return "u32";
		})();
		if (f.atomic && scalar !== "u32" && scalar !== "i32") {
			if (!scalar.startsWith("atomic"))
				console.warn(` ⚠ wgsl: atomic requested on non-integer scalar "${scalar}". Emitting non-atomic.`,);
			return scalar;
		}
		return f.atomic ? `atomic<${scalar}>` : scalar;
	}
	if (f.kind === "reference") {
		if (packedStructNames?.has(f.name)) {
			return `${f.name}Packed`;
		}
		if (singletonEnumNames?.has(f.name)) {
			return "u32";
		}
		return f.name;
	}
	if (f.kind === "array") {
		const itemType = getWgslType(f.item, packedStructNames, singletonEnumNames);
		const isVector =
			!f.atomic &&
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
			// 1. Singleton enums (synthetic)
			const singletonEnumNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "enum" && t.variants.length === 1 && t.syntetic) {
					singletonEnumNames.add(t.name);
				}
			}

			// 2. Build Enum Metadata Map
			const enums = new Map<string, { underlying: "u32" | "i32"; size: number }>();
			for (const t of plan.types) {
				if (t.kind === "enum") {
					if (singletonEnumNames.has(t.name)) continue;
					enums.set(t.name, {
						underlying: t.underlyingType === "i32" ? "i32" : "u32",
						size: t.size,
					});
				}
			}

			// 3. Identify structs that need packing (contain fields < 4 bytes or unaligned)
			const packedStructNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "struct") {
					const hasSmallFields = t.fields.some(
						f => f.type.kind !== "unit" && (f.size < 4 || (f.offset % 4) !== 0)
					);
					if (hasSmallFields) {
						packedStructNames.add(t.name);
					}
				}
			}

			// Helper: Get size of any referenced type in words (u32)
			const getTypeSizeInWords = (name: string): number => {
				const t = plan.types.find(pt => pt.name === name);
				if (!t) return 1;
				if (t.kind === "enum") return 1;
				return Math.max(1, Math.ceil(t.paddedSize / 4));
			};

			// Helper: Get plan kind of any reference
			const getTypeKind = (name: string) => {
				return plan.types.find(pt => pt.name === name)?.kind;
			};

			let typesCode = "";
			let helpersCode = "";

			for (const v of plan.types) {
				const t = v as TypePlan;
				if (isRichType(t)) {
					console.warn(`  ⚠ wgsl: skipping "${t.name}" — contains rich-tier types`);
					continue;
				}

				// --- ENUM GENERATION ---
				if (t.kind === "enum") {
					if (singletonEnumNames.has(t.name)) continue;
					const name = typeName(t.name);
					const underlying = t.underlyingType === "i32" ? "i32" : "u32";
					const suffix = underlying === "u32" ? "u" : "";

					typesCode += `alias ${name} = ${underlying};\n`;
					for (const v of t.variants) {
						typesCode += `const ${name}_${v.name}: ${name} = ${v.value}${suffix};\n`;
					}
					typesCode += `\n`;
					continue;
				}

				// --- ALIAS GENERATION ---
				if (t.kind === "alias") {
					if (WGSL_PREDECLARED_ALIASES.has(t.name)) continue;
					const aliasName = typeName(t.name);
					const target = getWgslType(t.type, packedStructNames, singletonEnumNames);
					typesCode += `alias ${aliasName} = ${target};\n\n`;
					continue;
				}

				// --- UNION GENERATION ---
				if (t.kind === "union") {
					const structDeclName = typeName(t.name);
					const rawWords = Math.max(1, Math.ceil(t.paddedSize / 4));
					typesCode += `struct ${structDeclName} {\n`;
					typesCode += `\t_raw: array<u32, ${rawWords}>,\n`;
					typesCode += `};\n\n`;

					const unionUnpackFn = `unpack_words_to_${toSnakeCase(t.name)}`;
					const unionPackFn = `pack_${toSnakeCase(t.name)}_to_words`;

					typesCode += `// fn ${unionUnpackFn}(raw: array<u32, ${rawWords}>) -> ${structDeclName};\n`;
					typesCode += `// fn ${unionPackFn}(unpacked: ${structDeclName}) -> array<u32, ${rawWords}>;\n`;

					helpersCode += `fn ${unionUnpackFn}(raw: array<u32, ${rawWords}>) -> ${structDeclName} {\n`;
					helpersCode += `\tvar out: ${structDeclName};\n`;
					helpersCode += `\tout._raw = raw;\n`;
					helpersCode += `\treturn out;\n`;
					helpersCode += `}\n\n`;

					helpersCode += `fn ${unionPackFn}(unpacked: ${structDeclName}) -> array<u32, ${rawWords}> {\n`;
					helpersCode += `\treturn unpacked._raw;\n`;
					helpersCode += `}\n\n`;

					const align = t.align || 1;
					const payloadOffset = Math.ceil((t.tagOffset + t.tagSize) / align) * align;

					const tagWord = Math.floor(t.tagOffset / 4);
					const tagShift = (t.tagOffset % 4) * 8;
					const tagSize = t.tagSize;

					typesCode += `// fn get_${fieldName(t.name)}_tag(val: ${structDeclName}) -> u32;\n`;
					helpersCode += `fn get_${fieldName(t.name)}_tag(val: ${structDeclName}) -> u32 {\n`;
					helpersCode += `\treturn extractBits(val._raw[${tagWord}], ${tagShift}u, ${tagSize * 8}u);\n}\n\n`;

					for (let i = 0; i < t.variants.length; i++) {
						const v = t.variants[i];
						if (v.type.kind !== "reference") continue;
						const vStruct = plan.types.find(pt => pt.name === (v.type as any).name);
						if (!vStruct || vStruct.kind !== "struct") continue;

						const variantTypeName = packedStructNames.has(vStruct.name) ? `${typeName(vStruct.name)}Packed` : typeName(vStruct.name);
						const unpackFnName = `unpack_${toSnakeCase(t.name)}_${toSnakeCase(v.name)}`;
						const packFnName = `pack_${toSnakeCase(t.name)}_${toSnakeCase(v.name)}`;

						const words = Math.max(1, Math.ceil((vStruct as any).paddedSize / 4));
						const payloadWordOffset = Math.floor(payloadOffset / 4);

						typesCode += `// fn ${unpackFnName}(val: ${structDeclName}) -> ${variantTypeName};\n`;
						typesCode += `// fn ${packFnName}(unpacked: ${variantTypeName}) -> ${structDeclName};\n`;

						helpersCode += `fn ${unpackFnName}(val: ${structDeclName}) -> ${variantTypeName} {\n`;
						helpersCode += `\tvar tmp: array<u32, ${words}>;\n`;
						helpersCode += `\tfor (var i = 0u; i < ${words}u; i++) {\n`;
						helpersCode += `\t\ttmp[i] = val._raw[${payloadWordOffset}u + i];\n`;
						helpersCode += `\t}\n`;
						helpersCode += `\treturn unpack_words_to_${toSnakeCase(vStruct.name)}(tmp);\n`;
						helpersCode += `}\n\n`;

						helpersCode += `fn ${packFnName}(unpacked: ${variantTypeName}) -> ${structDeclName} {\n`;
						helpersCode += `\tvar out: ${structDeclName};\n`;
						const tagVal = i + 1;
						helpersCode += `\tout._raw[${tagWord}] = insertBits(out._raw[${tagWord}], ${tagVal}u, ${tagShift}u, ${tagSize * 8}u);\n`;
						helpersCode += `\tlet tmp = pack_${toSnakeCase(vStruct.name)}_to_words(unpacked);\n`;
						helpersCode += `\tfor (var i = 0u; i < ${words}u; i++) {\n`;
						helpersCode += `\t\tout._raw[${payloadWordOffset}u + i] = tmp[i];\n`;
						helpersCode += `\t}\n`;
						helpersCode += `\treturn out;\n`;
						helpersCode += `}\n\n`;
					}
					typesCode += `\n`;
					continue;
				}

				// --- STRUCT GENERATION ---
				if (t.kind === "struct") {
					const hasPacking = packedStructNames.has(t.name);

					if (hasPacking) {
						// 1. Generate StructPacked (layout match CPU buffer)
						helpersCode += `struct ${typeName(t.name)}Packed {\n`;
						let offset = 0;
						while (offset < t.paddedSize) {
							const f = t.fields.find(field => field.type.kind !== "unit" && field.offset === offset);
							if (f) {
								const isLarge = f.size >= 4 && (f.offset % 4) === 0;
								if (isLarge) {
									const name = fieldName(f.name);
									const wgslType = getWgslType(f.type, packedStructNames, singletonEnumNames);
									helpersCode += `\t${name}: ${wgslType},\n`;
									offset += f.size;
								} else {
									helpersCode += `\t_word_${offset}: u32,\n`;
									offset += 4;
								}
							} else {
								const overlapping = t.fields.find(field => field.type.kind !== "unit" && field.offset < offset + 4 && field.offset + field.size > offset);
								if (overlapping) {
									helpersCode += `\t_word_${offset}: u32,\n`;
									offset += 4;
								} else {
									helpersCode += `\t_pad_${offset}: u32,\n`;
									offset += 4;
								}
							}
						}
						helpersCode += `};\n\n`;

						// 2. Generate clean struct for usage on GPU
						typesCode += `struct ${typeName(t.name)} {\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const wgslType = f.type.kind === "primitive" && (f.type.name === "bool" || f.type.name === "boolean")
								? "bool"
								: getWgslType(f.type, packedStructNames, singletonEnumNames);
							typesCode += `\t${name}: ${wgslType},\n`;
						}
						typesCode += `};\n\n`;

						// 3. Declarative Signatures as Comments in Structs File
						const snakeName = toSnakeCase(t.name);
						const pName = `${typeName(t.name)}Packed`;
						const uName = typeName(t.name);

						typesCode += `// fn unpack_${snakeName}(packed: ${pName}) -> ${uName};\n`;
						typesCode += `// fn pack_${snakeName}(unpacked: ${uName}) -> ${pName};\n\n`;

						// 4. Implementations in helpersCode using extractBits
						helpersCode += `fn unpack_${snakeName}(packed: ${pName}) -> ${uName} {\n`;
						helpersCode += `\tvar out: ${uName};\n`;
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
								const targetType = f.type.kind === "primitive" && (f.type.name === "bool" || f.type.name === "boolean")
									? "bool"
									: getWgslType(f.type, packedStructNames, singletonEnumNames);

								helpersCode += `\tout.${name} = ${targetType}(${extractedExpr});\n`;
							}
						}
						helpersCode += `\treturn out;\n}\n\n`;

						// 5. Implementations in helpersCode using insertBits
						helpersCode += `fn pack_${snakeName}(unpacked: ${uName}) -> ${pName} {\n`;
						helpersCode += `\tvar out: ${pName};\n`;

						const wordsToInit = new Set<number>();
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const isLarge = f.size >= 4 && (f.offset % 4) === 0;
							if (!isLarge) {
								const wordOffset = Math.floor(f.offset / 4) * 4;
								wordsToInit.add(wordOffset);
							}
						}

						for (const wordOffset of wordsToInit) {
							helpersCode += `\tvar w_${wordOffset} = 0u;\n`;
						}

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

								const valExpr = f.type.kind === "primitive" && (f.type.name === "bool" || f.type.name === "boolean")
									? `select(0u, 1u, unpacked.${name})`
									: `u32(unpacked.${name})`;

								helpersCode += `\tw_${wordOffset} = insertBits(w_${wordOffset}, ${valExpr}, ${bitShift}u, ${bitSize}u);\n`;
							}
						}

						for (const wordOffset of wordsToInit) {
							helpersCode += `\tout._word_${wordOffset} = w_${wordOffset};\n`;
						}

						helpersCode += `\treturn out;\n}\n\n`;

					} else {
						// Struct does not need packing, standard output with correct padding-fields
						typesCode += `struct ${typeName(t.name)} {\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const wgslType = getWgslType(f.type, packedStructNames, singletonEnumNames);

							if (f.paddingAfter > 0) {
								typesCode += `\t${name}: ${wgslType},\n`;
								const padWords = Math.ceil(f.paddingAfter / 4);
								if (padWords === 1) {
									typesCode += `\t_pad_${name}: u32,\n`;
								} else {
									typesCode += `\t_pad_${name}: array<u32, ${padWords}>,\n`;
								}
							} else {
								typesCode += `\t${name}: ${wgslType},\n`;
							}
						}
						typesCode += `};\n\n`;
					}

					// Word Unpacking / Packing (Skip if struct contains atomic fields)
					const hasAtomicFields = t.fields.some(f => !!(f.type as any).atomic);
					if (!hasAtomicFields) {
						const words = Math.max(1, Math.ceil(t.paddedSize / 4));
						const snakeName = toSnakeCase(t.name);
						const cleanName = typeName(t.name);

						const structUnpackFn = hasPacking ? `unpack_words_to_${snakeName}_packed` : `unpack_words_to_${snakeName}`;
						const structPackFn = hasPacking ? `pack_${snakeName}_packed_to_words` : `pack_${snakeName}_to_words`;
						const structDeclName = hasPacking ? `${cleanName}Packed` : cleanName;

						typesCode += `// fn ${structUnpackFn}(raw: array<u32, ${words}>) -> ${structDeclName};\n`;
						typesCode += `// fn ${structPackFn}(unpacked: ${structDeclName}) -> array<u32, ${words}>;\n`;

						if (hasPacking) {
							const publicUnpackFn = `unpack_words_to_${snakeName}`;
							const publicPackFn = `pack_${snakeName}_to_words`;
							typesCode += `// fn ${publicUnpackFn}(raw: array<u32, ${words}>) -> ${cleanName};\n`;
							typesCode += `// fn ${publicPackFn}(unpacked: ${cleanName}) -> array<u32, ${words}>;\n`;
						}
						typesCode += `\n`;

						let unpackWordsBody = `\tvar out: ${structDeclName};\n`;
						let packWordsBody = `\tvar out: array<u32, ${words}>;\n`;

						let offset = 0;
						while (offset < t.paddedSize) {
							const f = t.fields.find(field => field.type.kind !== "unit" && field.offset === offset);
							if (f) {
								const isLarge = f.size >= 4 && (f.offset % 4) === 0;
								const wordIdx = Math.floor(offset / 4);
								const name = fieldName(f.name);

								if (isLarge) {
									// --- LARGE ALIGNED FIELDS (Prymitywy, Tablice, Referencje) ---
									if (f.type.kind === "primitive") {
										// 1. Zwykły skalar prymitywny
										const targetType = getWgslType(f.type, packedStructNames, singletonEnumNames);
										unpackWordsBody += `\tout.${name} = bitcast<${targetType}>(raw[${wordIdx}u]);\n`;
										packWordsBody += `\tout[${wordIdx}u] = bitcast<u32>(unpacked.${name});\n`;
										offset += f.size;
									} else if (f.type.kind === "array") {
										const isVector = f.type.exactLength !== undefined && f.type.item.kind === "primitive" && f.type.exactLength >= 2 && f.type.exactLength <= 4;
										const isVectorArray = f.type.item.kind === "array" && f.type.item.exactLength !== undefined && f.type.item.item.kind === "primitive" && f.type.item.exactLength >= 2 && f.type.item.exactLength <= 4;

										if (isVector) {
											// 2. Zwykły wektor (np. vec3<f32>)
											const scalar = getWgslType(f.type.item, packedStructNames, singletonEnumNames);
											const len = f.type.exactLength!;
											const comps = ["x", "y", "z", "w"];
											const args = Array.from({ length: len }, (_, idx) => `bitcast<${scalar}>(raw[${wordIdx + idx}u])`).join(", ");

											unpackWordsBody += `\tout.${name} = vec${len}<${scalar}>(${args});\n`;
											for (let idx = 0; idx < len; idx++) {
												packWordsBody += `\tout[${wordIdx + idx}u] = bitcast<u32>(unpacked.${name}.${comps[idx]});\n`;
											}
										} else if (isVectorArray) {
											// 2b. Tablica wektorów (np. array<vec4<f32>, 16>)
											const len = f.type.exactLength || f.type.maxLength || 0;
											const itemWords = f.type.exactLength!;
											const tItem = f.type.item as ArrayField;
											const scalarType = getWgslType(tItem, packedStructNames, singletonEnumNames);
											const comps = ["x", "y", "z", "w"];

											unpackWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
											const args = Array.from({ length: itemWords }, (_, idx) => `bitcast<${scalarType}>(raw[${wordIdx}u + i * ${itemWords}u + ${idx}u])`).join(", ");
											unpackWordsBody += `\t\tout.${name}[i] = vec${itemWords}<${scalarType}>(${args});\n`;
											unpackWordsBody += `\t}\n`;

											packWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
											for (let idx = 0; idx < itemWords; idx++) {
												packWordsBody += `\t\tout[${wordIdx}u + i * ${itemWords}u + ${idx}u] = bitcast<u32>(unpacked.${name}[i].${comps[idx]});\n`;
											}
											packWordsBody += `\t}\n`;
										} else if (f.type.item.kind === "primitive") {
											// 3. Duża tablica prymitywów (np. array<f32, 64>)
											const len = f.type.exactLength || f.type.maxLength || 0;
											const scalarType = getWgslType(f.type.item, packedStructNames, singletonEnumNames);

											unpackWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
											unpackWordsBody += `\t\tout.${name}[i] = bitcast<${scalarType}>(raw[${wordIdx}u + i]);\n`;
											unpackWordsBody += `\t}\n`;

											packWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
											packWordsBody += `\t\tout[${wordIdx}u + i] = bitcast<u32>(unpacked.${name}[i]);\n`;
											packWordsBody += `\t}\n`;
										} else if (f.type.item.kind === "reference") {
											// 4. Tablica struktur/unii/enumów (np. array<GameObject, 64>)
											const len = f.type.exactLength || f.type.maxLength || 0;
											const itemType = f.type.item.name;
											const itemKind = getTypeKind(itemType);

											if (itemKind === "enum") {
												const itemTypeStr = typeName(itemType);
												unpackWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
												unpackWordsBody += `\t\tout.${name}[i] = ${itemTypeStr}(raw[${wordIdx}u + i]);\n`;
												unpackWordsBody += `\t}\n`;

												packWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
												packWordsBody += `\t\tout[${wordIdx}u + i] = u32(unpacked.${name}[i]);\n`;
												packWordsBody += `\t}\n`;
											} else {
												const itemWords = getTypeSizeInWords(itemType);
												const itemSnake = toSnakeCase(itemType);
												const isItemPacked = packedStructNames.has(itemType);
												const itemUnpackFn = isItemPacked ? `unpack_words_to_${itemSnake}_packed` : `unpack_words_to_${itemSnake}`;
												const itemPackFn = isItemPacked ? `pack_${itemSnake}_packed_to_words` : `pack_${itemSnake}_to_words`;

												unpackWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
												unpackWordsBody += `\t\tvar tmp: array<u32, ${itemWords}>;\n`;
												unpackWordsBody += `\t\tfor (var j = 0u; j < ${itemWords}u; j = j + 1u) {\n`;
												unpackWordsBody += `\t\t\ttmp[j] = raw[${wordIdx}u + i * ${itemWords}u + j];\n`;
												unpackWordsBody += `\t\t}\n`;
												unpackWordsBody += `\t\tout.${name}[i] = ${itemUnpackFn}(tmp);\n`;
												unpackWordsBody += `\t}\n`;

												packWordsBody += `\tfor (var i = 0u; i < ${len}u; i = i + 1u) {\n`;
												packWordsBody += `\t\tlet tmp = ${itemPackFn}(unpacked.${name}[i]);\n`;
												packWordsBody += `\t\tfor (var j = 0u; j < ${itemWords}u; j = j + 1u) {\n`;
												packWordsBody += `\t\t\tout[${wordIdx}u + i * ${itemWords}u + j] = tmp[j];\n`;
												packWordsBody += `\t\t}\n`;
												packWordsBody += `\t}\n`;
											}
										}
										offset += f.size;
									} else if (f.type.kind === "reference") {
										// 5. Pojedyncza zagnieżdżona struktura/unia/enum
										const refType = f.type.name;
										const refKind = getTypeKind(refType);

										if (refKind === "enum") {
											const refTypeStr = typeName(refType);
											unpackWordsBody += `\tout.${name} = refTypeStr(raw[${wordIdx}u]);\n`;
											packWordsBody += `\tout[${wordIdx}u] = u32(unpacked.${name});\n`;
										} else {
											const itemWords = getTypeSizeInWords(refType);
											const itemSnake = toSnakeCase(refType);
											const isItemPacked = packedStructNames.has(refType);
											const itemUnpackFn = isItemPacked ? `unpack_words_to_${itemSnake}_packed` : `unpack_words_to_${itemSnake}`;
											const itemPackFn = isItemPacked ? `pack_${itemSnake}_packed_to_words` : `pack_${itemSnake}_to_words`;

											unpackWordsBody += `\t{\n`;
											unpackWordsBody += `\t\tvar tmp: array<u32, ${itemWords}>;\n`;
											unpackWordsBody += `\t\tfor (var j = 0u; j < ${itemWords}u; j = j + 1u) {\n`;
											unpackWordsBody += `\t\t\ttmp[j] = raw[${wordIdx}u + j];\n`;
											unpackWordsBody += `\t\t}\n`;
											unpackWordsBody += `\t\tout.${name} = ${itemUnpackFn}(tmp);\n`;
											unpackWordsBody += `\t}\n`;

											packWordsBody += `\t{\n`;
											packWordsBody += `\t\tlet tmp = ${itemPackFn}(unpacked.${name});\n`;
											packWordsBody += `\t\tfor (var j = 0u; j < ${itemWords}u; j = j + 1u) {\n`;
											packWordsBody += `\t\t\tout[${wordIdx}u + j] = tmp[j];\n`;
											packWordsBody += `\t\t}\n`;
											packWordsBody += `\t}\n`;
										}
										offset += f.size;
									}
								} else {
									// --- MAŁE/NIEWYRÓWNANE POLA (Pojedyncze bajty/bity) ---
									// Są one spakowane do u32 na poziomie samej struktury przez extractBits,
									// więc jako u32 słowo kopiujemy je bezpośrednio
									if (hasPacking) {
										unpackWordsBody += `\tout._word_${offset} = raw[${wordIdx}u];\n`;
										packWordsBody += `\tout[${wordIdx}u] = unpacked._word_${offset};\n`;
									}
									offset += 4;
								}
							} else {
								const wordIdx = Math.floor(offset / 4);
								const overlapping = t.fields.find(field => field.type.kind !== "unit" && field.offset < offset + 4 && field.offset + field.size > offset);
								if (overlapping && hasPacking) {
									unpackWordsBody += `\tout._word_${offset} = raw[${wordIdx}u];\n`;
									packWordsBody += `\tout[${wordIdx}u] = unpacked._word_${offset};\n`;
								}
								offset += 4;
							}
						}

						unpackWordsBody += `\treturn out;\n`;
						packWordsBody += `\treturn out;\n`;

						helpersCode += `fn ${structUnpackFn}(raw: array<u32, ${words}>) -> ${structDeclName} {\n${unpackWordsBody}}\n\n`;
						helpersCode += `fn ${structPackFn}(unpacked: ${structDeclName}) -> array<u32, ${words}> {\n${packWordsBody}}\n\n`;

						if (hasPacking) {
							const publicUnpackFn = `unpack_words_to_${snakeName}`;
							const publicPackFn = `pack_${snakeName}_to_words`;

							helpersCode += `fn ${publicUnpackFn}(raw: array<u32, ${words}>) -> ${cleanName} {\n`;
							helpersCode += `\treturn unpack_${snakeName}(${structUnpackFn}(raw));\n`;
							helpersCode += `}\n\n`;

							helpersCode += `fn ${publicPackFn}(unpacked: ${cleanName}) -> array<u32, ${words}> {\n`;
							helpersCode += `\treturn ${structPackFn}(pack_${snakeName}(unpacked));\n`;
							helpersCode += `}\n\n`;
						}
					}
				}
			}

			if (cfg.outputStyle === "types") {
				return typesCode;
			}
			if (cfg.outputStyle === "helpers") {
				return helpersCode;
			}

			return `${typesCode}\n// ==========================================\n// HELPERS\n// ==========================================\n\n${helpersCode}`;
		},
	};
}