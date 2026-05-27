import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
} from "@schema-pop/schema";
import { WGSL_PREDECLARED_ALIASES } from "@schema-pop/schema";
import { ExporterTools, toSnakeCase } from "../exporterTools";

export interface WgslConfig extends BaseConfig {
	paddingStyle?: "size" | "fields";
	outputStyle?: "types" | "helpers" | "combined";
}

function getWgslType(f: Field, atomic = false, packedStructNames?: Set<string>, singletonEnumNames?: Set<string>): string {
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
		if (atomic && scalar !== "u32" && scalar !== "i32") {
			console.warn(
				`  ⚠ wgsl: atomic requested on non-integer scalar "${scalar}". Emitting non-atomic.`,
			);
			return scalar;
		}
		return atomic ? `atomic<${scalar}>` : scalar;
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
		const itemType = getWgslType(f.item, atomic, packedStructNames, singletonEnumNames);
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

			let typesCode = "";
			let helpersCode = "";

			for (const t of plan.types) {
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
					
					typesCode += `// Enum variants for ${name}:\n`;
					for (const v of t.variants) {
						typesCode += `//   ${v.name} = ${v.value}\n`;
					}
					
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
					const target = getWgslType(t.type, false, packedStructNames, singletonEnumNames);
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
					const tagMask = t.tagSize === 4 ? `0xFFFFFFFFu` : `0x${((1 << (t.tagSize * 8)) - 1).toString(16).toUpperCase()}u`;
					
					helpersCode += `fn get_${fieldName(t.name)}_tag(val: ${structDeclName}) -> u32 {\n`;
					let expr = `val._raw[${tagWord}]`;
					if (tagShift > 0) expr = `(${expr} >> ${tagShift}u)`;
					if (t.tagSize < 4) expr = `(${expr} & ${tagMask})`;
					helpersCode += `\treturn ${expr};\n}\n\n`;

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

						helpersCode += `fn ${unpackFnName}(val: ${structDeclName}) -> ${variantTypeName} {\n`;
						helpersCode += `\tvar tmp: array<u32, ${words}>;\n`;
						helpersCode += `\tfor (var i = 0u; i < ${words}u; i++) {\n`;
						helpersCode += `\t\ttmp[i] = val._raw[${payloadWordOffset}u + i];\n`;
						helpersCode += `\t}\n`;
						helpersCode += `\treturn unpack_words_to_${toSnakeCase(vStruct.name)}(tmp);\n`;
						helpersCode += `}\n\n`;

						helpersCode += `fn ${packFnName}(unpacked: ${variantTypeName}) -> ${structDeclName} {\n`;
						helpersCode += `\tvar out: ${structDeclName};\n`;
						const tagVal = i;
						helpersCode += `\tout._raw[${tagWord}] = (out._raw[${tagWord}] & ~(${tagMask} << ${tagShift}u)) | (${tagVal}u << ${tagShift}u);\n`;
						helpersCode += `\tlet tmp = pack_${toSnakeCase(vStruct.name)}_to_words(unpacked);\n`;
						helpersCode += `\tfor (var i = 0u; i < ${words}u; i++) {\n`;
						helpersCode += `\t\tout._raw[${payloadWordOffset}u + i] = tmp[i];\n`;
						helpersCode += `\t}\n`;
						helpersCode += `\treturn out;\n`;
						helpersCode += `}\n\n`;
					}
					continue;
				}

				// --- STRUCT GENERATION ---
				if (t.kind === "struct") {
					const hasPacking = packedStructNames.has(t.name);

					if (hasPacking) {
						// 1. Generate StructPacked (layout match CPU buffer)
						typesCode += `struct ${typeName(t.name)}Packed {\n`;
						let offset = 0;
						while (offset < t.paddedSize) {
							const f = t.fields.find(field => field.type.kind !== "unit" && field.offset === offset);
							if (f) {
								const isLarge = f.size >= 4 && (f.offset % 4) === 0;
								if (isLarge) {
									const name = fieldName(f.name);
									const wgslType = getWgslType(f.type, !!(f as any).atomic, packedStructNames, singletonEnumNames);
									typesCode += `\t${name}: ${wgslType},\n`;
									offset += f.size;
								} else {
									typesCode += `\t_word_${offset}: u32,\n`;
									offset += 4;
								}
							} else {
								const overlapping = t.fields.find(field => field.type.kind !== "unit" && field.offset < offset + 4 && field.offset + field.size > offset);
								if (overlapping) {
									typesCode += `\t_word_${offset}: u32,\n`;
									offset += 4;
								} else {
									typesCode += `\t_pad_${offset}: u32,\n`;
									offset += 4;
								}
							}
						}
						typesCode += `};\n\n`;

						// 2. Generate clean struct for usage on GPU
						typesCode += `struct ${typeName(t.name)} {\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const wgslType = f.type.kind === "primitive" && (f.type.name === "bool" || f.type.name === "boolean")
								? "bool"
								: getWgslType(f.type, !!(f as any).atomic, packedStructNames, singletonEnumNames);
							typesCode += `\t${name}: ${wgslType},\n`;
						}
						typesCode += `};\n\n`;

						// 3. Helper unpacker and packer
						const snakeName = toSnakeCase(t.name);
						const pName = `${typeName(t.name)}Packed`;
						const uName = typeName(t.name);

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
								const maskVal = ((1 << bitSize) - 1) >>> 0;
								const mask = `0x${maskVal.toString(16).toUpperCase()}u`;

								const shiftedExpr = bitShift === 0
									? `packed._word_${wordOffset}`
									: `(packed._word_${wordOffset} >> ${bitShift}u)`;

								if (f.type.kind === "primitive" && (f.type.name === "bool" || f.type.name === "boolean")) {
									helpersCode += `\tout.${name} = bool(${shiftedExpr} & ${mask});\n`;
								} else {
									helpersCode += `\tout.${name} = ${shiftedExpr} & ${mask};\n`;
								}
							}
						}
						helpersCode += `\treturn out;\n}\n\n`;

						helpersCode += `fn pack_${snakeName}(unpacked: ${uName}) -> ${pName} {\n`;
						helpersCode += `\tvar out: ${pName};\n`;

						const wordWrites = new Map<number, string[]>();
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
								const maskVal = ((1 << bitSize) - 1) >>> 0;
								const mask = `0x${maskVal.toString(16).toUpperCase()}u`;

								const valExpr = f.type.kind === "primitive" && (f.type.name === "bool" || f.type.name === "boolean")
									? `select(0u, 1u, unpacked.${name})`
									: `u32(unpacked.${name})`;

								const maskedExpr = `(${valExpr} & ${mask})`;
								const shiftedExpr = bitShift === 0
									? maskedExpr
									: `(${maskedExpr} << ${bitShift}u)`;

								wordWrites.set(wordOffset, [...(wordWrites.get(wordOffset) || []), shiftedExpr]);
							}
						}

						for (const [wordOffset, exprs] of wordWrites.entries()) {
							helpersCode += `\tout._word_${wordOffset} = ${exprs.join(" | ")};\n`;
						}

						helpersCode += `\treturn out;\n}\n\n`;

					} else {
						// Struct does not need packing, standard output
						typesCode += `struct ${typeName(t.name)} {\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const name = fieldName(f.name);
							const wgslType = getWgslType(f.type, !!(f as any).atomic, packedStructNames, singletonEnumNames);
							typesCode += `\t${name}: ${wgslType},\n`;
						}
						typesCode += `};\n\n`;
					}

					// Word Unpacking / Packing (Useful for Unions and low-level block copying)
					const hasAtomicFields = t.fields.some(f => !!(f as any).atomic);
					if (!hasAtomicFields) {
						const words = Math.max(1, Math.ceil(t.paddedSize / 4));
						const structUnpackFn = `unpack_words_to_${toSnakeCase(t.name)}`;
						const structPackFn = `pack_${toSnakeCase(t.name)}_to_words`;
						const structDeclName = hasPacking ? `${typeName(t.name)}Packed` : typeName(t.name);

						let unpackWordsBody = `\tvar out: ${structDeclName};\n`;
						let packWordsBody = `\tvar out: array<u32, ${words}>;\n`;

						let offset = 0;
						while (offset < t.paddedSize) {
							const f = t.fields.find(field => field.type.kind !== "unit" && field.offset === offset);
							if (f) {
								const isLarge = f.size >= 4 && (f.offset % 4) === 0;
								const wordIdx = offset / 4;
								if (isLarge && !hasPacking) {
									const name = fieldName(f.name);
									const fieldWords = f.size / 4;
									if (fieldWords === 1) {
										unpackWordsBody += `\tout.${name} = bitcast<${getWgslType(f.type, false, packedStructNames, singletonEnumNames)}>(raw[${wordIdx}u]);\n`;
										packWordsBody += `\tout[${wordIdx}u] = bitcast<u32>(unpacked.${name});\n`;
									} else if (f.type.kind === "array" && f.type.exactLength !== undefined && f.type.exactLength <= 4) {
										const scalar = getWgslType(f.type.item, false, packedStructNames, singletonEnumNames);
										const len = f.type.exactLength;
										const comps = ["x", "y", "z", "w"];
										const args = Array.from({length: len}, (_, idx) => `bitcast<${scalar}>(raw[${wordIdx + idx}u])`).join(", ");
										unpackWordsBody += `\tout.${name} = vec${len}<${scalar}>(${args});\n`;
										for (let idx = 0; idx < len; idx++) {
											packWordsBody += `\tout[${wordIdx + idx}u] = bitcast<u32>(unpacked.${name}.${comps[idx]});\n`;
										}
									}
									offset += f.size;
								} else {
									if (hasPacking) {
										const isFRefLarge = f.size >= 4 && (f.offset % 4) === 0;
										if (isFRefLarge) {
											const name = fieldName(f.name);
											const fieldWords = f.size / 4;
											if (fieldWords === 1) {
												unpackWordsBody += `\tout.${name} = bitcast<${getWgslType(f.type, false, packedStructNames, singletonEnumNames)}>(raw[${wordIdx}u]);\n`;
												packWordsBody += `\tout[${wordIdx}u] = bitcast<u32>(unpacked.${name});\n`;
											} else if (f.type.kind === "array" && f.type.exactLength !== undefined && f.type.exactLength <= 4) {
												const scalar = getWgslType(f.type.item, false, packedStructNames, singletonEnumNames);
												const len = f.type.exactLength;
												const comps = ["x", "y", "z", "w"];
												const args = Array.from({length: len}, (_, idx) => `bitcast<${scalar}>(raw[${wordIdx + idx}u])`).join(", ");
												unpackWordsBody += `\tout.${name} = vec${len}<${scalar}>(${args});\n`;
												for (let idx = 0; idx < len; idx++) {
													packWordsBody += `\tout[${wordIdx + idx}u] = bitcast<u32>(unpacked.${name}.${comps[idx]});\n`;
												}
											}
											offset += f.size;
										} else {
											unpackWordsBody += `\tout._word_${offset} = raw[${wordIdx}u];\n`;
											packWordsBody += `\tout[${wordIdx}u] = unpacked._word_${offset};\n`;
											offset += 4;
										}
									} else {
										offset += 4;
									}
								}
							} else {
								const wordIdx = offset / 4;
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