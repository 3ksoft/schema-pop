import type { ExtractionContext } from "@schema-pop/schema";
import {
	EnumPlan,
	Field,
	FieldPlan,
	LayoutPlan,
	PopSchema,
	PopType,
	StructPlan,
	TypePlan,
	UnionPlan,
	VariantPlan,
} from "@schema-pop/schema";
import { type } from "arktype";
import { getBuiltinPrimitive } from "./PrimitiveRegistry";
import { LayoutCalculator } from "./LayoutCalculator";
import { MigrationEngine, MigrationPlan } from "./MigrationEngine";

export { MigrationPlan };

export const AnalyzerConfig = type({
	wordSize: "'32' | '64' = '32'",
	autoLayout: "boolean = true",
	layoutType:
		"'aligned' | 'zero-padding' | 'std140' | 'std430' | 'dynamic' | 'dbus' = 'aligned'",
	mode: "'binary' | 'rich' = 'rich'",
});
export type AnalyzerConfig = typeof AnalyzerConfig.infer;

export class SchemaAnalyzer {
	private schema: PopSchema;
	private scopeNames: string[];
	private resolvedPlans = new Map<string, TypePlan>();
	private visiting = new Set<string>();
	private errors: string[] = [];
	private warnings: string[] = [];
	private config: AnalyzerConfig;
	private synthEnumsByHash = new Map<string, EnumPlan>();
	private synthEnumNames = new Set<string>();
	private calculator: LayoutCalculator;

	constructor(input: PopSchema | ExtractionContext, config?: AnalyzerConfig) {
		const schema = Object.hasOwn(input, "schema")
			? (input as any).schema
			: input;
		this.config = {
			wordSize: "64",
			autoLayout: true,
			layoutType: "aligned",
			mode: schema.mode ?? "binary",
			...config,
		};
		this.schema = schema;
		this.scopeNames = Object.keys(schema.types);
		this.calculator = new LayoutCalculator(
			this.config,
			(name) => this.getPlan(name),
			(msg) => this.error(msg)
		);
	}

	public analyze(version: string, endian: "le" | "be" = "le"): LayoutPlan {
		const names = this.scopeNames.filter(
			(n) => !getBuiltinPrimitive(n) && n !== "Binary" && n !== "Describe",
		);

		for (const name of names) {
			this.getPlan(name);
		}

		const sorted: TypePlan[] = [];
		const visited = new Set<string>();

		const visit = (name: string) => {
			if (visited.has(name)) return;
			visited.add(name);
			const plan = this.resolvedPlans.get(name);
			if (plan) {
				const deps = new Set<string>();
				const addDeps = (field: Field) => {
					if (field.kind === "reference") deps.add(field.name);
					else if (field.kind === "array") addDeps(field.item);
					else if (field.kind === "optional") addDeps(field.inner);
					else if (field.kind === "map") addDeps(field.value);
				};
				if (plan.kind === "struct") plan.fields.forEach((f) => addDeps(f.type));
				else if (plan.kind === "union")
					plan.variants.forEach((v) => addDeps(v.type));
				else if (plan.kind === "alias") addDeps(plan.type);
				for (const dep of deps) visit(dep);
				sorted.push(plan);
			}
		};

		for (const name of names) visit(name);

		for (const synth of this.synthEnumsByHash.values()) {
			if (!visited.has(synth.name)) {
				sorted.unshift(synth);
				visited.add(synth.name);
			}
		}

		if (this.errors.length > 0) {
			throw new Error(
				`Schema analysis failed with ${this.errors.length} errors:\n` +
					this.errors.map((e) => `  - ${e}`).join("\n"),
			);
		}

		return {
			version,
			endian,
			autoLayout: !!this.config.autoLayout,
			wordSize: this.config.wordSize,
			types: sorted,
		};
	}

	private error(msg: string) {
		this.errors.push(msg);
	}

	private warning(msg: string) {
		this.warnings.push(msg);
	}

	private toPascal(s: string): string {
		return s
			.replace(/(^|[_\s-])(\w)/g, (_, __, c) => c.toUpperCase())
			.replace(/[^a-zA-Z0-9]/g, "");
	}

