import type { BaseConfig, ExporterPlugin } from "../api";
import type { Field, LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";
import { zigHarness } from "./zigHarness";

export interface ZigConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
	commentStyle?: "slash";
	pub?: boolean;
	includeComptimeAssertions?: boolean;
	harness?: boolean;
}

const ZIG_PRIMITIVES: Record<string, string> = {
	u8: "u8",
	i8: "i8",
	u16: "u16",
	i16: "i16",
	u32: "u32",
	i32: "i32",
	u64: "u64",
	i64: "i64",
	u128: "u128",
	i128: "i128",
	f32: "f32",
	f64: "f64",
	bool: "bool",
	boolean: "bool",
};

export function zig(config: ZigConfig): ExporterPlugin<ZigConfig, string> {
	const cfg: ZigConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		includeComptimeAssertions: true,
		...config,
	};
	const {
		typeName,
		fieldName,
		indent,
		mapScalarField,
		wrapNamespace,
		isRichType,
		toSafeVersionIdentifier,
	} = ExporterTools(cfg);

	function fieldZigType(
		field: Field,
		fieldSize: number,
		structAlign: number,
	): string {
		// Pointer indirection — self-ref structs need `*Foo` not `Foo`.
		// Pointer-to-primitive routes through the primitive map.
		if (field.kind === "reference") {
			const inner = ZIG_PRIMITIVES[field.name] ?? typeName(field.name);
			if (field.indirection === "pointer") {
				return `*${inner}`;
			}
			if (field.indirection === "reference") {
				return `*const ${inner}`;
			}
		}
		const scalar = mapScalarField(field, ZIG_PRIMITIVES, typeName);
		if (scalar !== undefined) return scalar;
		return `[${fieldSize}]u8 align(${structAlign})`;
	}

	return {
		name: "zig",
		extension: "zig",
		config: cfg,
		getFileHeader: () => 'const std = @import("std");\n\n',
		generate: (plan: LayoutPlan) => {
			let code = "";
			const deprecatedComment = (
				obsolete?: boolean,
				reason?: string,
				indent = "",
			) =>
				obsolete
					? `${indent}// DEPRECATED${reason ? `: ${reason}` : ""}\n`
					: "";
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ zig: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				const tn = typeName(t.name);
				const tAny = t as any;
				code += deprecatedComment(tAny.obsolete, tAny.obsoleteReason);
				if (t.kind === "struct") {
					code += `pub const ${tn} = extern struct {\n`;
					if (t.fields.length === 0)
						code += `${indent()}_pad: [${t.paddedSize}]u8,\n`;
					let currentBitfieldOffset = -1;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fn = fieldName(f.name);
						const fAny = f as any;
						code += deprecatedComment(
							fAny.obsolete,
							fAny.obsoleteReason,
							indent(),
						);
						if (f.bitSize && f.bitSize < 8) {
							if (currentBitfieldOffset !== f.offset) {
								code += `${indent()}_bitfield_${f.offset}: u8,\n`;
								currentBitfieldOffset = f.offset;
							}
							if (f.paddingAfter > 0)
								code += `${indent()}_pad_${f.offset}: [${f.paddingAfter}]u8,\n`;
						} else {
							const zType = fieldZigType(f.type, f.size, t.align);
							code += `${indent()}${fn}: ${zType},\n`;
							if (f.paddingAfter > 0)
								code += `${indent()}_pad_${fn}: [${f.paddingAfter}]u8,\n`;
						}
					}
					code += `};\n\n`;
				} else if (t.kind === "enum") {
					code += `pub const ${tn} = ${ZIG_PRIMITIVES[t.underlyingType] ?? "u8"};\n`;
					for (const v of t.variants) {
						code += `pub const ${tn}_${v.name}: ${tn} = ${v.value};\n`;
					}
					code += `\n`;
				} else if (t.kind === "union" || t.kind === "alias") {
					code += `pub const ${tn} = extern struct { _bytes: [${t.paddedSize}]u8 align(${t.align}) };\n\n`;
				}
			}
			return code;
		},
		wrapVersion: (version, code) =>
			version
				? wrapNamespace(version, code, {
						open: (mod) => `pub const ${mod} = struct {`,
						close: "};",
					})
				: code,
		...(cfg.harness
			? { getHarness: (plans: LayoutPlan[]) => zigHarness(plans) }
			: {}),
	};

}
