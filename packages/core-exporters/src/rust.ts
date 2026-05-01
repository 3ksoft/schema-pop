import type { LayoutPlan, BaseConfig, ExporterPlugin, Field } from "schema-pop";
import { ExporterTools } from "schema-pop";
import { rustHarness } from "./rust-harness";

export interface RustConfig extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
	commentStyle?: "slash";
	namespace?: string;
	traits?: string[];
	harness?: boolean;
}

const RUST_PRIMITIVES: Record<string, string> = {
	u8: "u8", i8: "i8",
	u16: "u16", i16: "i16",
	u32: "u32", i32: "i32",
	u64: "u64", i64: "i64",
	u128: "u128", i128: "i128",
	f32: "f32", f64: "f64",
	bool: "bool", boolean: "bool",
};

export function rust(config: RustConfig): ExporterPlugin<RustConfig> {
	const cfg: RustConfig = { fieldNaming: "snake_case", typeNaming: "PascalCase", commentStyle: "slash", ...config };
	const { typeName, fieldName, INDENT, mapScalarField, wrapNamespace } = ExporterTools(cfg);

	function fieldRustType(field: Field, fieldSize: number): string {
		const scalar = mapScalarField(field, RUST_PRIMITIVES, typeName);
		if (scalar !== undefined) return scalar;
		return `[u8; ${fieldSize}]`;
	}

	return {
		name: "rust",
		config: cfg,
		getFileHeader: () => "#![allow(dead_code, unused_imports, non_camel_case_types, non_snake_case)]\n\n",
		generate: (plan: LayoutPlan) => {
			let code = "";
			const deprecatedAttr = (obsolete?: boolean, reason?: string) =>
				obsolete ? (reason ? `#[deprecated(note = ${JSON.stringify(reason)})]\n` : `#[deprecated]\n`) : "";
			for (const t of plan.types) {
				const tn = typeName(t.name);
				const tAny = t as any;
				const typeDeprecate = deprecatedAttr(tAny.obsolete, tAny.obsoleteReason);
				if (t.kind === "struct") {
					code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} {\n`;
					if (t.fields.length === 0) code += `${INDENT()}pub _pad: [u8; ${t.paddedSize}],\n`;
					let currentBitfieldOffset = -1;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fAny = f as any;
						const fieldDeprecate = deprecatedAttr(fAny.obsolete, fAny.obsoleteReason);
						if (f.bitSize && f.bitSize < 8) {
							if (currentBitfieldOffset !== f.offset) {
								code += `${INDENT()}pub _bitfield_${f.offset}: u8,\n`;
								currentBitfieldOffset = f.offset;
							}
							if (f.paddingAfter > 0) code += `${INDENT()}pub _pad_${f.offset}: [u8; ${f.paddingAfter}],\n`;
						} else {
							const rType = fieldRustType(f.type, f.size);
							const fn = fieldName(f.name);
							if (fieldDeprecate) code += `${INDENT()}${fieldDeprecate.trimEnd()}\n`;
							code += `${INDENT()}pub ${fn}: ${rType},\n`;
							if (f.paddingAfter > 0) code += `${INDENT()}pub _pad_${fn}: [u8; ${f.paddingAfter}],\n`;
						}
					}
					code += `}\n\n`;
				} else if (t.kind === "enum") {
					code += `${typeDeprecate}pub type ${tn} = ${t.underlyingType};\n`;
					for (const v of t.variants) {
						const constName = `${tn}_${v.name}`
							.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
							.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
							.replace(/[-\s]+/g, "_")
							.toUpperCase();
						code += `pub const ${constName}: ${tn} = ${v.value};\n`;
					}
					code += `\n`;
				} else if (t.kind === "union" || t.kind === "alias") {
					code += `${typeDeprecate}#[repr(C, align(${t.align}))]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct ${tn} { pub _bytes: [u8; ${t.paddedSize}] }\n\n`;
				}
			}
			return code;
		},
		wrapVersion: (version, code) => wrapNamespace(version, code, {
			open: (mod) => `pub mod ${mod} {\n\tuse super::*;`,
			close: "}",
		}),
		getHarness: cfg.harness ? (plans) => rustHarness(plans) : undefined,
	};
}