	private synthesizeEnum(values: string[], hint: string): string {
		const sorted = [...values].sort();
		const hash = sorted.join("|");
		const cached = this.synthEnumsByHash.get(hash);
		if (cached) return cached.name;

		let name = this.toPascal(hint);
		if (!name) name = "AnonEnum";
		let unique = name;
		let n = 1;
		while (
			this.synthEnumNames.has(unique) ||
			this.scopeNames.includes(unique)
		) {
			unique = `${name}${++n}`;
		}

		const size = values.length <= 256 ? 1 : values.length <= 65536 ? 2 : 4;
		const underlyingType: "u8" | "u16" | "i32" =
			size === 1 ? "u8" : size === 2 ? "u16" : "i32";
		const plan: EnumPlan = {
			kind: "enum",
			name: unique,
			size,
			align: size,
			paddedSize: size,
			variants: values.map((v, i) => ({ name: v, value: i, description: "" })),
			underlyingType,
			syntetic: true,
		};
		this.synthEnumsByHash.set(hash, plan);
		this.synthEnumNames.add(unique);
		this.resolvedPlans.set(unique, plan);
		return unique;
	}

	public getErrors() {
		return this.errors;
	}

	public getWarnings() {
		return this.warnings;
	}

	private assertField(field: unknown): Field {
		const valid = Field(field);
		if (valid instanceof type.errors) {
			for (const e of Object.values(valid.entries)) {
				this.error(e.message);
			}
			return { kind: "unit" };
		}
		return valid;
	}

	private getPlan(name: string): TypePlan {
		if (this.resolvedPlans.has(name)) return this.resolvedPlans.get(name)!;

		if (this.visiting.has(name)) {
			if (this.config.mode === "rich") {
				return {
					kind: "alias",
					name,
					size: 0,
					align: 1,
					paddedSize: 0,
					type: {
						kind: "reference",
						name,
						indirection: "inline",
						isForward: true,
					},
				};
			}
			this.error(`Cyclic dependency detected for ${name}`);
			return {
				kind: "alias",
				name,
				size: 0,
				align: 1,
				paddedSize: 0,
				type: { kind: "unit" },
			};
		}
		this.visiting.add(name);

		const rawEntry = this.schema.types[name];
		if (!rawEntry) {
			this.error(`Cannot resolve type ${name}`);
			return {
				kind: "alias",
				name,
				size: 0,
				align: 1,
				paddedSize: 0,
				type: { kind: "unit" },
			};
		}
		if (typeof rawEntry === "string") {
			this.warning(
				`Type ${name} is a string literal, expected a type definition.`,
			);
			return {
				kind: "alias",
				name,
				size: 0,
				align: 0,
				paddedSize: 0,
				type: { kind: "unit" },
			};
		}

		const plan = this.analyzeTopLevel(name, rawEntry);

		this.resolvedPlans.set(name, plan);
		this.visiting.delete(name);
		return plan;
	}

	public static analyzeMigration(
		planFrom: LayoutPlan,
		planTo: LayoutPlan,
	): MigrationPlan[] {
		return MigrationEngine.analyzeMigration(planFrom, planTo);
	}

	private analyzeTopLevel(name: string, typeDef: PopType): TypePlan {
		const description = typeDef.description ?? "";
		const obsolete = typeDef.obsolete;
		const obsoleteReason = typeDef.obsoleteReason;
		const renamedFrom = typeDef.renamedFrom;
		const migrationMetaSpread = renamedFrom
			? { migrationMeta: { renamedFrom } }
			: {};

		if (typeDef.type === "union" || typeDef.type === "enum") {
			const plan = this.analyzeUnion(name, typeDef);
			plan.description = description;
			if (obsolete) {
				plan.obsolete = true;
				if (obsoleteReason) plan.obsoleteReason = obsoleteReason;
			}
			if (renamedFrom) plan.migrationMeta = { renamedFrom };
			return plan;
		}

		if (typeDef.type === "object") {
			const plan = this.analyzeStruct(name, typeDef);
			plan.description = description;
			if (obsolete) {
				plan.obsolete = true;
				if (obsoleteReason) plan.obsoleteReason = obsoleteReason;
			}
			if (renamedFrom) plan.migrationMeta = { renamedFrom };
			return plan;
		}

		const field = this.resolveFieldType(typeDef, name);
		const layout = this.calculator.getLayout(field);
		return {
			kind: "alias",
			name,
			...layout,
			type: field,
			...(description ? { description } : {}),
			...(obsolete
				? { obsolete: true, ...(obsoleteReason ? { obsoleteReason } : {}) }
				: {}),
			...migrationMetaSpread,
		};
	}

