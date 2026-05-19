import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
} from "@schema-pop/schema";
import { applyNaming, ExporterTools } from "../exporterTools";

export interface GlslConfig extends BaseConfig {}

function getGlslType(f: Field): string {
	if (f.kind === "primitive") {
		if (f.name === "f32") return "float";
		if (f.name === "f64") return "double";
		if (f.name === "i32" || f.name === "i16" || f.name === "i8") return "int";
		if (f.name === "u32" || f.name === "u16" || f.name === "u8") return "uint";
		if (f.name === "bool" || f.name === "boolean") return "bool";
		return "uint";
	}
	if (f.kind === "reference") return f.name;
	if (f.kind === "array") {
		const itemType = getGlslType(f.item);
		const isVector =
			f.exactLength !== undefined &&
			f.item.kind === "primitive" &&
			f.exactLength >= 2 &&
			f.exactLength <= 4;
		if (isVector) {
			if (f.item.name === "f32") return `vec${f.exactLength}`;
			if (f.item.name === "f64") return `dvec${f.exactLength}`;
			if (f.item.name.startsWith("i")) return `ivec${f.exactLength}`;
			if (f.item.name.startsWith("u")) return `uvec${f.exactLength}`;
			if (f.item.name === "bool" || f.item.name === "boolean")
				return `bvec${f.exactLength}`;
		}
		return itemType;
	}
	return "uint";
}

export function glsl(config: GlslConfig): ExporterPlugin<GlslConfig> {
	const cfg = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		...config,
	} as GlslConfig;
	return {
		name: "glsl",
		extension: "glsl",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const { isRichType } = ExporterTools(cfg);
			let code = "";
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ glsl: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				if (t.kind === "struct") {
					code += `struct ${applyNaming(t.name, cfg.typeNaming!)} {\n`;
					let currentBitfieldOffset = -1;
					for (const f of t.fields) {
						if (f.type.kind !== "unit") {
							if (f.bitSize && f.bitSize < 8) {
								if (currentBitfieldOffset !== f.offset) {
									code += `\tuint _bitfield_${f.offset};\n`;
									currentBitfieldOffset = f.offset;
								}
								if (f.paddingAfter > 0) {
									const padWords = Math.ceil(f.paddingAfter / 4);
									code += `\tuint _pad_bits_${f.offset}[${padWords}];\n`;
								}
							} else {
								const glslType = getGlslType(f.type);
								const fieldName = applyNaming(f.name, cfg.fieldNaming!);
								const isVector =
									f.type.kind === "array" &&
									f.type.exactLength !== undefined &&
									f.type.item.kind === "primitive" &&
									f.type.exactLength >= 2 &&
									f.type.exactLength <= 4;
								const isArray = f.type.kind === "array" && !isVector;

								if (isArray) {
									const len =
										(f.type as any).exactLength || (f.type as any).maxLength;
									const max = len ? `[${len}]` : "[]";
									code += `\t${glslType} ${fieldName}${max};\n`;
								} else {
									code += `\t${glslType} ${fieldName};\n`;
								}

								if (f.paddingAfter > 0) {
									const padWords = Math.ceil(f.paddingAfter / 4);
									code += `\tuint _pad_${fieldName}[${padWords}];\n`;
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
