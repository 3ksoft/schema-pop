import { type, type Scope, type Type } from "arktype";
import type { BaseNode } from "@ark/schema";
import { binary } from "../schema/binary";
import {
	getProps,
	findNode,
	getRule,
} from "../ark-utils";
import {
	type TypePlan,
	type StructPlan,
	type FieldPlan,
	type LayoutPlan,
	type UnionPlan,
	type VariantPlan,
	type EnumPlan,
	type TypeLayout,
	Field
} from "../schema/layout";

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

export interface AnalyzerConfig {
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layoutType?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
}

interface InferenceCandidate {
	name: string;
	type: Type;
	meta: { size?: number; align?: number; SCHEMA_POP_KIND?: string };
	kind: "binary" | "bitwise";
}

export class SchemaAnalyzer {
	private module: Record<string, Type>;
	private aliases: Record<string, Type>;
	private primitiveNames: string[];
	private scopeNames: string[];
	private resolvedPlans = new Map<string, TypePlan>();
	private visiting = new Set<string>();
	private errors: string[] = [];
	private config: AnalyzerConfig;
	private inferenceOrder: InferenceCandidate[];
	private synthEnumsByHash = new Map<string, EnumPlan>();
	private synthEnumNames = new Set<string>();

	constructor(scope: Scope<any>, config: AnalyzerConfig = {}) {
		this.config = { wordSize: 64, autoLayout: true, layoutType: "aligned", ...config };
		this.module = scope.export();
		this.aliases = (scope as any).aliases ?? {};
		this.primitiveNames = Object.keys(binary.export());
		this.scopeNames = [...scope.exportedNames];
		this.inferenceOrder = this.buildInferenceOrder();
	}

	private buildInferenceOrder(): InferenceCandidate[] {
		const candidates: InferenceCandidate[] = [];
		for (const [name, t] of Object.entries(this.aliases)) {
			if (!t || name === "bool" || typeof (t as any).meta !== "object") continue;
			const meta = ((t as any).meta ?? {}) as InferenceCandidate["meta"];
			const kind = meta.SCHEMA_POP_KIND;
			if (kind !== "binary" && kind !== "bitwise") continue;
			candidates.push({ name, type: t as Type, meta, kind });
		}
		// Stable sort: bitwise before binary, then by size asc; ties keep scope-definition order
		return candidates
			.map((c, i) => ({ c, i }))
			.sort((a, b) => {
				if (a.c.kind !== b.c.kind) return a.c.kind === "bitwise" ? -1 : 1;
				const sa = a.c.meta.size ?? 0;
				const sb = b.c.meta.size ?? 0;
				if (sa !== sb) return sa - sb;
				return a.i - b.i;
			})
			.map(({ c }) => c);
	}

	private error(msg: string) {
		this.errors.push(msg);
	}