	private analyzeStruct(
		name: string,
		typeDef: PopType & { type: "object" },
	): StructPlan {
		const fields = this.analyzeFields(typeDef.fields || {}, name);
		let structSize = 0;
		let structAlign = 1;

		if (fields.length > 0) {
			const last = fields[fields.length - 1]!
			structSize = last.offset + last.size + last.paddingAfter
			structAlign = fields.reduce(
				(max, f) => Math.max(max, this.calculator.getLayout(f.type).align),
				1,
			)
		} else {
			structSize = 1
			structAlign = 1
		}

		if (this.config.layoutType === "std140") {
			structAlign = Math.max(structAlign, 16);
		}

		const paddedSize = Math.ceil(structSize / structAlign) * structAlign;
		return {
			kind: "struct",
			name,
			size: paddedSize,
			align: structAlign,
			paddedSize,
			fields,
		};
	}

	private analyzeFields(
		fieldsDict: Record<string, PopType>,
		parentName?: string,
	): FieldPlan[] {
		const entries = Object.entries(fieldsDict || {});
		const propsWithMeta = entries.map(([key, fieldType], i) => {
			const hint = parentName ? `${parentName}_${key}` : key;
			let type = this.resolveFieldType(fieldType, undefined, hint);

			const hasDefault = fieldType.default !== undefined;
			if (fieldType.required === false && !hasDefault) {
				type = { kind: "optional", inner: type };
			}
			const layout = this.calculator.getLayout(type);
			return {
				key,
				originalIndex: i,
				type,
				align: layout.align,
				size: layout.size,
				paddedSize: layout.paddedSize,
				defaultValue: hasDefault ? fieldType.default : undefined,
				hasDefault,
				fieldType,
			};
		});

		if (this.config.autoLayout) {
			propsWithMeta.sort(
				(a, b) => b.align - a.align || a.originalIndex - b.originalIndex,
			);
		}

		const fields: FieldPlan[] = [];
		let currentOffset = 0;
		let currentBitOffset = 0;

		for (const meta of propsWithMeta) {
			const type = meta.type as any;
			const isBitwise =
				type.kind === "primitive" &&
				type.bitSize !== undefined &&
				type.bitSize < 8;
			const bitSize = isBitwise ? type.bitSize : meta.size * 8;

			const fieldDesc = meta.fieldType.description;
			const fieldObsolete = meta.fieldType.obsolete === true ? true : undefined;
			const fieldObsoleteReason = meta.fieldType.obsoleteReason;
			const fieldRenamedFrom = meta.fieldType.renamedFrom;

			const migrationMeta: { renamedFrom?: string; defaultValue?: unknown } =
				{};
			if (fieldRenamedFrom) migrationMeta.renamedFrom = fieldRenamedFrom;
			if (meta.hasDefault) migrationMeta.defaultValue = meta.defaultValue;
			const migrationMetaSpread =
				Object.keys(migrationMeta).length > 0 ? { migrationMeta } : {};

			if (isBitwise) {
				if (currentBitOffset + bitSize > 8) {
					currentOffset += 1;
					currentBitOffset = 0;
				}
				fields.push({
					name: meta.key,
					type: meta.type,
					offset: currentOffset,
					bitOffset: currentBitOffset,
					bitSize: bitSize,
					size: 1,
					paddingAfter: 0,
					...(fieldDesc ? { description: fieldDesc } : {}),
					...(fieldObsolete ? { obsolete: true } : {}),
					...(fieldObsoleteReason
						? { obsoleteReason: fieldObsoleteReason }
						: {}),
					...migrationMetaSpread,
				});
				currentBitOffset += bitSize;
			} else {
				if (currentBitOffset > 0) {
					currentOffset += 1;
					currentBitOffset = 0;
				}
				const paddingBefore =
					(meta.align - (currentOffset % meta.align)) % meta.align;
				currentOffset += paddingBefore;

				fields.push({
					name: meta.key,
					type: meta.type,
					offset: currentOffset,
					bitOffset: 0,
					bitSize: meta.size * 8,
					size: meta.size,
					paddingAfter: 0,
					...(fieldDesc ? { description: fieldDesc } : {}),
					...(fieldObsolete ? { obsolete: true } : {}),
					...(fieldObsoleteReason
						? { obsoleteReason: fieldObsoleteReason }
						: {}),
					...migrationMetaSpread,
				});
				currentOffset += meta.paddedSize;
			}
		}
		if (currentBitOffset > 0) currentOffset += 1;

		const structAlign = fields.reduce(
			(max, f) => Math.max(max, this.calculator.getLayout(f.type).align),
			1,
		);
		const finalAlign =
			this.config.layoutType === "std140"
				? Math.max(structAlign, 16)
				: this.config.layoutType === "dbus"
					? 8
					: structAlign;

		for (let i = 0; i < fields.length; i++) {
			const f = fields[i]!;
			const fieldLayout = this.calculator.getLayout(f.type);
			let nextOffset = Math.ceil(currentOffset / finalAlign) * finalAlign;

			if (f.size === 0 && f.bitSize === 0) {
				f.paddingAfter = 0;
				continue;
			}

			if (f.bitSize > 0 && f.bitSize < 8) {
				let j = i + 1;
				while (j < fields.length && fields[j]!.offset === f.offset) j++;
				nextOffset =
					j < fields.length
						? fields[j]!.offset
						: Math.ceil(currentOffset / finalAlign) * finalAlign;

				if (j === i + 1) {
					f.paddingAfter = nextOffset - (f.offset + 1);
				} else {
					f.paddingAfter = 0;
				}
			} else {
				nextOffset = i < fields.length - 1 ? fields[i + 1]!.offset : nextOffset;
				f.paddingAfter = nextOffset - (f.offset + fieldLayout.paddedSize);
			}
		}

		return fields;
	}

