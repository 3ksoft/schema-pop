import type { ArkMeta, ExtractionContext } from "@schema-pop/schema";
import {
	EnumPlan,
	Field,
	FieldPlan,
	LayoutPlan,
	PopSchema,
	PopSchemaSettings,
	PopType,
	StructPlan,
	TypeLayout,
	TypePlan,
	UnionPlan,
	VariantPlan,
} from "@schema-pop/schema";
import { type } from "arktype";

interface TagContext {
	name: string; // np. "kin"
	enumName: string; // np. "PepsTag"
}

export interface MigrationPlan {
	typeName: string;
	kind: "struct" | "enum" | "union" | "alias";
	fields: {
		targetName: string;
		sourceName: string | null;
		targetType: Field;
		sourceType: Field | null;
	}[];
	variants: {
		targetName: string;
		sourceName: string | null;
		targetType?: Field;
		sourceType?: Field | null;
	}[];
}

export const AnalyzerConfig = type({
	wordSize: "'32' | '64' = '32'",
	autoLayout: "boolean = true",
	autoSort: "boolean = false",
	autoPack: "boolean = false",
	layoutType:
		"'aligned' | 'zero-padding' | 'std140' | 'std430' | 'dynamic' | 'dbus' = 'aligned'",
	mode: "'binary' | 'rich' = 'rich'",
});
export type AnalyzerConfig = typeof AnalyzerConfig.infer;

export class SchemaAnalyzer {
	private schema!: PopSchema;
	private scopeNames!: string[];
	private config!: PopSchemaSettings;
	private resolvedPlans = new Map<string, TypePlan>();
	private visiting = new Set<string>();
	private errors: string[] = [];
	private warnings: string[] = [];
	private synthEnumsByHash = new Map<string, EnumPlan>();
	private synthEnumNames = new Set<string>();