	private toPascal(s: string): string {
		return s.replace(/(^|[_\s-])(\w)/g, (_, __, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
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
		while (this.synthEnumNames.has(unique) || this.scopeNames.includes(unique)) {
			unique = `${name}${++n}`;
		}

		const size = values.length <= 256 ? 1 : (values.length <= 65536 ? 2 : 4);
		const underlyingType: "u8" | "u16" | "i32" = size === 1 ? "u8" : size === 2 ? "u16" : "i32";
		const plan: EnumPlan = {
			kind: "enum",
			name: unique,
			size,
			align: size,
			paddedSize: size,
			variants: values.map((v, i) => ({ name: v, value: i, description: "" })),
			underlyingType,
		};
		this.synthEnumsByHash.set(hash, plan);
		this.synthEnumNames.add(unique);
		this.resolvedPlans.set(unique, plan);
		return unique;
	}

	public getErrors() {
		return this.errors;
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
			this.error(`Cyclic dependency detected for ${name}`);
			return { kind: "alias", name, size: 0, align: 1, paddedSize: 0, type: { kind: "unit" } };
		}
		this.visiting.add(name);

		const rawEntry = this.module[name];
		if (!rawEntry) {
			this.error(`Cannot resolve type ${name}`);
			return { kind: "alias", name, size: 0, align: 1, paddedSize: 0, type: { kind: "unit" } };
		}
		const node = rawEntry.internal;
		const plan = this.analyzeTopLevel(name, node);

		this.resolvedPlans.set(name, plan);
		this.visiting.delete(name);
		return plan;
	}

	public analyze(version: string, endian: "le" | "be" = "le"): LayoutPlan {
		const names = [...this.scopeNames].filter(
			(n) => !this.primitiveNames.includes(n) && n !== "Binary" && n !== "Describe",
		);

		for (const name of names) {
			this.getPlan(name);
		}

		const sorted: TypePlan[] = [];
		const visited = new Set<string>();

		const visit = (name: string) => {
			if (visited.has(name)) return;
			const plan = this.resolvedPlans.get(name);
			if (plan) {
				const deps = new Set<string>();
				const addDeps = (field: Field) => {
					if (field.kind === "reference") deps.add(field.name);
					else if (field.kind === "array") addDeps(field.item);
					else if (field.kind === "optional") addDeps(field.inner);
				};
				if (plan.kind === "struct") plan.fields.forEach((f) => addDeps(f.type));
				else if (plan.kind === "union") plan.variants.forEach((v) => addDeps(v.type));
				else if (plan.kind === "alias") addDeps(plan.type);
				for (const dep of deps) visit(dep);
				sorted.push(plan);
			}
			visited.add(name);
		};

		for (const name of names) visit(name);

		// Synthesized enums (tag enums, anonymous field-level enums) may not be referenced
		// transitively from any user type — append the unvisited ones in declaration order.
		for (const synth of this.synthEnumsByHash.values()) {
			if (!visited.has(synth.name)) {
				sorted.unshift(synth);
				visited.add(synth.name);
			}
		}

		if (this.errors.length > 0) {
			throw new Error(`Schema analysis failed with ${this.errors.length} errors:\n` + this.errors.map(e => `  - ${e}`).join("\n"));
		}

		return {
			version,
			endian,
			autoLayout: !!this.config.autoLayout,
			wordSize: (this.config.wordSize as 32 | 64) || 64,
			types: sorted
		};
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

	private getBinaryMetadata(node: BaseNode): (TypeLayout & { type: string, bitSize?: number }) | undefined {
		const meta = node.meta as any;
		if (meta?.SCHEMA_POP_KIND === "binary") {
			return {
				size: meta.size!,
				align: meta.align!,
				paddedSize: Math.ceil(meta.size! / meta.align!) * meta.align!,
				type: meta.type!
			};
		}
		if (meta?.SCHEMA_POP_KIND === "bitwise") {
			return {
				size: 1,
				align: 1,
				paddedSize: 1,
				type: `u${meta.size}`,
				bitSize: meta.size
			};
		}
		return undefined;
	}

	private getLayout(field: Field): TypeLayout {
		const layout = this.getLayoutInternal(field);
		if (this.config.layoutType === "zero-padding") {
			return { size: layout.size, align: 1, paddedSize: layout.size };
		}
		return layout;
	}

	private getLayoutInternal(field: Field): TypeLayout {
		if (field.kind === "unit") return { size: 0, align: 1, paddedSize: 0 };

		if (field.kind === "primitive") {
			if ('size' in field && 'align' in field) {
				let align = field.align;
				if (this.config.wordSize === 32 && field.size >= 8) {
					align = Math.min(align, 4);
				}
				const paddedSize = Math.ceil(field.size / align) * align;
				return {
					size: field.size,
					align,
					paddedSize
				};
			}
			this.error(`Field ${JSON.stringify(field)} is missing layout metadata.`);
			return { size: 0, align: 1, paddedSize: 0 };
		}

		if (field.kind === "reference") {
			const plan = this.getPlan(field.name);
			return { size: plan.size, align: plan.align, paddedSize: plan.paddedSize ?? plan.size };
		}

		if (field.kind === "array") {
			const isFixed = field.exactLength !== undefined;
			const max = isFixed ? field.exactLength! : field.maxLength || 0;
			const itemLayout = this.getLayoutInternal(field.item);

			let align = isFixed ? itemLayout.align : Math.max(4, itemLayout.align);
			let stride = itemLayout.paddedSize;

			const isVector = isFixed && field.item.kind === "primitive" && max >= 2 && max <= 4;

			if (this.config.layoutType === "std140" || this.config.layoutType === "std430") {
				if (isVector) {
					align = max === 2 ? 2 * itemLayout.size : 4 * itemLayout.size;
					stride = itemLayout.size;
				} else if (this.config.layoutType === "std140") {
					align = Math.max(align, 16);
					stride = Math.ceil(stride / 16) * 16;
				} else {
					stride = Math.ceil(stride / align) * align;
				}
			} else {
				stride = Math.ceil(stride / align) * align;
			}

			const baseSize = (isFixed && isVector ? 0 : (isFixed ? 0 : 4)) + max * stride;
			const paddedSize = Math.ceil(baseSize / align) * align;

			return { size: baseSize, align, paddedSize };
		}

		if (field.kind === "string") {
			const size = 4 + (field.maxLength || 0);
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
			return { size: field.size, align: field.align, paddedSize: field.paddedSize ?? field.size };
		}

		return { size: 0, align: 1, paddedSize: 0 };
	}

	private analyzeTopLevel(name: string, node: BaseNode): TypePlan {
		const description = (node.meta as any)?.description || node.description;
		const obsolete = (node.meta as any)?.obsolete;
		const obsoleteReason = (node.meta as any)?.obsoleteReason;
		if (node.kind === "union") {
			const plan = this.analyzeUnion(name, node);
			plan.description = description;
			if (obsolete) {
				plan.obsolete = true;
				if (obsoleteReason) plan.obsoleteReason = obsoleteReason;
			}
			return plan;
		}
		const props = getProps(node);
		if (props.length > 0) {
			const plan = this.analyzeStruct(name, node);
			plan.description = description;
			if (obsolete) {
				plan.obsolete = true;
				if (obsoleteReason) plan.obsoleteReason = obsoleteReason;
			}
			return plan;
		}

		const field = this.resolveFieldType(node, name);
		const layout = this.getLayout(field);
		return {
			kind: "alias",
			name,
			...layout,
			type: field,
			description,
			...(obsolete ? { obsolete: true, ...(obsoleteReason ? { obsoleteReason } : {}) } : {}),
		};
	}

	private analyzeStruct(name: string, node: BaseNode): StructPlan {
		const fields = this.analyzeFields(node, name);
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

		if (this.config.layoutType === "std140") {
			structAlign = Math.max(structAlign, 16);
		}

		const paddedSize = Math.ceil(structSize / structAlign) * structAlign;
		return {
			kind: "struct",
			name,
			size: paddedSize, // Match native sizeof
			align: structAlign,
			paddedSize,
			fields,
		};
	}

	private analyzeFields(node: BaseNode, parentName?: string): FieldPlan[] {
		const props = getProps(node);
		const propsWithMeta = props.map((p, i) => {
			const hint = parentName ? `${parentName}_${String(p.key)}` : String(p.key);
			let type = this.resolveFieldType(p.value, undefined, hint);
			if (p.kind === "optional") type = { kind: "optional", inner: type };
			const layout = this.getLayout(type);
			return {
				prop: p,
				originalIndex: i,
				type,
				align: layout.align,
				size: layout.size,
				paddedSize: layout.paddedSize
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
			const isBitwise = type.kind === "primitive" && type.bitSize < 8;
			const bitSize = isBitwise ? type.bitSize : (meta.size * 8);
			const propMeta = {
				...(meta.prop.value?.meta || {}),
				...((meta.prop as any).meta || {}),
			};
			const fieldDesc = propMeta.description || meta.prop.description || meta.prop.value?.description;
			const fieldObsolete = propMeta.obsolete === true ? true : undefined;
			const fieldObsoleteReason = propMeta.obsoleteReason;

			if (isBitwise) {
				if (currentBitOffset + bitSize > 8) {
					currentOffset += 1;
					currentBitOffset = 0;
				}
				fields.push({
					name: meta.prop.key,
					type: meta.type,
					offset: currentOffset,
					bitOffset: currentBitOffset,
					bitSize: bitSize,
					size: 1,
					paddingAfter: 0,
					description: fieldDesc,
					...(fieldObsolete ? { obsolete: true } : {}),
					...(fieldObsoleteReason ? { obsoleteReason: fieldObsoleteReason } : {}),
				});
				currentBitOffset += bitSize;
			} else {
				if (currentBitOffset > 0) {
					currentOffset += 1;
					currentBitOffset = 0;
				}
				const paddingBefore = (meta.align - (currentOffset % meta.align)) % meta.align;
				currentOffset += paddingBefore;

				fields.push({
					name: meta.prop.key,
					type: meta.type,
					offset: currentOffset,
					bitOffset: 0,
					bitSize: meta.size * 8,
					size: meta.size,
					paddingAfter: 0,
					description: fieldDesc,
					...(fieldObsolete ? { obsolete: true } : {}),
					...(fieldObsoleteReason ? { obsoleteReason: fieldObsoleteReason } : {}),
				});
				currentOffset += meta.paddedSize;
			}
		}
		if (currentBitOffset > 0) currentOffset += 1;

		const structAlign = fields.reduce((max, f) => Math.max(max, this.getLayout(f.type).align), 1);
		const finalAlign = this.config.layoutType === "std140" ? Math.max(structAlign, 16) : structAlign;

		for (let i = 0; i < fields.length; i++) {
			const f = fields[i]!;
			const fieldLayout = this.getLayout(f.type);
			let nextOffset = Math.ceil(currentOffset / finalAlign) * finalAlign;

			if (f.bitSize < 8) {
				let j = i + 1;
				while (j < fields.length && fields[j]!.offset === f.offset) j++;
				nextOffset = j < fields.length ? fields[j]!.offset : Math.ceil(currentOffset / finalAlign) * finalAlign;

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

	private analyzeUnion(name: string, node: BaseNode): UnionPlan | EnumPlan {
		const children = node.children ?? [];
		const isEnum = children.every((c: any) => c.kind === "unit" || c.unit !== undefined);

		if (isEnum) {
			const variants = children.map((c: any, i: number) => ({
				name: c.unit ? String(c.unit) : c.nestableExpression.replace(/['"]/g, ""),
				value: i
			}));
			return { kind: "enum", name, size: 1, align: 1, paddedSize: 1, variants, underlyingType: "u8" };
		}

		const disc = (node as any).discriminant as { kind?: string; path?: PropertyKey[]; cases?: Record<string, unknown> } | null;
		const naturalDisc = !!(disc && disc.kind === "unit" && disc.path?.length === 1 && disc.cases);
		const discPath = naturalDisc ? String(disc!.path![0]) : undefined;

		const variants: VariantPlan[] = children.map((branch: any, i: number) => {
			const foundName = this.scopeNames.find(
				(n) => this.module[n]?.internal === branch
			);
			let vName: string;
			if (branch.kind === "unit" || branch.unit !== undefined) {
				vName = branch.unit ? String(branch.unit) : branch.nestableExpression.replace(/['"]/g, "");
			} else if (naturalDisc) {
				const branchProps = getProps(branch);
				const discProp = branchProps.find((p) => String(p.key) === discPath);
				const discValue = discProp?.value as any;
				vName = discValue && discValue.unit !== undefined
					? String(discValue.unit)
					: (foundName ?? `Variant${i + 1}`);
			} else {
				vName = foundName ?? `Variant${i + 1}`;
			}
			return {
				name: vName.replace(/[^a-zA-Z0-9_]/g, ""),
				type:
					branch.kind === "unit" || branch.unit !== undefined
						? { kind: "unit" }
						: this.resolveFieldType(branch, undefined, `${name}_${vName}`),
			};
		});

		variants.sort((a, b) => a.name.localeCompare(b.name));

		// Tag enum: synthesize once per union, named `${UnionName}Tag`. Dedupe by case-key set.
		const tagEnumName = this.synthesizeEnum(variants.map(v => v.name), `${name}Tag`);
		const tagEnum = this.resolvedPlans.get(tagEnumName) as EnumPlan;
		const tagSize = tagEnum.size;
		const tagType: "u8" | "u16" | "u32" =
			tagEnum.underlyingType === "i32" ? "u32" : (tagEnum.underlyingType as "u8" | "u16");

		const payloadAlign = variants.reduce(
			(max, v) =>
				Math.max(max, v.type.kind !== "unit" ? this.getLayout(v.type).align : 1),
			1,
		);
		const payloadSize = variants.reduce(
			(max, v) =>
				Math.max(max, v.type.kind !== "unit" ? this.getLayout(v.type).paddedSize : 0),
			0,
		);

		const payloadOffset = Math.ceil(tagSize / payloadAlign) * payloadAlign;
		const unionAlign = Math.max(payloadAlign, tagSize);
		const totalSize = payloadOffset + payloadSize;
		const paddedSize = Math.ceil(totalSize / unionAlign) * unionAlign;

		return {
			kind: "union",
			name,
			size: paddedSize, // Match native sizeof
			align: unionAlign,
			paddedSize,
			tagOffset: 0,
			tagSize,
			tagType,
			variants,
		};
	}

	private makePrimitive(
		name: string,
		size: number,
		align: number,
		bitSize?: number,
		popKind: "binary" | "bitwise" | "reserved" = "binary"
	): Field {
		return {
			kind: "primitive",
			name,
			size,
			align,
			paddedSize: Math.ceil(size / align) * align,
			bitSize: bitSize ?? size * 8,
			popKind
		};
	}

	private inferPrimitiveFromConstraints(node: BaseNode): Field | undefined {
		if (!node.isRoot()) return undefined;

		const children = (node as any).children ?? [];
		const isUnitUnion = node.kind === "union"
			&& children.length > 0
			&& children.every((c: any) => c.kind === "unit" || c.unit !== undefined);

		const domainNode = findNode(node, "domain") as { domain?: string } | undefined;
		const domain = domainNode?.domain;

		if (domain === "boolean") {
			const bool = this.aliases["bool"] as Type | undefined;
			const m = ((bool as any)?.meta ?? {}) as { size?: number; align?: number };
			return this.makePrimitive("bool", m.size || 1, m.align || 1, 1, "binary");
		}

		// unit-unions opt into bitwise candidates; ranges/aliases use binary only
		const targetKind: "bitwise" | "binary" = isUnitUnion ? "bitwise" : "binary";
		const candidates = this.inferenceOrder.filter(c => c.kind === targetKind);

		for (const { name, meta, type: prim, kind } of candidates) {
			if (node.extends(prim)) {
				if (kind === "bitwise") {
					return this.makePrimitive(name, 1, 1, meta.size ?? 0, "bitwise");
				}
				const size = meta.size ?? 0;
				const align = meta.align ?? 1;
				return this.makePrimitive(name, size, align, size * 8, "binary");
			}
		}

		return undefined;
	}

	private resolveFieldType(node: BaseNode, currentTypeName?: string, pathHint?: string): Field {
		if (node.kind === "unit" || (node as any).unit !== undefined) return { kind: "unit" };

		const meta = this.getBinaryMetadata(node);
		if (meta) {
			return this.assertField({
				kind: "primitive",
				size: meta.size,
				align: meta.align,
				paddedSize: meta.paddedSize,
				name: meta.type,
				bitSize: meta.bitSize ?? meta.size * 8
			});
		}

		if (node.kind === "union") {
			const children = node.children ?? [];
			const allUnit = children.every((c: any) => c.kind === "unit" || c.unit !== undefined);
			if (allUnit) {
				const units = children.map((c: any) => c.unit);
				const isBool = children.length === 2 && units.includes(true) && units.includes(false);
				if (isBool) return this.makePrimitive("bool", 1, 1);
				const disc = (node as any).discriminant as { kind?: string; path?: PropertyKey[] } | null;
				const isLeafStringEnum = disc && disc.kind === "unit" && (disc.path?.length ?? 0) === 0
					&& units.every((u: any) => typeof u === "string");
				if (isLeafStringEnum) {
					const synthName = this.synthesizeEnum(units as string[], pathHint ?? "AnonEnum");
					return { kind: "reference", name: synthName, indirection: "inline", isForward: false };
				}
				const inferred = this.inferPrimitiveFromConstraints(node);
				if (inferred) return inferred;
			}
		}

		const expr = typeof node.expression === "string" ? node.expression : "";
		const foundName = this.scopeNames.find((n) => {
			const entry = this.module[n];
			return (
				entry &&
				(entry.internal === node || entry.expression === expr)
			);
		});

		if (foundName && foundName !== currentTypeName) {
			if (this.primitiveNames.includes(foundName)) {
				const primNode = this.module[foundName]!.internal;
				const primMeta = this.getBinaryMetadata(primNode);
				if (primMeta) {
					return this.assertField({ kind: "primitive", size: primMeta.size, align: primMeta.align, paddedSize: primMeta.paddedSize, name: primMeta.type });
				}
			}
			return { kind: "reference", name: foundName, indirection: "inline", isForward: false };
		}

		if (node.kind === "sequence" || findNode(node, "sequence")) {
			const seqNode = (node.kind === "sequence" ? node : findNode(node, "sequence")) as any;
			const exactLength = getRule(node, "exactLength") ?? (seqNode.minLength === seqNode.maxLength ? seqNode.minLength : undefined);
			const maxLength = getRule(node, "maxLength") ?? seqNode.maxLength;

			let itemNode = seqNode.variadic;
			if (!itemNode && seqNode.prefix && seqNode.prefix.length > 0) {
				itemNode = seqNode.prefix[0];
			}

			const arrayField: Record<string, unknown> = {
				kind: "array",
				item: itemNode ? this.resolveFieldType(itemNode, undefined, pathHint ? `${pathHint}Item` : undefined) : { kind: "primitive", name: "u8", size: 1, align: 1, paddedSize: 1 },
			};
			if (exactLength != null) arrayField["exactLength"] = exactLength;
			if (maxLength != null) arrayField["maxLength"] = maxLength;
			return this.assertField(arrayField);
		}

		const domainNode = findNode(node, "domain");
		if (domainNode && (domainNode as any).expression === "string") {
			return { kind: "string", maxLength: getRule(node, "maxLength") ?? (node as any).maxLength };
		}

		const inferred = this.inferPrimitiveFromConstraints(node);
		if (inferred) return inferred;

		this.error(`Unable to resolve field type: ${expr}`);
		return this.assertField({ kind: "primitive", name: "unknown", size: 0, align: 1, paddedSize: 0 });
	}
}