	private analyzeUnion(
		name: string,
		typeDef: PopType & { type: "union" | "enum" },
	): UnionPlan | EnumPlan {
		if (typeDef.type === "enum") {
			const variants = (typeDef.options || []).map((opt: any, i: number) => {
				if (typeof opt === "string")
					return { name: opt, value: i, description: "" };
				return {
					name: opt.label,
					value: typeof opt.value === "number" ? opt.value : i,
					description: "",
				};
			});
			const size =
				variants.length <= 256 ? 1 : variants.length <= 65536 ? 2 : 4;
			const underlyingType = size === 1 ? "u8" : size === 2 ? "u16" : "i32";
			return {
				kind: "enum",
				name,
				size,
				align: size,
				paddedSize: size,
				variants,
				underlyingType,
			};
		}

		const discName = (typeDef as any).discriminant || "kind";
		const variants: VariantPlan[] = (typeDef.variants || []).map(
			(branch: PopType, i: number) => {
				let vName = branch.label;
				if (!vName) {
					if (branch.type === "link") vName = branch.target;
					else if (branch.type === "object" && branch.typeString)
						vName = branch.typeString;
					else vName = `Variant${i + 1}`;
				}
				vName = vName.replace(/[^a-zA-Z0-9_]/g, "");
				const renamedFrom = branch.renamedFrom;
				return {
					name: vName,
					type: this.resolveFieldType(branch, undefined, `${name}_${vName}`),
					...(renamedFrom ? { migrationMeta: { renamedFrom } } : {}),
				};
			},
		);

		variants.sort((a, b) => a.name.localeCompare(b.name));

		const tagMapping: Record<string, number> = {};
		variants.forEach((v, i) => {
			tagMapping[v.name] = i;
		});

		const tagSize = variants.length <= 256 ? 1 : variants.length <= 65536 ? 2 : 4;
		const tagType: "u8" | "u16" | "u32" = tagSize === 1 ? "u8" : tagSize === 2 ? "u16" : "u32";

		const payloadAlign = variants.reduce(
			(max, v) =>
				Math.max(
					max,
					v.type.kind !== "unit" ? this.calculator.getLayout(v.type).align : 1,
				),
			1,
		);
		const payloadSize = variants.reduce(
			(max, v) =>
				Math.max(
					max,
					v.type.kind !== "unit" ? this.calculator.getLayout(v.type).paddedSize : 0,
				),
			0,
		);

		const payloadOffset = Math.ceil(tagSize / payloadAlign) * payloadAlign;
		const unionAlign = Math.max(payloadAlign, tagSize);
		const totalSize = payloadOffset + payloadSize;
		const paddedSize = Math.ceil(totalSize / unionAlign) * unionAlign;

		return {
			kind: "union",
			name,
			size: paddedSize,
			align: unionAlign,
			paddedSize,
			tagOffset: 0,
			tagSize,
			tagType,
			discriminant: discName,
			tagMapping,
			variants,
		};
	}

