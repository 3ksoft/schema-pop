import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
} from "@schema-pop/schema";
import { WGSL_PREDECLARED_ALIASES } from "@schema-pop/schema";
import { ExporterTools, toSnakeCase } from "../exporterTools";

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
	/**
	 * Output style.
	 * - "combined": output everything in a single file (default)
	 * - "types": output only the structs, aliases, enums and helper function signatures (as comments)
	 * - "helpers": output only the concrete pack/unpack helper functions
	 */
	outputStyle?: "types" | "helpers" | "combined";
}

function getWgslType(f: Field, atomic = false, bitfieldStructNames?: Set<string>, singletonEnumNames?: Set<string>): string {
	if (f.kind === "primitive") {
		const scalar = (() => {
			if(f.atomic && f.binaryType === "i32") return "atomic<i32>"
			if(f.atomic && f.binaryType === "u32") return "atomic<u32>"
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
	if (f.kind === "reference") {
		if (bitfieldStructNames?.has(f.name)) {
			return `${f.name}Packed`;
		}
		if (singletonEnumNames?.has(f.name)) {
			return "u32";
		}
		return f.name;
	}
	if (f.kind === "array") {
		const itemType = getWgslType(f.item, atomic, bitfieldStructNames, singletonEnumNames);
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
		outputStyle: "combined",
		...config,
	} as Required<Pick<WgslConfig, "paddingStyle" | "outputStyle">> & WgslConfig;
	
	const { isRichType, typeName, fieldName } = ExporterTools(cfg);
	
	return {
		name: "wgsl",
		extension: "wgsl",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			let tempId = 0;

			// 1. Identyfikacja jednoelementowych, syntetycznych enumów (singletons)
			const singletonEnumNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "enum" && t.variants.length === 1 && t.syntetic) {
					singletonEnumNames.add(t.name);
				}
			}

			// 2. Identyfikacja wszystkich struktur
			const structNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "struct") structNames.add(t.name);
			}

			const bitfieldStructNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "struct" && t.fields.some(f => (f.type as any).popKind === "bitwise")) {
					bitfieldStructNames.add(t.name);
				}
			}

			// 3. Budowanie mapy enumów (z pominięciem mikro-enumów, ale z zachowaniem tagów unii)
			const enums = new Map<
				string,
				{ underlying: "u32" | "i32"; size: number }
			>();
			for (const t of plan.types) {
				if (t.kind === "enum") {
					if (singletonEnumNames.has(t.name)) continue;
					enums.set(t.name, {
						underlying: t.underlyingType === "i32" ? "i32" : "u32",
						size: t.size,
					});
				}
			}

			const isEnumRef = (f: Field) =>
				f.kind === "reference" && enums.has(f.name);

			const bitfieldStructWidening = new Map<string, number>();
			for (const t of plan.types) {
				if (t.kind !== "struct") continue;
				const nonUnit = t.fields.filter((f) => f.type.kind !== "unit");
				if (
					nonUnit.length === 0 ||
					!nonUnit.every((f) => (f.type as any).popKind === "bitwise")
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

			let typesCode = "";
			let helpersCode = "";

			function genRw(tField: Field, target: string, offsetExpr: string, isPack: boolean, rawArr: string, isAtomic: boolean = false): string {
				if (tField.kind === "primitive") {
					const scalar = tField.name === "f32" ? "f32" : (tField.name === "i32" ? "i32" : "u32");
					if (isAtomic) return `\t// atomic fields cannot be packed/unpacked directly via assignment\n`;
					if (isPack) return `\t${rawArr}[${offsetExpr}] = bitcast<u32>(${target});\n`;
					else return `\t${target} = bitcast<${scalar}>(${rawArr}[${offsetExpr}]);\n`;
				}
				if (tField.kind === "reference") {
					const refName = tField.name;

					if (enums.has(tField.name) || singletonEnumNames.has(tField.name)) {
						const underlying = enums.has(tField.name) ? enums.get(tField.name)!.underlying : "u32";
						if (isPack) return `\t${rawArr}[${offsetExpr}] = bitcast<u32>(${target});\n`;
						else return `\t${target} = bitcast<${underlying}>(${rawArr}[${offsetExpr}]);\n`;
					}
					const refStruct = plan.types.find(pt => pt.name === tField.name);
					if (!refStruct) return `\t// unsupported reference ${tField.name}\n`;
					const words = Math.max(1, Math.ceil((refStruct as any).paddedSize / 4));
					const tmpName = `tmp_${tempId++}`;
					let code = "";
					if (!isPack) {
						code += `\tvar ${tmpName}: array<u32, ${words}>;\n`;
						code += `\tfor (var j_${tmpName} = 0u; j_${tmpName} < ${words}u; j_${tmpName}++) {\n`;
						code += `\t\t${tmpName}[j_${tmpName}] = ${rawArr}[${offsetExpr} + j_${tmpName}];\n`;
						code += `\t}\n`;
						code += `\t${target} = unpack_words_to_${toSnakeCase(tField.name)}(${tmpName});\n`;
					} else {
						code += `\tlet ${tmpName} = pack_${toSnakeCase(tField.name)}_to_words(${target});\n`;
						code += `\tfor (var j_${tmpName} = 0u; j_${tmpName} < ${words}u; j_${tmpName}++) {\n`;
						code += `\t\t${rawArr}[${offsetExpr} + j_${tmpName}] = ${tmpName}[j_${tmpName}];\n`;
						code += `\t}\n`;
					}
					return code;
				}
				if (tField.kind === "array") {
					const isFixed = tField.exactLength !== undefined;
					if (isFixed) {
						const len = tField.exactLength!;
						const isVector =  len <= 4 && !isAtomic;
						
						if (tField.item.kind === "primitive" && isVector) {
							const scalar = getWgslType(tField.item, false, bitfieldStructNames, singletonEnumNames);
							let code = "";
							if (!isPack) {
								const args = Array.from({length: len}, (_, idx) => `bitcast<${scalar}>(${rawArr}[${offsetExpr} + ${idx}u])`).join(", ");
								code += `\t${target} = vec${len}<${scalar}>(${args});\n`;
							} else {
								for (let idx=0; idx<len; idx++) {
									const comp = ["x", "y", "z", "w"][idx];
									code += `\t${rawArr}[${offsetExpr} + ${idx}u] = bitcast<u32>(${target}.${comp});\n`;
								}
							}
							return code;
						}
						
						let itemLayout = 0;
						if (tField.item.kind === "primitive") {
							itemLayout = (tField.item as any).paddedSize ?? (tField.item as any).size ?? 4;
						} else if (tField.item.kind === "reference") {
							const refName = (tField.item as any).name;
							if (enums.has(refName)) {
								itemLayout = enums.get(refName)!.size;
							} else {
								const refS = plan.types.find(pt => pt.name === tField.item.kind || pt.name === refName);
								itemLayout = (refS as any)?.paddedSize ?? 0;
							}
						} else if (tField.item.kind === "array") {
							itemLayout = (tField.item as any).paddedSize ?? 0;
						}
						
						let strideW = Math.max(1, Math.floor(itemLayout / 4));
						
						const idxName = `i_${tempId++}`;
						let code = `\tfor (var ${idxName} = 0u; ${idxName} < ${len}u; ${idxName}++) {\n`;
						const innerOffset = `(${offsetExpr} + ${idxName} * ${strideW}u)`;
						const innerTarget = `${target}[${idxName}]`;
						
						const innerCode = genRw(tField.item, innerTarget, innerOffset, isPack, rawArr, isAtomic);
						code += innerCode.split('\n').filter(Boolean).map(l => `\t${l}\n`).join('');
						code += `\t}\n`;
						return code;
					} else {
						// === ODKODOWYWANIE TABLICY O ZMIENNEJ DŁUGOŚCI ===
						const maxLen = tField.maxLength || 0;
						let itemLayout = 0;
						if (tField.item.kind === "primitive") {
							itemLayout = (tField.item as any).paddedSize ?? (tField.item as any).size ?? 4;
						} else if (tField.item.kind === "reference") {
							const refName = (tField.item as any).name;
							if (enums.has(refName)) {
								itemLayout = enums.get(refName)!.size;
							} else {
								const refS = plan.types.find(pt => pt.name === tField.item.kind || pt.name === refName);
								itemLayout = (refS as any)?.paddedSize ?? 0;
							}
						} else if (tField.item.kind === "array") {
							itemLayout = (tField.item as any).paddedSize ?? 0;
						}
						
						let strideW = Math.max(1, Math.floor(itemLayout / 4));
						
						const parent = target.substring(0, target.lastIndexOf("."));
						const prop = target.substring(target.lastIndexOf(".") + 1);
						const lenTarget = `${parent}.${prop}_len`;
						
						let code = "";
						if (!isPack) {
							code += `\t${lenTarget} = ${rawArr}[${offsetExpr}];\n`;
							const idxName = `i_${tempId++}`;
							code += `\tfor (var ${idxName} = 0u; ${idxName} < ${maxLen}u; ${idxName}++) {\n`;
							const innerOffset = `(${offsetExpr} + 1u + ${idxName} * ${strideW}u)`;
							const innerTarget = `${target}[${idxName}]`;
							
							const innerCode = genRw(tField.item, innerTarget, innerOffset, isPack, rawArr, isAtomic);
							code += innerCode.split('\n').filter(Boolean).map(l => `\t\t${l}\n`).join('');
							code += `\t}\n`;
						} else {
							code += `\t${rawArr}[${offsetExpr}] = ${lenTarget};\n`;
							const idxName = `i_${tempId++}`;
							code += `\tfor (var ${idxName} = 0u; ${idxName} < ${maxLen}u; ${idxName}++) {\n`;
							const innerOffset = `(${offsetExpr} + 1u + ${idxName} * ${strideW}u)`;
							const innerTarget = `${target}[${idxName}]`;
							
							const innerCode = genRw(tField.item, innerTarget, innerOffset, isPack, rawArr, isAtomic);
							code += innerCode.split('\n').filter(Boolean).map(l => `\t\t${l}\n`).join('');
							code += `\t}\n`;
						}
						return code;
					}
				}
				return `\t// unsupported field kind ${tField.kind}\n`;
			}

			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ wgsl: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
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
				if (t.kind === "alias") {
					if (WGSL_PREDECLARED_ALIASES.has(t.name)) continue;
					const aliasName = typeName(t.name);
					const target = getWgslType(t.type, false, bitfieldStructNames, singletonEnumNames);
					typesCode += `alias ${aliasName} = ${target};\n\n`;
					continue;
				}
				if (t.kind === "union") {
					const structDeclName = typeName(t.name);
					const rawWords = Math.max(1, Math.ceil(t.paddedSize / 4));
					typesCode += `struct ${structDeclName} {\n`;
					typesCode += `\t_raw: array<u32, ${rawWords}>,\n`;
					typesCode += `};\n\n`;

					typesCode += `// Helper signatures for ${structDeclName}:\n`;
					typesCode += `// fn get_${fieldName(t.name)}_tag(val: ${structDeclName}) -> u32;\n`;

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
					const tagMask = t.tagSize === 4 ? `0xFFFFFFFFu` : `0x${((1 << (t.tagSize * 8)) - 1).toString(16).toUpperCase()}u`;
					
					helpersCode += `fn get_${fieldName(t.name)}_tag(val: ${structDeclName}) -> u32 {\n`;
					let expr = `val._raw[${tagWord}]`;
					if (tagShift > 0) expr = `(${expr} >> ${tagShift}u)`;
					if (t.tagSize < 4) expr = `(${expr} & ${tagMask})`;
					helpersCode += `\treturn ${expr};\n}\n\n`;

					for (let i = 0; i < t.variants.length; i++) {
						const v = t.variants[i];
						if (v.type.kind !== "reference") {
							console.warn(`  ⚠ wgsl: union variant ${v.name} is not a reference, skipping unpack/pack generation.`);
							continue;
						}
						const vStruct = plan.types.find(pt => pt.name === (v.type as any).name);
						if (!vStruct || vStruct.kind !== "struct") {
							console.warn(`  ⚠ wgsl: union variant ${v.name} target struct not found, skipping unpack/pack generation.`);
							continue;
						}
						
						const variantTypeName = bitfieldStructNames.has(vStruct.name) ? `${typeName(vStruct.name)}Packed` : typeName(vStruct.name);
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
						const tagVal = i;
						helpersCode += `\tout._raw[${tagWord}] = (out._raw[${tagWord}] & ~(${tagMask} << ${tagShift}u)) | (${tagVal}u << ${tagShift}u);\n`;
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
				if (t.kind === "struct") {
					const hasBitfields = bitfieldStructNames.has(t.name);
					const structDeclName = hasBitfields ? `${typeName(t.name)}Packed` : typeName(t.name);
					typesCode += `struct ${structDeclName} {\n`;
					let currentBitfieldOffset = -1;
					const bitfields: typeof t.fields = [];
					for (const f of t.fields) {
						if (f.type.kind !== "unit") {
							const isBit = (f.type as any).popKind === "bitwise";
							if (isBit) {
								bitfields.push(f);
								if (currentBitfieldOffset !== f.offset) {
									typesCode += `\t_bitfield_${f.offset}: u32,\n`;
									currentBitfieldOffset = f.offset;
								}
								if (f.paddingAfter > 0) {
									const padWords = Math.ceil(f.paddingAfter / 4);
									if (padWords === 1) {
										typesCode += `\t_pad_bits_${f.name}: u32,\n`;
									} else {
										typesCode += `\t_pad_bits_${f.name}: array<u32, ${padWords}>,\n`;
									}
								}
							} else {
								const name = fieldName(f.name);

								if (f.type.kind === "array" && f.type.exactLength === undefined) {
									const itemType = getWgslType(f.type.item, false, bitfieldStructNames, singletonEnumNames);
									const maxLen = f.type.maxLength;
									const arrType = maxLen ? `array<${itemType}, ${maxLen}>` : `array<${itemType}>`;
									typesCode += `\t${name}_len: u32,\n`;
									typesCode += `\t${name}: ${arrType},\n`;
								} else {
									const wgslType = getWgslType(
										f.type,
										!!(f as { atomic?: boolean }).atomic,
										bitfieldStructNames,
										singletonEnumNames,
									);

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
											typesCode += `\t@size(${totalSize}) ${name}: ${wgslType},\n`;
										} else {
											typesCode += `\t${name}: ${wgslType},\n`;
											const padWords = Math.ceil(effectivePadAfter / 4);
											if (padWords === 1) {
												typesCode += `\t_pad_${name}: u32,\n`;
											} else {
												typesCode += `\t_pad_${name}: array<u32, ${padWords}>,\n`;
											}
										}
									} else {
										typesCode += `\t${name}: ${wgslType},\n`;
									}
								}
							}
						}
					}
					typesCode += `};\n\n`;

					let helperSignatures = `// Helper signatures for ${structDeclName}:\n`;

					if (hasBitfields && bitfields.length > 0) {
						const sName = typeName(t.name);
						const packedName = `${sName}Packed`;
						const unpackedName = sName;
						const snakeName = t.name.replace(/([A-Z])/g, (_m, c, i) =>
							i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`,
						);
						const unpackFnName = `unpack_${snakeName}`;
						const packFnName = `pack_${snakeName}`;

						typesCode += `struct ${unpackedName} {\n`;
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const isBit = (f.type as any).popKind === "bitwise";
							if (isBit) {
								const wType = f.bitSize === 1 ? "bool" : "u32";
								typesCode += `\t${fieldName(f.name)}: ${wType},\n`;
							} else {
								const name = fieldName(f.name);
								if (f.type.kind === "array" && f.type.exactLength === undefined) {
									const itemType = getWgslType(f.type.item, false, bitfieldStructNames, singletonEnumNames);
									const maxLen = f.type.maxLength;
									const arrType = maxLen ? `array<${itemType}, ${maxLen}>` : `array<${itemType}>`;
									typesCode += `\t${name}_len: u32,\n`;
									typesCode += `\t${name}: ${arrType},\n`;
								} else {
									const wgslType = getWgslType(
										f.type,
										!!(f as { atomic?: boolean }).atomic,
										bitfieldStructNames,
										singletonEnumNames,
									);
									typesCode += `\t${name}: ${wgslType},\n`;
								}
							}
						}
						typesCode += `};\n\n`;

						helperSignatures += `// fn ${unpackFnName}(packed: ${packedName}) -> ${unpackedName};\n`;
						helperSignatures += `// fn ${packFnName}(unpacked: ${unpackedName}) -> ${packedName};\n`;

						helpersCode += `fn ${unpackFnName}(packed: ${packedName}) -> ${unpackedName} {\n`;
						helpersCode += `\tvar out: ${unpackedName};\n`;
						const seenBytes = new Set<number>();
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const fName = fieldName(f.name);
							const isBit = (f.type as any).popKind === "bitwise";
							if (isBit) {
								if (!seenBytes.has(f.offset)) {
									seenBytes.add(f.offset);
									helpersCode += `\tlet _raw${f.offset} = packed._bitfield_${f.offset};\n`;
								}
								const mask = `0x${((1 << f.bitSize) - 1).toString(16).toUpperCase()}u`;
								const shift = (f.offset % 4) * 8 + f.bitOffset;
								const shifted =
									shift === 0
										? `_raw${f.offset}`
										: `(_raw${f.offset} >> ${shift}u)`;
								if (f.bitSize === 1) {
									helpersCode += `\tout.${fName} = bool(${shifted} & ${mask});\n`;
								} else {
									helpersCode += `\tout.${fName} = ${shifted} & ${mask};\n`;
								}
							} else {
								if (f.type.kind === "array" && f.type.exactLength === undefined) {
									helpersCode += `\tout.${fName}_len = packed.${fName}_len;\n`;
								}
								helpersCode += `\tout.${fName} = packed.${fName};\n`;
							}
						}
						helpersCode += `\treturn out;\n}\n\n`;

						helpersCode += `fn ${packFnName}(unpacked: ${unpackedName}) -> ${packedName} {\n`;
						helpersCode += `\tvar out: ${packedName};\n`;
						const initBytes = new Set<number>();
						for (const f of t.fields) {
							if (f.type.kind === "unit") continue;
							const fName = fieldName(f.name);
							const isBit = (f.type as any).popKind === "bitwise";
							if (isBit) {
								if (!initBytes.has(f.offset)) {
									initBytes.add(f.offset);
									helpersCode += `\tout._bitfield_${f.offset} = 0u;\n`;
								}
								const mask = `0x${((1 << f.bitSize) - 1).toString(16).toUpperCase()}u`;
								const srcExpr =
									f.bitSize === 1
										? `select(0u, 1u, unpacked.${fName})`
										: `(unpacked.${fName} & ${mask})`;
								const shift = (f.offset % 4) * 8 + f.bitOffset;
								const shiftSuffix =
									shift === 0 ? "" : ` << ${shift}u`;
								helpersCode += `\tout._bitfield_${f.offset} |= ${srcExpr}${shiftSuffix};\n`;
							} else {
								if (f.type.kind === "array" && f.type.exactLength === undefined) {
									helpersCode += `\tout.${fName}_len = unpacked.${fName}_len;\n`;
								}
								helpersCode += `\tout.${fName} = unpacked.${fName};\n`;
							}
						}
						helpersCode += `\treturn out;\n}\n\n`;
					}

					const words = Math.max(1, Math.ceil(t.paddedSize / 4));
					const structUnpackFn = `unpack_words_to_${toSnakeCase(t.name)}`;
					const structPackFn = `pack_${toSnakeCase(t.name)}_to_words`;

					let structUnpackBody = `\tvar out: ${structDeclName};\n`;
					const seenBits = new Set<number>();

					const getPackExpression = (tField: Field, target: string): string => {
						if (tField.kind === "primitive") {
							const scalar = tField.name === "f32" ? "f32" : (tField.name === "i32" ? "i32" : "u32");
							return `bitcast<u32>(${target})`;
						}
						if (tField.kind === "reference" && enums.has(tField.name)) {
							return `bitcast<u32>(${target})`;
						}
						return "";
					};

					const wordWrites = new Map<number, string[]>();
					const complexWrites: string[] = [];

					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const offsetW = Math.floor(f.offset / 4);

						if ((f.type as any).popKind === "bitwise") {
							if (!seenBits.has(f.offset)) {
								seenBits.add(f.offset);
								wordWrites.set(offsetW, [...(wordWrites.get(offsetW) || []), `unpacked._bitfield_${f.offset}`]);
								structUnpackBody += `\tout._bitfield_${f.offset} = raw[${offsetW}u];\n`;
							}
							continue;
						}

						const name = fieldName(f.name);
						const isAtomic = !!(f as any).atomic;

						const byteShift = (f.offset % 4) * 8;
						const isLeafPrim = f.type.kind === "primitive";
						const isLeafEnum = f.type.kind === "reference" && enums.has((f.type as any).name);
						const isLeafSubWord = !isAtomic && (isLeafPrim || isLeafEnum) && (f.size < 4 || byteShift !== 0);

						if (isLeafSubWord) {
							const mask = `0x${(((1 << (f.size * 8)) - 1) >>> 0).toString(16).toUpperCase()}u`;
							const scalar = isLeafPrim
								? ((f.type as any).name === "f32" ? "f32" : ((f.type as any).name === "i32" ? "i32" : "u32"))
								: enums.get((f.type as any).name)!.underlying;
							const readMasked = byteShift === 0
								? `(raw[${offsetW}u] & ${mask})`
								: `((raw[${offsetW}u] >> ${byteShift}u) & ${mask})`;
							structUnpackBody += scalar === "u32"
								? `\tout.${name} = ${readMasked};\n`
								: `\tout.${name} = bitcast<${scalar}>(${readMasked});\n`;
							const packShift = byteShift === 0 ? "" : ` << ${byteShift}u`;
							const packExpr = `((bitcast<u32>(unpacked.${name}) & ${mask})${packShift})`;
							wordWrites.set(offsetW, [...(wordWrites.get(offsetW) || []), packExpr]);
							continue;
						}

						if (f.type.kind === "array" && f.type.exactLength === undefined) {
							structUnpackBody += genRw(f.type, `out.${name}`, `${offsetW}u`, false, "raw", isAtomic);
							complexWrites.push(genRw(f.type, `unpacked.${name}`, `${offsetW}u`, true, "out", isAtomic));
							continue;
						}

						structUnpackBody += genRw(f.type, `out.${name}`, `${offsetW}u`, false, "raw", isAtomic);

						const expr = getPackExpression(f.type, `unpacked.${name}`);
						if (expr) {
							wordWrites.set(offsetW, [...(wordWrites.get(offsetW) || []), expr]);
						} else {
							complexWrites.push(genRw(f.type, `unpacked.${name}`, `${offsetW}u`, true, "out", isAtomic));
						}
					}

					structUnpackBody += `\treturn out;\n`;

					let structPackBody = `\tvar out: array<u32, ${words}>;\n`;
					for (let w = 0; w < words; w++) {
						const exprs = wordWrites.get(w);
						if (exprs && exprs.length > 0) {
							structPackBody += `\tout[${w}u] = ${exprs.join(" | ")};\n`;
						}
					}
					for (const cw of complexWrites) {
						structPackBody += cw;
					}
					structPackBody += `\treturn out;\n`;

					const hasAtomicFields = t.fields.some(f => !!(f as any).atomic);
					if (!hasAtomicFields) {
						helperSignatures += `// fn ${structUnpackFn}(raw: array<u32, ${words}>) -> ${structDeclName};\n`;
						helperSignatures += `// fn ${structPackFn}(unpacked: ${structDeclName}) -> array<u32, ${words}>;\n`;

						helpersCode += `fn ${structUnpackFn}(raw: array<u32, ${words}>) -> ${structDeclName} {\n${structUnpackBody}}\n\n`;
						helpersCode += `fn ${structPackFn}(unpacked: ${structDeclName}) -> array<u32, ${words}> {\n${structPackBody}}\n\n`;
					}

					typesCode += helperSignatures + "\n";
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