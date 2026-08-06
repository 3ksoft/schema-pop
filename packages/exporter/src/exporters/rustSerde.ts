import type { BaseConfig, ExporterPlugin } from "../api";
import type { Field, LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface RustSerdeConfig extends Omit<BaseConfig, "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
}

const RUST_PRIMITIVES: Record<string, string> = {
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
	number: "f64",
	bigint: "i64",
};

export function rustSerde(
	config: RustSerdeConfig,
): ExporterPlugin<RustSerdeConfig, string> {
	const cfg: RustSerdeConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		...config,
	};
	const { typeName, fieldName, indent } = ExporterTools(cfg as any);

	function fieldRustType(field: Field): string {
		switch (field.kind) {
			case "primitive":
				return RUST_PRIMITIVES[field.name] ?? "serde_json::Value";
			case "string":
				return "String";
			case "array":
				return `Vec<${fieldRustType(field.item)}>`;
			case "map":
				return `std::collections::HashMap<String, ${fieldRustType(field.value)}>`;
			case "optional":
				return `Option<${fieldRustType(field.inner)}>`;
			case "reference":
				return typeName(field.name);
			case "any":
			case "inlineStruct":
				return "serde_json::Value";
			case "unit":
				return "()";
			default:
				return "serde_json::Value";
		}
	}

	return {
		name: "rust-serde",
		extension: "rs",
		config: cfg,
		getFileHeader: () => `use serde::{Serialize, Deserialize};

`,
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) {
				// In rich mode, we don't need synthetic binary-layout enums
				if ((t as any).synthetic) continue;

				const tn = typeName(t.name);
				const tAny = t as any;
				const obsolete = tAny.obsolete
					? `#[deprecated${tAny.obsoleteReason ? `(note = ${JSON.stringify(tAny.obsoleteReason)})` : ""}]
`
					: "";

				if (t.kind === "struct") {
					code += `${obsolete}#[derive(Debug, Clone, Serialize, Deserialize)]
`;
					code += `pub struct ${tn} {
`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;

						// Skip constant discriminant fields (references to synthetic enums)
						// because Serde handles them via #[serde(tag = "...")] on the union enum
						if (f.type.kind === "reference") {
							const ref = plan.types.find((p) => p.name === (f.type as any).name);
							if (ref && (ref as any).synthetic) continue;
						}

						const fn = fieldName(f.name);
						if (fn !== f.name) {
							code += `${indent()}#[serde(rename = "${f.name}")]
`;
						}
						code += `${indent()}pub ${fn}: ${fieldRustType(f.type)},
`;
					}
					code += `}

`;
				} else if (t.kind === "enum") {
					code += `${obsolete}#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
`;
					code += `pub enum ${tn} {
`;
					for (const v of t.variants) {
						const vn = typeName(v.name);
						if (vn !== v.name) {
							code += `${indent()}#[serde(rename = "${v.name}")]
`;
						}
						code += `${indent()}${vn},
`;
					}
					code += `}

`;
				} else if (t.kind === "union") {
					code += `${obsolete}#[derive(Debug, Clone, Serialize, Deserialize)]
`;
					if (t.discriminant) {
						code += `#[serde(tag = "${t.discriminant}")]
`;
					} else {
						code += `#[serde(untagged)]
`;
					}
					code += `pub enum ${tn} {
`;
					for (const v of t.variants) {
						const vn = typeName(v.name);
						if (vn !== v.name) {
							code += `${indent()}#[serde(rename = "${v.name}")]
`;
						}
						if (v.type.kind === "unit") {
							code += `${indent()}${vn},
`;
						} else {
							code += `${indent()}${vn}(${fieldRustType(v.type)}),
`;
						}
					}
					code += `}

`;
				} else if (t.kind === "alias") {
					code += `${obsolete}pub type ${tn} = ${fieldRustType(t.type)};

`;
				}
			}
			return code;
		},
	};
}
