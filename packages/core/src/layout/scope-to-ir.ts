/**
 * `arktypeScopeToIR` — first half of the analyzer split (NEXT_STEPS
 * Phase 2). Walks an arktype scope through `SchemaAnalyzer`, then
 * post-processes the resulting `LayoutPlan` into a canonical
 * `SchemaPopIR` carrying the full layout sidecar (size/align per
 * type, offset/paddingAfter per field).
 *
 * The arktype walker is the only importer that knows the schema's
 * intent (`Obsolete<>` markers, `Renamed<>`, defaults, descriptions),
 * so this stage owns metadata extraction. Tree-sitter and clang
 * walkers produce the same IR shape but typically have no
 * description / migrationMeta and (for tree-sitter) no layout sidecar
 * either.
 *
 * Round-trip: `computeLayoutPlan(arktypeScopeToIR(scope))` reproduces
 * `new SchemaAnalyzer(scope).analyze()` byte-for-byte (validated by
 * the `_baseline.test.ts` snapshot suite).
 */
import type { Scope } from "arktype";
import type {
	IRItem,
	IRField,
	IRType,
	IREnumVariant,
	IRVariant,
	SchemaPopIR,
} from "../ir";
import type {
	AliasPlan,
	EnumPlan,
	Field,
	FieldPlan,
	StructPlan,
	TypePlan,
	UnionPlan,
	VariantPlan,
} from "../schema/layout";
import { SchemaAnalyzer, type AnalyzerConfig } from "./analyzer";

export interface ScopeToIROptions extends AnalyzerConfig {
	source?: string;
	/**
	 * Drop the layout sidecar (size/align/paddedSize on items, offset/
	 * size/paddingAfter on fields) from the produced IR. Used to test
	 * `computeLayoutPlan`'s derive path — and to model what a thin
	 * importer (tree-sitter, clang without `-fdump-record-layouts`)
	 * would produce.
	 */
	noLayout?: boolean;
}

export function arktypeScopeToIR(
	scope: Scope<any>,
	opts: ScopeToIROptions = {},
): SchemaPopIR {
	const { source = "arktype-scope", noLayout, ...analyzerOpts } = opts;
	// Use the existing analyzer to do the heavy lifting (constraint
	// inference, primitive selection, alignment pass, enum synthesis).
	// The IR is then a strip-and-tag of that output.
	const plan = new SchemaAnalyzer(scope, analyzerOpts).analyze("__ir__", "le");
	let items = plan.types.map(typePlanToIRItem);
	if (noLayout) items = items.map(stripLayout);
	return { source, items, skipped: [] };
}

function stripLayout(item: ReturnType<typeof typePlanToIRItem>) {
	const next: any = { ...item };
	delete next.layout;
	if (item.kind === "union") {
		delete next.tagOffset;
		delete next.tagSize;
	}
	if (item.kind === "struct") {
		next.fields = item.fields.map(stripFieldLayout);
	}
	if (item.kind === "alias") {
		next.type = stripTypeLayout(item.type);
	}
	if (item.kind === "union") {
		next.variants = item.variants.map((v: any) => ({
			...v,
			type: stripTypeLayout(v.type),
		}));
	}
	return next;
}

function stripFieldLayout(f: any): any {
	const { layout: _drop, ...rest } = f;
	return { ...rest, type: stripTypeLayout(f.type) };
}

function stripTypeLayout(t: any): any {
	if (!t || typeof t !== "object") return t;
	if (t.kind === "array") {
		return { ...t, item: stripTypeLayout(t.item) };
	}
	if (t.kind === "optional") {
		return { ...t, inner: stripTypeLayout(t.inner) };
	}
	if (t.kind === "inlineStruct") {
		const { layout: _drop, ...rest } = t;
		return { ...rest, fields: t.fields.map(stripFieldLayout) };
	}
	if (t.kind === "map") {
		return { ...t, value: stripTypeLayout(t.value) };
	}
	return t;
}

function typePlanToIRItem(t: TypePlan): IRItem {
	switch (t.kind) {
		case "struct":
			return structPlanToIR(t);
		case "enum":
			return enumPlanToIR(t);
		case "union":
			return unionPlanToIR(t);
		case "alias":
			return aliasPlanToIR(t);
	}
}

function structPlanToIR(t: StructPlan): IRItem {
	return {
		kind: "struct",
		name: t.name,
		fields: t.fields.map(fieldPlanToIR),
		pub: true,
		...(t.description !== undefined && { description: t.description }),
		...(t.obsolete !== undefined && { obsolete: t.obsolete }),
		...(t.obsoleteReason !== undefined && {
			obsoleteReason: t.obsoleteReason,
		}),
		...(t.migrationMeta !== undefined && { migrationMeta: t.migrationMeta }),
		layout: { size: t.size, align: t.align, paddedSize: t.paddedSize },
	};
}

