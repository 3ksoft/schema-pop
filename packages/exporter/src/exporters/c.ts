import type {
	ExporterPlugin,
	Field,
	FieldPlan,
	LayoutPlan,
	StructPlan,
	BaseConfig,
} from "@schema-pop/schema";
import { ExporterTools, toSnakeCase } from "../exporterTools";

export interface CConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
	commentStyle?: "star";
	prefix?: string;
	/**
	 * Controls the per-version prefix on every typedef and `#define`.
	 *  - `undefined` (default): prefix with the safe version identifier
	 *    (e.g. `konektor_1_0_BleMode`). Required when multiple versions
	 *    of the same schema land in one header.
	 *  - `false`: drop the prefix. Single-version schemas get the
	 *    natural `BleMode` / `BLE_MODE_OFF` names. Mirrors the Rust
	 *    exporter's `versionNamespace: false` opt-out — see P13.
	 *  - `string`: use the given prefix verbatim (e.g. `"ws"` →
	 *    `ws_BleMode`).
	 */
	versionNamespace?: false | string;
	/**
	 * If `true` (default), fields whose `Field.originalType` is set are
	 * emitted with the original C spelling instead of falling back to a
	 * `uint8_t name[size]` byte blob. The original spelling comes from
	 * an importer (clang_importer / treesitter_importer) which couldn't
	 * resolve the source type into a schema-pop shape — but the
	 * spelling itself is valid C, so we use it verbatim and the output
	 * compiles against the original headers.
	 *
	 * Tradeoff: such fields are no longer round-trippable through
	 * schema-pop's binary codec — the codec doesn't know the layout.
	 * Acceptable when the C output is consumed as a header bridge
	 * rather than serialised. Set to `false` to fall back to byte
	 * blobs and keep wire-format compatibility.
	 */
	useOriginalType?: boolean;
}

const C_PRIMITIVES: Record<string, string> = {
	u8: "uint8_t",
	i8: "int8_t",
	u16: "uint16_t",
	i16: "int16_t",
	u32: "uint32_t",
	i32: "int32_t",
	u64: "uint64_t",
	i64: "int64_t",
	f32: "float",
	f64: "double",
	bool: "bool",
	boolean: "bool",
};

export function c(config: CConfig): ExporterPlugin<CConfig> {
	const cfg: CConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "star",
		...config,
	};
	const {
		typeName,
		fieldName,
		indent,
		mapScalarField,
		isRichType,
		toSafeVersionIdentifier,
	} = ExporterTools(cfg);
	return {
		name: "c",
		extension: "h",
		config: cfg,
		getFileHeader: () =>
			"#pragma once\n#include <stdint.h>\n#include <stdbool.h>\n\n",
		generate: (plan: LayoutPlan) => {
			let code = "";
			const mod =
				cfg.versionNamespace === "false" || cfg.versionNamespace === false
					? ""
					: typeof cfg.versionNamespace === "string"
						? cfg.versionNamespace
						: toSafeVersionIdentifier(plan.version);
			const join = (a: string, b: string) => (a ? `${a}_${b}` : b);
			const refName = (n: string) => join(mod, typeName(n));

			function fieldCType(
				field: Field,
				fieldSize: number,
			): { type: string; suffix?: string } {
				if (field.kind === "reference" && field.indirection === "pointer") {
					const inner = C_PRIMITIVES[field.name] ?? refName(field.name);
					return { type: `${inner}*` };
				}
				const scalar = mapScalarField(field, C_PRIMITIVES, refName);
				if (scalar !== undefined) return { type: scalar };
				if (
					cfg.useOriginalType !== false &&
					field.kind === "any" &&
					typeof field.originalType === "string" &&
					field.originalType.length > 0
				) {
					const arrMatch = field.originalType.match(/^(.+?)(\[\d+\].*)$/);
					if (arrMatch) return { type: arrMatch[1]!, suffix: arrMatch[2] };
					return { type: field.originalType };
				}
				return { type: "uint8_t", suffix: `[${fieldSize}]` };
			}

			const richOpts = { allowOriginalType: cfg.useOriginalType !== false };
			for (const t of plan.types) {
				if (isRichType(t, richOpts)) {
					console.warn(
						`  ⚠ c: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}

				// Enums: `typedef uint8_t Foo;` + one `#define FOO_BAR ((Foo)N)`
				// per variant (SCREAMING_SNAKE of type name + variant name).
				if (t.kind === "enum") {
					const C_INT: Record<string, string> = {
						u8: "uint8_t", i8: "int8_t", u16: "uint16_t", i16: "int16_t",
						u32: "uint32_t", i32: "int32_t", u64: "uint64_t", i64: "int64_t",
					};
					const scream = (n: string) => toSnakeCase(n).toUpperCase();
					const tn = refName(t.name);
					const ut = (t as any).underlyingType as string | undefined;
					code += `typedef ${C_INT[ut ?? "u8"] ?? "uint8_t"} ${tn};\n`;
					for (const v of (t as any).variants ?? []) {
						code += `#define ${scream(tn)}_${scream(v.name)} ((${tn})${v.value})\n`;
					}
					code += `\n`;
					continue;
				}

				const sn = refName(t.name);
				const fields = (t as StructPlan).fields;
				if (fields === undefined || fields.length === 0) {
					code += `typedef struct ${sn} {\n`;
					code += `${indent()}uint8_t unit;\n`;
					code += `${indent()}} ${sn};\n`;
					code += `\n`;
					continue;
				}

				code += `typedef struct ${sn} {\n`;
				for (const field of fields) {
					const ft = fieldCType(field.type, field.size);
					code += `${indent()}${ft.type} ${fieldName(field.name)}${ft.suffix || ""};\n`;
				}
				code += `${indent()}} ${sn};\n`;
				code += `\n`;
			}

			return code;
		},
	};
}
