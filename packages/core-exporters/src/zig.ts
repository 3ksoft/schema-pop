import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldChange,
	FieldPlan,
	StructPlan,
	TypeDiff,
} from "schema-pop";
import { diffPlans, ExporterTools } from "schema-pop";
import { zigHarness } from "./zig-harness";

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

export function zig(config: ZigConfig): ExporterPlugin<ZigConfig> {
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
			wrapNamespace(version, code, {
				open: (mod) => `pub const ${mod} = struct {`,
				close: "};",
			}),
		generateMigration: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => {
			const diff = diffPlans(fromPlan, toPlan);
			// Match the namespace identifier emitted by `wrapVersion` —
			// raw versions like `1.0` / `test-schema_2.0` aren't valid Zig
			// identifiers and break `migrate_X_<from>_to_<to>` symbols.
			const fromNs = toSafeVersionIdentifier(fromPlan.version);
			const toNs = toSafeVersionIdentifier(toPlan.version);
			const blocks: string[] = [];
			for (const td of diff.types) {
				const code = renderZigMigration(td, fromNs, toNs);
				if (code) blocks.push(code);
			}
			if (blocks.length === 0) return "";
			return `\n// migrations: ${fromNs} → ${toNs}\n${blocks.join("\n")}`;
		},
		getHarness: cfg.harness ? (plans) => zigHarness(plans) : undefined,
	};

	function zigLiteral(value: unknown): string {
		if (typeof value === "bigint") return `${value}`;
		if (typeof value === "boolean") return value ? "true" : "false";
		if (typeof value === "number") return `${value}`;
		if (typeof value === "string") return JSON.stringify(value);
		return ".{}";
	}

	function languageDefault(field: Field): string {
		if (field.kind === "primitive") {
			const name = (field as any).name;
			if (name === "bool" || name === "boolean") return "false";
			return "0";
		}
		return ".{}";
	}

	function emitFieldExpr(
		change: FieldChange | undefined,
		toField: FieldPlan,
	): string {
		if (change?.kind === "renamed")
			return `src.${fieldName(change.from.name)}`;
		if (change?.kind === "type-widened")
			return `@as(${ZIG_PRIMITIVES[(change.to.type as any).name] ?? "u32"}, src.${fieldName(change.from.name)})`;
		if (change?.kind === "added" && change.default.kind === "literal")
			return zigLiteral(change.default.value);
		if (
			change?.kind === "added" &&
			change.default.kind === "language-default"
		)
			return languageDefault(toField.type);
		if (toField.migrationMeta?.defaultValue !== undefined)
			return zigLiteral(toField.migrationMeta.defaultValue);
		return `src.${fieldName(toField.name)}`;
	}

	function renderZigMigration(
		td: TypeDiff,
		fromNs: string,
		toNs: string,
	): string {
		if (td.kind !== "changed" && td.kind !== "renamed") return "";
		const fromType = (td as any).from;
		const toType = (td as any).to;
		const fnName = `migrate_${typeName(toType.name)}_${fromNs}_to_${toNs}`;
		const argT = `${fromNs}.${typeName(fromType.name)}`;
		const retT = `${toNs}.${typeName(toType.name)}`;
		if (td.status === "user-supplied") {
			let s = `// schema-pop: implement \`pub fn ${fnName}(src: ${argT}) ${retT}\` in your user module\n`;
			const reasons = td.fieldChanges
				.filter((c) => c.status === "user-supplied")
				.map((c) => {
					switch (c.kind) {
						case "type-narrowed":
							return `field '${c.to.name}': narrowing`;
						case "type-changed":
							return `field '${c.to.name}': structural type change`;
						case "added":
							return `field '${c.field.name}': new field with no auto default`;
						case "renamed":
							return `field '${c.to.name}': renamed AND type changed`;
						default:
							return c.kind;
					}
				});
			for (const r of reasons) s += `//   reason: ${r}\n`;
			s += `pub extern fn ${fnName}(src: ${argT}) ${retT};\n`;
			return s;
		}
		if (toType.kind === "struct") {
			const stToType = toType as StructPlan;
			const changeByToName = new Map<string, FieldChange>();
			for (const c of td.fieldChanges) {
				if (c.kind === "added") changeByToName.set(c.field.name, c);
				else if (c.kind === "renamed") changeByToName.set(c.to.name, c);
				else if (
					c.kind === "type-widened" ||
					c.kind === "type-narrowed" ||
					c.kind === "type-changed" ||
					c.kind === "reordered"
				)
					changeByToName.set(c.to.name, c);
			}
			let s = `// status: ${td.status}\n`;
			if (td.kind === "renamed") s += `// renamed from "${td.oldName}"\n`;
			s += `pub fn ${fnName}(src: ${argT}) ${retT} {\n`;
			s += `${indent()}return ${retT}{\n`;
			for (const f of stToType.fields) {
				if (f.type.kind === "unit") continue;
				if (f.bitSize && f.bitSize < 8) continue;
				const ch = changeByToName.get(f.name);
				const expr = emitFieldExpr(ch, f);
				s += `${indent()}${indent()}.${fieldName(f.name)} = ${expr},\n`;
			}
			s += `${indent()}};\n`;
			s += `}\n`;
			return s;
		}
		return (
			`// status: ${td.status}\n` +
			`pub fn ${fnName}(src: ${argT}) ${retT} {\n` +
			`${indent()}return @as(${retT}, @bitCast(src));\n` +
			`}\n`
		);
	}
}
