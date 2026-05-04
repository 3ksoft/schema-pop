import type { LayoutPlan, Field, BaseConfig, ExporterPlugin } from "schema-pop";
import { applyNaming, ExporterTools } from "schema-pop";

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

function getWgslType(f: Field): string {
	if (f.kind === "primitive") {
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
	}
	if (f.kind === "reference") return f.name;
	if (f.kind === "array") {
		const itemType = getWgslType(f.item);
		const isVector =
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
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		paddingStyle: "fields",
		...config,
	} as Required<Pick<WgslConfig, "paddingStyle">> & WgslConfig;
	return {
		name: "wgsl",
		extension: "wgsl",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const { isRichType } = ExporterTools(cfg);
			let code = "";
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ wgsl: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				if (t.kind === "alias") {
					const aliasName = applyNaming(t.name, cfg.typeNaming!);
					const target = getWgslType(t.type);
					code += `alias ${aliasName} = ${target};\n\n`;
					continue;
				}
				if (t.kind === "struct") {
					code += `struct ${applyNaming(t.name, cfg.typeNaming!)} {\n`;
					let currentBitfieldOffset = -1;
					for (const f of t.fields) {
						if (f.type.kind !== "unit") {
							if (f.bitSize && f.bitSize < 8) {
								if (currentBitfieldOffset !== f.offset) {
									code += `\t_bitfield_${f.offset}: u32,\n`;
									currentBitfieldOffset = f.offset;
								}
								if (f.paddingAfter > 0) {
									const padWords = Math.ceil(f.paddingAfter / 4);
									code += `\t_pad_bits_${f.name}: array<u32, ${padWords}>,\n`;
								}
							} else {
								const wgslType = getWgslType(f.type);
								const fieldName = applyNaming(f.name, cfg.fieldNaming!);

								if (f.paddingAfter > 0) {
									if (cfg.paddingStyle === "size") {
										const totalSize = f.size + f.paddingAfter;
										code += `\t@size(${totalSize}) ${fieldName}: ${wgslType},\n`;
									} else {
										// "fields" — explicit named padding slot(s)
										code += `\t${fieldName}: ${wgslType},\n`;
										const padWords = Math.ceil(f.paddingAfter / 4);
										if (padWords === 1) {
											code += `\t_pad_${fieldName}: u32,\n`;
										} else {
											code += `\t_pad_${fieldName}: array<u32, ${padWords}>,\n`;
										}
									}
								} else {
									code += `\t${fieldName}: ${wgslType},\n`;
								}
							}
						}
					}
					code += `};\n\n`;
				}
			}
			return code;
		},
	};
}