	private resolveFieldType(
		type: PopType,
		currentTypeName?: string,
		pathHint?: string,
	): Field {
		const richAllowed = this.config.mode === "rich";

		if (type.type === "symbol") {
			const val = String(type.value);
			const synthName = this.synthesizeEnum([val], pathHint || "Constant");
			return this.assertField({
				kind: "reference",
				name: synthName,
				indirection: "inline",
				isForward: false,
			});
		}

		if (type.type === "link") {
			const builtin = getBuiltinPrimitive(type.target);
			if (builtin) return builtin;
			return this.assertField({
				kind: "reference",
				name: type.target,
				indirection: "inline",
				isForward: false,
			});
		}

		if (type.popKind === "binary" || type.popKind === "bitwise") {
			const size = type.size || 0;
			const align = type.align || 1;
			const bitSize = type.popKind === "bitwise" ? size : size * 8;
			const paddedSize =
				Math.ceil((type.popKind === "bitwise" ? 1 : size) / align) * align;
			return this.assertField({
				kind: "primitive",
				name: type.binaryType || type.type,
				size: type.popKind === "bitwise" ? 1 : size,
				align: type.popKind === "bitwise" ? 1 : align,
				paddedSize: type.popKind === "bitwise" ? 1 : paddedSize,
				bitSize,
				popKind: type.popKind,
			});
		}

		if (type.type === "string") {
			const nField: Record<string, any> = {
				kind: "string",
			};
			if (type.exactLength) nField.exactLength = type.exactLength;
			if (type.maxLength) nField.maxLength = type.maxLength;
			return this.assertField(nField);
		}

		if (type.type === "array") {
			const nField = {
				kind: "array",
				item: this.resolveFieldType(
					type.item,
					undefined,
					pathHint ? `${pathHint}Item` : undefined,
				),
			} as any;
			if (type.exactLength) nField.exactLength = type.exactLength;
			if (nField.maxLength) nField.maxLength = type.maxLength;
			return this.assertField(nField);
		}

		if (type.type === "object") {
			if (!type.fields || Object.keys(type.fields).length === 0) {
				if (type.additionalProperties) {
					if (!richAllowed)
						this.error(
							`Record/Map is rich-tier — set mode: 'rich' on the version config to allow it`,
						);
					return this.assertField({
						kind: "map",
						keyKind: "string",
						value: { kind: "any" },
					});
				}
				return this.assertField({ kind: "unit" });
			}

			const fields = this.analyzeFields(type.fields, currentTypeName);
			let structSize = 0;
			let structAlign = 1;
			if (fields.length > 0) {
				const last = fields[fields.length - 1]!;
				structSize = last.offset + last.size + last.paddingAfter;
				structAlign = fields.reduce(
					(max, f) => Math.max(max, this.calculator.getLayout(f.type).align),
					1,
				);
			} else {
				structSize = 1;
				structAlign = 1;
			}
			if (this.config.layoutType === "std140")
				structAlign = Math.max(structAlign, 16);

			const paddedSize = Math.ceil(structSize / structAlign) * structAlign;

			return this.assertField({
				kind: "inlineStruct",
				fields,
				size: paddedSize,
				align: structAlign,
				paddedSize,
			});
		}

		if (type.type === "enum") {
			const values = (type.options || []).map((o: any) =>
				typeof o === "string" ? o : o.value.toString(),
			);
			const synthName = this.synthesizeEnum(values, pathHint || "AnonEnum");
			return this.assertField({
				kind: "reference",
				name: synthName,
				indirection: "inline",
				isForward: false,
			});
		}

		if (type.type === "union") {
			if (!richAllowed)
				this.error(
					`union not classifiable as enum/discriminated — set mode: 'rich'`,
				);
			return this.assertField({ kind: "any" });
		}

		if (type.type === "any") {
			if (!richAllowed)
				this.error(
					`unknown / any type is rich-tier — set mode: 'rich' to allow it`,
				);
			return this.assertField({ kind: "any" });
		}

		if (type.type === "number" || type.type === "boolean" || type.type === "bigint") {
			if (!richAllowed) {
				this.error(
					`unbounded ${type.type} is rich-tier — add a constraint or set mode: 'rich'`,
				);
			}
			return this.assertField({
				kind: "primitive",
				name: type.type,
				size: 0,
				align: 1,
				paddedSize: 0,
				popKind: "rich",
			});
		}

		if (richAllowed) {
			return this.assertField({ kind: "any" });
		}

		this.warning(`Unable to resolve field type: ${type.type}`);
		return this.assertField({
			kind: "primitive",
			name: "unknown",
			size: 0,
			align: 1,
			paddedSize: 0,
		});
	}
}