	public analyze(
		schema: PopSchema | ExtractionContext,
		settings?: PopSchemaSettings,
	): LayoutPlan {
		this.config = settings ?? PopSchemaSettings.assert({});
		this.schema = Object.hasOwn(schema, "schema")
			? (schema as any).schema
			: schema;
		this.scopeNames = Object.keys(this.schema.types);
		const names = this.scopeNames.filter(
			(n) => !this.getBuiltinPrimitive(n) && n !== "Binary" && n !== "Describe",
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

		return LayoutPlan.assert({
			...settings,
			types: sorted,
		});
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

	private getBuiltinPrimitive(oName: string): Field | undefined {
		const name =
			oName === "number"
				? "f64"
				: oName === "bigint"
					? "i64"
					: oName === "boolean"
						? "bool"
						: oName;
		if (name === "bool")
			return {
				kind: "primitive",
				name: "bool",
				size: 1,
				align: 1,
				paddedSize: 1,
				bitSize: 1,
				unsigned: true,
				popKind: "bitwise",
			};
		const match = name.match(/^([ui])(\d+)$/);
		if (match) {
			const bits = parseInt(match[2]!, 10);
			if (bits < 8) {
				return {
					kind: "primitive",
					name,
					size: 1,
					align: 1,
					paddedSize: 1,
					bitSize: bits,
					unsigned: name.startsWith("u"),
					isFloat: false,
					popKind: "bitwise",
				};
			}
			if ([8, 16, 32, 64, 128].includes(bits)) {
				const bytes = bits / 8;
				return {
					kind: "primitive",
					name,
					size: bytes,
					align: bytes,
					paddedSize: bytes,
					bitSize: bits,
					unsigned: name.startsWith("u"),
					isFloat: false,
					popKind: "binary",
				};
			}
		}
		const fMatch = name.match(/^f(32|64)$/);
		if (fMatch) {
			const bytes = parseInt(fMatch[1]!, 10) / 8;
			return {
				kind: "primitive",
				name,
				size: bytes,
				align: bytes,
				paddedSize: bytes,
				bitSize: bytes * 8,
				unsigned: false,
				isFloat: true,
				popKind: "binary",
			};
		}
		return undefined;
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
		const migrations: MigrationPlan[] = [];
		for (const toType of planTo.types) {
			if (toType.kind === "alias") continue;
			const fromType = planFrom.types.find((t) => t.name === toType.name);
			if (!fromType || fromType.kind !== toType.kind) continue;

			if (toType.kind === "struct") {
				const fFrom = fromType as StructPlan;
				const fields: MigrationPlan["fields"] = toType.fields.map((tf) => {
					const sf = fFrom.fields.find((f) => f.name === tf.name);
					return {
						targetName: tf.name,
						sourceName: sf ? sf.name : null,
						targetType: tf.type,
						sourceType: sf ? sf.type : null,
					};
				});
				migrations.push({
					typeName: toType.name,
					kind: "struct",
					fields,
					variants: [],
				});
			} else if (toType.kind === "enum") {
				const fFrom = fromType as EnumPlan;
				const variants: MigrationPlan["variants"] = toType.variants.map(
					(tv) => {
						const sv = fFrom.variants.find((v) => v.name === tv.name);
						return {
							targetName: tv.name,
							sourceName: sv ? sv.name : null,
						};
					},
				);
				migrations.push({
					typeName: toType.name,
					kind: "enum",
					fields: [],
					variants,
				});
			} else if (toType.kind === "union") {
				const fFrom = fromType as UnionPlan;
				const variants: MigrationPlan["variants"] = toType.variants.map(
					(tv) => {
						const sv = fFrom.variants.find((v) => v.name === tv.name);
						return {
							targetName: tv.name,
							sourceName: sv ? sv.name : null,
							targetType: tv.type,
							sourceType: sv ? sv.type : null,
						};
					},
				);
				migrations.push({
					typeName: toType.name,
					kind: "union",
					fields: [],
					variants,
				});
			}
		}
		return migrations;
	}

	private getLayout(field: Field): TypeLayout {
		const layout = this.getLayoutInternal(field);
		if (this.config.layout === "zero-padding") {
			return { size: layout.size, align: 1, paddedSize: layout.size };
		}
		return layout;
	}

	private getDbusLayout(field: Field): TypeLayout {
		if (field.kind === "primitive") {
			let size = field.size;
			let align = field.align;

			if (field.name === "bool" || field.name === "boolean") {
				size = 4;
				align = 4;
			} else if (field.bitSize === 64) {
				align = 8;
			} else if (field.bitSize === 32 || field.name === "string") {
				align = 4;
			} else if (field.bitSize === 16) {
				align = 2;
			}

			const paddedSize = Math.ceil(size / align) * align;
			return { size, align, paddedSize };
		}

		if (field.kind === "string") {
			const size = 4 + (field.maxLength || field.exactLength || 0) + 1;
			return { size, align: 4, paddedSize: Math.ceil(size / 4) * 4 };
		}

		if (field.kind === "array") {
			const itemLayout = this.getDbusLayout(field.item);
			const headerSize = 4;
			const align = Math.max(4, itemLayout.align);
			const bodySize =
				(field.maxLength || field.exactLength || 0) * itemLayout.paddedSize;
			const size = headerSize + bodySize;
			return { size, align, paddedSize: Math.ceil(size / align) * align };
		}

		if (field.kind === "reference") {
			const plan = this.getPlan(field.name);
			return {
				size: plan.size,
				align: plan.align,
				paddedSize: plan.paddedSize,
			};
		}

		if (field.kind === "inlineStruct") {
			return {
				size: field.size,
				align: field.align,
				paddedSize: field.paddedSize,
			};
		}

		return { size: 0, align: 1, paddedSize: 0 };
	}

	private getLayoutInternal(field: Field): TypeLayout {
		if (this.config.layout === "dbus") {
			return this.getDbusLayout(field);
		}
		if (field.kind === "unit") return { size: 0, align: 1, paddedSize: 0 };

		if (field.kind === "primitive") {
			if ("size" in field && "align" in field) {
				let align = field.align;
				if (this.config.wordSize === "32" && field.size >= 8) {
					align = Math.min(align, 4);
				}
				const paddedSize = Math.ceil(field.size / align) * align;
				return {
					size: field.size,
					align,
					paddedSize,
				};
			}
			this.error(`Field ${JSON.stringify(field)} is missing layout metadata.`);
			return { size: 0, align: 1, paddedSize: 0 };
		}

		if (field.kind === "reference") {
			const plan = this.getPlan(field.name);
			return {
				size: plan.size,
				align: plan.align,
				paddedSize: plan.paddedSize ?? plan.size,
			};
		}

		if (field.kind === "array") {
			const isFixed = field.exactLength !== undefined;
			const max = isFixed
				? field.exactLength!
				: field.maxLength || field.exactLength || 0;
			const itemLayout = this.getLayoutInternal(field.item);

			let align = isFixed ? itemLayout.align : Math.max(4, itemLayout.align);
			let stride = itemLayout.paddedSize;

			const isVector =
				isFixed && field.item.kind === "primitive" && max >= 2 && max <= 4;

			if (this.config.layout === "std140" || this.config.layout === "std430") {
				if (isVector) {
					align = max === 2 ? 2 * itemLayout.size : 4 * itemLayout.size;
					stride = itemLayout.size;
				} else if (this.config.layout === "std140") {
					align = Math.max(align, 16);
					stride = Math.ceil(stride / 16) * 16;
				}
			}

			const baseSize =
				(isFixed && isVector ? 0 : isFixed ? 0 : 4) + max * stride;
			const paddedSize = Math.ceil(baseSize / align) * align;

			return { size: baseSize, align, paddedSize };
		}

		if (field.kind === "string") {
			const size = 4 + (field.maxLength || field.exactLength || 0);
			const align = 4;
			return { size, align, paddedSize: Math.ceil(size / align) * align };
		}

		if (field.kind === "optional") {
			const inner = this.getLayout(field.inner);
			const align = inner.align;
			const tagSize = 1;
			const paddingBeforeData = (align - (tagSize % align)) % align;
			const totalSize = tagSize + paddingBeforeData + inner.size;
			const paddedSize = Math.ceil(totalSize / align) * align;

			return { size: totalSize, align, paddedSize };
		}

		if (field.kind === "inlineStruct") {
			return {
				size: field.size,
				align: field.align,
				paddedSize: field.paddedSize ?? field.size,
			};
		}

		return { size: 0, align: 1, paddedSize: 0 };
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
			// if (renamedFrom) plan.migrationMeta = { renamedFrom };
			return plan;
		}

		if (typeDef.type === "object") {
			const fieldValues = Object.values(typeDef.fields || {});
			if (fieldValues.length > 0 && fieldValues[0]?.popKind === "gpu-binding") {
				return this.analyzeGpuBindingLayout(name, typeDef);
			}
			const plan = this.analyzeStruct(name, typeDef);
			plan.description = description;
			if (obsolete) {
				plan.obsolete = true;
				if (obsoleteReason) plan.obsoleteReason = obsoleteReason;
			}
			// if (renamedFrom) plan.migrationMeta = { renamedFrom };
			return plan;
		}

		const field = this.resolveFieldType(typeDef, name);
		const layout = this.getLayout(field);
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
			const last = fields[fields.length - 1]!;
			structSize = last.offset + last.size + last.paddingAfter;
			structAlign = fields.reduce(
				(max, f) => Math.max(max, this.getLayout(f.type).align),
				1,
			);
		} else {
			structSize = 1;
			structAlign = 1;
		}

		if (this.config.layout === "std140") {
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

	private analyzeGpuBindingLayout(
		name: string,
		typeDef: PopType & { type: "object" },
	): any {
		const bindings: any[] = [];
		for (const [fieldName, fieldType] of Object.entries(typeDef.fields || {})) {
			const ft = fieldType as any;
			let dataTypeName = "unknown";
			let isArray = false;
			if (ft.type === "array") {
				isArray = true;
				const item = ft.item;
				if (item?.type === "link") dataTypeName = item.target;
				else if (item?.binaryType) dataTypeName = item.binaryType;
				else if (item?.type) dataTypeName = item.type;
			} else if (ft.type === "link") {
				dataTypeName = ft.target;
			} else if (ft.type === "symbol") {
				dataTypeName = String(ft.value ?? "");
			} else if (ft.binaryType) {
				dataTypeName = ft.binaryType;
			}
			bindings.push({
				name: fieldName,
				group: ft.gpuGroup ?? 0,
				binding: ft.gpuBinding ?? 0,
				usage: ft.gpuUsage ?? "storage-write",
				dataTypeName,
				isArray,
			});
		}
		return {
			kind: "gpu-binding-layout",
			name,
			size: 0,
			align: 1,
			paddedSize: 0,
			bindings,
		};
	}

	private analyzeFields(
		fieldsDict: Record<string, PopType>,
		parentName?: string,
		tagCtx?: TagContext,
	): FieldPlan[] {
		const entries = Object.entries(fieldsDict || {});
		const propsWithMeta = entries.map(([key, fieldType], i) => {
			const hint = parentName ? `${parentName}_${key}` : key;

			let type: Field;
			if (tagCtx && key === tagCtx.name) {
				type = this.assertField({
					kind: "reference",
					name: tagCtx.enumName,
					indirection: "inline",
					isForward: false,
				});
			} else {
				type = this.resolveFieldType(fieldType, undefined, hint, tagCtx);
			}

			const hasDefault = fieldType.default !== undefined;
			if (fieldType.required === false && !hasDefault) {
				type = { kind: "optional", inner: type };
			}
			const layout = this.getLayout(type);
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

		if (this.config.autoPack) {
			propsWithMeta.forEach((meta) => {
				const t = meta.type;
				if (t.kind === "primitive") {
					if (t.name === "bool" || t.name === "boolean") {
						meta.type = {
							...t,
							popKind: "bitwise",
							bitSize: 1,
						};
					} else if (t.unsigned && t.bitSize !== undefined && t.bitSize <= 16) {
						meta.type = {
							...t,
							popKind: "bitwise",
						};
					} else if (t.unsigned && t.size !== undefined && t.size <= 2) {
						meta.type = {
							...t,
							popKind: "bitwise",
							bitSize: t.size * 8,
						};
					}
				}
			});
		}

		if (this.config.autoSort) {
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
				(type.bitSize < 8 || (this.config.autoPack && type.bitSize < 32));
			const bitSize = isBitwise ? type.bitSize : meta.size * 8;

			const migrationMeta: any = {};
			if (meta.fieldType.renamedFrom)
				migrationMeta.renamedFrom = meta.fieldType.renamedFrom;
			if (meta.hasDefault) migrationMeta.defaultValue = meta.defaultValue;

			if (isBitwise) {
				const maxBits = this.config.autoPack ? 32 : 8;
				const wordSize = (this.config.autoPack && type.bitSize >= 8) ? 4 : (type.bitSize < 8 ? 1 : 4);
				if (currentBitOffset + bitSize > maxBits) {
					currentOffset += wordSize;
					currentBitOffset = 0;
				}
				fields.push({
					name: meta.key,
					type: meta.type,
					offset: currentOffset,
					bitOffset: currentBitOffset,
					bitSize: bitSize,
					size: wordSize,
					paddingAfter: 0,
					...(meta.fieldType.description
						? { description: meta.fieldType.description }
						: {}),
					...(meta.fieldType.obsolete ? { obsolete: true } : {}),
					...(Object.keys(migrationMeta).length > 0 ? { migrationMeta } : {}),
				});
				currentBitOffset += bitSize;
			} else {
				if (currentBitOffset > 0) {
					currentOffset += (this.config.autoPack ? 4 : 1);
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
					...(meta.fieldType.description
						? { description: meta.fieldType.description }
						: {}),
					...(meta.fieldType.obsolete ? { obsolete: true } : {}),
					...((meta.fieldType as any).atomic ? { atomic: true } : {}),
					...(Object.keys(migrationMeta).length > 0 ? { migrationMeta } : {}),
				});
				currentOffset += meta.paddedSize;
			}
		}
		if (currentBitOffset > 0) {
			currentOffset += (this.config.autoPack ? 4 : 1);
		}

		const structAlign = fields.reduce(
			(max, f) => Math.max(max, this.getLayout(f.type).align),
			1,
		);
		const finalAlign =
			this.config.layout === "std140" ? Math.max(structAlign, 16) : structAlign;

		for (let i = 0; i < fields.length; i++) {
			const f = fields[i]!;
			const fieldLayout = this.getLayout(f.type);
			let nextOffset = Math.ceil(currentOffset / finalAlign) * finalAlign;
			if (f.size === 0 && f.bitSize === 0) continue;
			if (f.bitSize > 0 && f.bitSize < 8) {
				let j = i + 1;
				while (j < fields.length && fields[j]!.offset === f.offset) j++;
				nextOffset =
					j < fields.length
						? fields[j]!.offset
						: Math.ceil(currentOffset / finalAlign) * finalAlign;
				f.paddingAfter = j === i + 1 ? nextOffset - (f.offset + 1) : 0;
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

		const variants: VariantPlan[] = (typeDef.variants || []).map(
			(branch: any, i: number) => {
				let vName = branch.label;
				if (!vName) {
					if (branch.type === "link") vName = branch.target;
					else if (branch.type === "object" && branch.typeString)
						vName = branch.typeString;
					else vName = `Variant${i + 1}`;
				}
				vName = vName.replace(/[^a-zA-Z0-9_]/g, "");
				return {
					name: vName,
					type: this.resolveFieldType(branch, undefined, `${name}_${vName}`),
					...(branch.renamedFrom
						? { migrationMeta: { renamedFrom: branch.renamedFrom } }
						: {}),
				};
			},
		);

		variants.sort((a, b) => a.name.localeCompare(b.name));

		const tagEnumName = this.synthesizeEnum(
			variants.map((v) => v.name),
			`${name}Tag`,
		);
		const tagEnum = this.resolvedPlans.get(tagEnumName) as EnumPlan;
		const tagSize = tagEnum.size;
		const tagType: "u8" | "u16" | "u32" =
			tagEnum.underlyingType === "i32"
				? "u32"
				: (tagEnum.underlyingType as "u8" | "u16");

		const payloadAlign = variants.reduce(
			(max, v) =>
				Math.max(
					max,
					v.type.kind !== "unit" ? this.getLayout(v.type).align : 1,
				),
			1,
		);
		const payloadSize = variants.reduce(
			(max, v) =>
				Math.max(
					max,
					v.type.kind !== "unit" ? this.getLayout(v.type).paddedSize : 0,
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
			variants,
			discriminant: (typeDef as any).discriminant || "kind",
		};
	}

	private resolveFieldType(
		type: PopType,
		currentTypeName?: string,
		pathHint?: string,
		tagCtx?: TagContext,
	): Field {
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
			const builtin = this.getBuiltinPrimitive(type.target);
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
			if (type.maxLength) nField.maxLength = type.maxLength;
			return this.assertField(nField);
		}

		if (type.type === "object") {
			if (!type.fields || Object.keys(type.fields).length === 0) {
				if (type.additionalProperties) {
					return this.assertField({
						kind: "map",
						keyKind: "string",
						value: { kind: "any" },
					});
				}
				return this.assertField({ kind: "unit" });
			}

			const fields = this.analyzeFields(
				type.fields || {},
				currentTypeName,
				tagCtx,
			);
			let structSize = 0;
			let structAlign = 1;
			if (fields.length > 0) {
				const last = fields[fields.length - 1]!;
				structSize = last.offset + last.size + last.paddingAfter;
				structAlign = fields.reduce(
					(max, f) => Math.max(max, this.getLayout(f.type).align),
					1,
				);
			} else {
				structSize = 1;
				structAlign = 1;
			}
			if (this.config.layout === "std140")
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
			return this.assertField({ kind: "any" });
		}

		if (type.type === "any") {
			return this.assertField({ kind: "any" });
		}

		const builtin = this.getBuiltinPrimitive(type.type);
		if (builtin) return builtin;

		return this.assertField({
			kind: "primitive",
			name: "unknown",
			size: 0,
			align: 1,
			paddedSize: 0,
		});
	}
}
