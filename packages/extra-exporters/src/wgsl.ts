import type { LayoutPlan, Field, BaseConfig, ExporterPlugin } from "schema-pop";
import { applyNaming } from "schema-pop";

export interface WgslConfig extends BaseConfig {}

function getWgslType(f: Field): string {
	if (f.kind === "primitive") {
		if (f.name === "f32") return "f32";
		if (f.name === "f64") return "f64";
		if (f.name === "i32" || f.name === "i16" || f.name === "i8") return "i32";
		if (f.name === "u32" || f.name === "u16" || f.name === "u8") return "u32";
		if (f.name === "bool" || f.name === "boolean") return "u32"; // WGSL host-shareable structs cannot contain bool
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
	return "u32";
}

export function wgsl(config: WgslConfig): ExporterPlugin<WgslConfig> {
	const cfg = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		...config,
	} as WgslConfig;
	return {
		name: "wgsl",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) {
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
									code += `\t_pad_bits_${f.offset}: array<u32, ${padWords}>,\n`;
								}
							} else {
								const wgslType = getWgslType(f.type);
								const fieldName = applyNaming(f.name, cfg.fieldNaming!);
								const totalSize = f.size + f.paddingAfter;

								// In WGSL, we can use @size to manage padding elegantly.
								if (f.paddingAfter > 0) {
									code += `\t@size(${totalSize}) ${fieldName}: ${wgslType},\n`;
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