function enumPlanToIR(t: EnumPlan): IRItem {
	return {
		kind: "enum",
		name: t.name,
		variants: t.variants.map(
			(v): IREnumVariant => ({
				kind: "unit",
				name: v.name,
				value: v.value,
				...(v.description !== undefined && { description: v.description }),
				...(v.migrationMeta !== undefined && {
					migrationMeta: v.migrationMeta,
				}),
			}),
		),
		underlyingType: t.underlyingType,
		pub: true,
		...(t.description !== undefined && { description: t.description }),
		...(t.obsolete !== undefined && { obsolete: t.obsolete }),
		...(t.obsoleteReason !== undefined && {
			obsoleteReason: t.obsoleteReason,
		}),
		...(t.migrationMeta !== undefined && { migrationMeta: t.migrationMeta }),
		layout: { size: t.size, align: t.align, paddedSize: t.paddedSize },
	};
}

function unionPlanToIR(t: UnionPlan): IRItem {
	return {
		kind: "union",
		name: t.name,
		tagType: t.tagType,
		variants: t.variants.map(
			(v: VariantPlan): IRVariant => ({
				name: v.name,
				type: fieldTypeToIR(v.type),
				...(v.migrationMeta !== undefined && {
					migrationMeta: v.migrationMeta,
				}),
			}),
		),
		pub: true,
		...(t.description !== undefined && { description: t.description }),
		...(t.obsolete !== undefined && { obsolete: t.obsolete }),
		...(t.obsoleteReason !== undefined && {
			obsoleteReason: t.obsoleteReason,
		}),
		...(t.migrationMeta !== undefined && { migrationMeta: t.migrationMeta }),
		layout: { size: t.size, align: t.align, paddedSize: t.paddedSize },
		tagOffset: t.tagOffset,
		tagSize: t.tagSize,
	};
}

function aliasPlanToIR(t: AliasPlan): IRItem {
	return {
		kind: "alias",
		name: t.name,
		type: fieldTypeToIR(t.type),
		pub: true,
		...(t.description !== undefined && { description: t.description }),
		...(t.obsolete !== undefined && { obsolete: t.obsolete }),
		...(t.obsoleteReason !== undefined && {
			obsoleteReason: t.obsoleteReason,
		}),
		...(t.migrationMeta !== undefined && { migrationMeta: t.migrationMeta }),
		layout: { size: t.size, align: t.align, paddedSize: t.paddedSize },
	};
}

function fieldPlanToIR(f: FieldPlan): IRField {
	return {
		name: f.name,
		type: fieldTypeToIR(f.type),
		pub: true,
		...(f.description !== undefined && { description: f.description }),
		...(f.obsolete !== undefined && { obsolete: f.obsolete }),
		...(f.obsoleteReason !== undefined && {
			obsoleteReason: f.obsoleteReason,
		}),
		...(f.migrationMeta !== undefined && { migrationMeta: f.migrationMeta }),
		layout: {
			offset: f.offset,
			size: f.size,
			...(f.paddingAfter !== 0 && { paddingAfter: f.paddingAfter }),
			...(f.bitOffset !== 0 && { bitOffset: f.bitOffset }),
			...(f.bitSize !== f.size * 8 && { bitSize: f.bitSize }),
		},
	};
}

function fieldTypeToIR(field: Field): IRType {
	switch (field.kind) {
		case "primitive":
			return {
				kind: "primitive",
				name: field.name as IRType extends { kind: "primitive"; name: infer N }
					? N
					: never,
				...((field as any).popKind !== undefined && {
					popKind: (field as any).popKind,
				}),
				...((field as any).bitSize !== undefined && {
					bitSize: (field as any).bitSize,
				}),
			} as IRType;
		case "reference":
			return {
				kind: "ref",
				name: field.name,
				indirection: field.indirection,
				isForward: field.isForward,
			};
		case "array":
			return {
				kind: "array",
				item: fieldTypeToIR(field.item),
				...(field.exactLength !== undefined && {
					exactLength: field.exactLength,
				}),
				...(field.maxLength !== undefined && { maxLength: field.maxLength }),
			};
		case "string":
			return {
				kind: "string",
				...(field.maxLength !== undefined && { maxLength: field.maxLength }),
			};
		case "optional":
			return { kind: "optional", inner: fieldTypeToIR(field.inner) };
		case "inlineStruct":
			return {
				kind: "inlineStruct",
				fields: field.fields.map(fieldPlanToIR),
				layout: {
					size: field.size,
					align: field.align,
					paddedSize: field.paddedSize,
				},
			};
		case "map":
			return {
				kind: "map",
				keyKind: field.keyKind,
				value: fieldTypeToIR(field.value),
			};
		case "any":
			return {
				kind: "any",
				...(field.originalType !== undefined && {
					originalType: field.originalType,
				}),
			};
		case "unit":
			return { kind: "unit" };
	}
}
