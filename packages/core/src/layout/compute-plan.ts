/**
 * `computeLayoutPlan` — second half of the analyzer split. Takes a
 * `SchemaPopIR` plus per-build options (version, endian, layout
 * strategy, ...) and produces a `LayoutPlan` ready for exporters.
 *
 * Two paths feed the same output:
 *
 *  - **Sidecar path** (arktype walker via `arktypeScopeToIR`, clang
 *    via `-fdump-record-layouts`): every item carries `layout` and
 *    every field carries `layout`; we reconstruct the plan verbatim.
 *  - **Derive path** (tree-sitter walks, importer JSON lacking
 *    sidecars): walk the IR shape and compute size/align/paddedSize
 *    per type and offset/paddingAfter per field using the same rules
 *    `SchemaAnalyzer` applies. Validated byte-for-byte against the
 *    sidecar path on the `_split.test.ts` fixture catalog.
 *
 * Refs are resolved by name from earlier items in the same `items[]`
 * list — IR is expected topo-sorted so dependencies precede consumers.
 */
import type {
	IRField,
	IRItem,
	IRType,
	IRTypeLayout,
	IRVariant,
	SchemaPopIR,
} from "../ir";
import type {
	AliasPlan,
	EnumPlan,
	EnumVariant,
	Field,
	FieldPlan,
	LayoutPlan,
	StructPlan,
	TypePlan,
	UnionPlan,
	VariantPlan,
} from "../schema/layout";

export interface ComputeLayoutOptions {
	version: string;
	endian?: "le" | "be";
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layoutType?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
}

interface DeriveCtx {
	typeLayouts: Map<string, IRTypeLayout>;
	wordSize: 32 | 64;
	autoLayout: boolean;
	layoutType: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
}

export function computeLayoutPlan(
	ir: SchemaPopIR,
	opts: ComputeLayoutOptions,
): LayoutPlan {
	const ctx: DeriveCtx = {
		typeLayouts: new Map(),
		wordSize: opts.wordSize ?? 64,
		autoLayout: opts.autoLayout ?? true,
		layoutType: opts.layoutType ?? "aligned",
	};

	// First pass: ensure every item carries its layout sidecar, in
	// topo-order so dependent types resolve via ctx.typeLayouts.
	const enriched: IRItem[] = [];
	for (const item of ir.items) {
		if (item.kind === "function") {
			enriched.push(item);
			continue;
		}
		const withLayout = ensureItemLayout(item, ctx);
		enriched.push(withLayout);
		if (withLayout.kind !== "function" && withLayout.layout) {
			ctx.typeLayouts.set(withLayout.name, withLayout.layout);
		}
	}

	const types: TypePlan[] = [];
	for (const item of enriched) {
		if (item.kind === "function") continue;
		types.push(itemToTypePlan(item));
	}
	return {
		version: opts.version,
		endian: opts.endian ?? "le",
		wordSize: ctx.wordSize,
		autoLayout: ctx.autoLayout,
		types,
	};
}

/* ───────────────────────── derive pass ───────────────────────── */

function ensureItemLayout(item: IRItem, ctx: DeriveCtx): IRItem {
	if (item.kind === "function") return item;
	if (item.layout) return item;
	switch (item.kind) {
		case "struct":
			return deriveStructLayout(item, ctx);
		case "enum":
			return deriveEnumLayout(item);
		case "alias":
			return deriveAliasLayout(item, ctx);
		case "union":
			return deriveUnionLayout(item, ctx);
	}
}

function deriveStructLayout(
	item: IRItem & { kind: "struct" },
	ctx: DeriveCtx,
): IRItem {
	const result = layoutFields(item.fields, ctx);
	return {
		...item,
		fields: result.fields,
		layout: {
			size: result.size,
			align: result.align,
			paddedSize: result.paddedSize,
		},
	};
}

function deriveEnumLayout(item: IRItem & { kind: "enum" }): IRItem {
	const ut = item.underlyingType ?? "u8";
	const size = ut === "u8" ? 1 : ut === "u16" ? 2 : 4;
	return {
		...item,
		layout: { size, align: size, paddedSize: size },
	};
}

function deriveAliasLayout(
	item: IRItem & { kind: "alias" },
	ctx: DeriveCtx,
): IRItem {
	const inner = getTypeLayout(item.type, ctx);
	return { ...item, layout: inner };
}

function deriveUnionLayout(
	item: IRItem & { kind: "union" },
	ctx: DeriveCtx,
): IRItem {
	const tagSize = item.tagType === "u8" ? 1 : item.tagType === "u16" ? 2 : 4;
	const payloadAlign = item.variants.reduce(
		(max, v) =>
			Math.max(
				max,
				v.type.kind !== "unit" ? getTypeLayout(v.type, ctx).align : 1,
			),
		1,
	);
	const payloadSize = item.variants.reduce(
		(max, v) =>
			Math.max(
				max,
				v.type.kind !== "unit" ? getTypeLayout(v.type, ctx).paddedSize : 0,
			),
		0,
	);
	const payloadOffset = Math.ceil(tagSize / payloadAlign) * payloadAlign;
	const unionAlign = Math.max(payloadAlign, tagSize);
	const totalSize = payloadOffset + payloadSize;
	const paddedSize = Math.ceil(totalSize / unionAlign) * unionAlign;
	return {
		...item,
		layout: { size: paddedSize, align: unionAlign, paddedSize },
		tagOffset: 0,
		tagSize,
	};
}

interface LayoutFieldsResult {
	fields: IRField[];
	size: number;
	align: number;
	paddedSize: number;
}

/**
 * Apply struct field laying — autoLayout reorder, alignment padding,
 * bitfield aggregation, paddingAfter. Mirrors `analyzeFields` in
 * `analyzer.ts`. Returns the fields with `layout` sidecar attached
 * plus the struct-level size/align/paddedSize.
 */
function layoutFields(fields: IRField[], ctx: DeriveCtx): LayoutFieldsResult {
	if (fields.length === 0) {
		return { fields: [], size: 0, align: 1, paddedSize: 0 };
	}
	const meta = fields.map((f, originalIndex) => {
		const layout = getTypeLayout(f.type, ctx);
		const isBitwise =
			f.type.kind === "primitive" &&
			f.type.bitSize !== undefined &&
			f.type.bitSize < 8;
		return {
			f,
			originalIndex,
			layout,
			isBitwise,
			bitSize: isBitwise
				? ((f.type as { bitSize?: number }).bitSize ?? 0)
				: layout.size * 8,
		};
	});

	if (ctx.autoLayout) {
		meta.sort(
			(a, b) =>
				b.layout.align - a.layout.align || a.originalIndex - b.originalIndex,
		);
	}

	const out: IRField[] = [];
	let currentOffset = 0;
	let currentBitOffset = 0;

	for (const m of meta) {
		if (m.isBitwise) {
			if (currentBitOffset + m.bitSize > 8) {
				currentOffset += 1;
				currentBitOffset = 0;
			}
			out.push({
				...m.f,
				layout: {
					offset: currentOffset,
					size: 1,
					...(currentBitOffset !== 0 && { bitOffset: currentBitOffset }),
					...(m.bitSize !== 8 && { bitSize: m.bitSize }),
				},
			});
			currentBitOffset += m.bitSize;
		} else {
			if (currentBitOffset > 0) {
				currentOffset += 1;
				currentBitOffset = 0;
			}
			const align = m.layout.align;
			const padBefore = (align - (currentOffset % align)) % align;
			currentOffset += padBefore;
			out.push({
				...m.f,
				layout: {
					offset: currentOffset,
					size: m.layout.size,
				},
			});
			currentOffset += m.layout.paddedSize;
		}
	}
	if (currentBitOffset > 0) currentOffset += 1;

	const structAlign = meta.reduce((max, m) => Math.max(max, m.layout.align), 1);
	const finalAlign =
		ctx.layoutType === "std140" ? Math.max(structAlign, 16) : structAlign;
	const totalSize = Math.ceil(currentOffset / finalAlign) * finalAlign;

	// Compute paddingAfter — gap between this field's end and the next field's offset.
	for (let i = 0; i < out.length; i++) {
		const f = out[i]!;
		const m = meta[i]!;
		if (!f.layout) continue;
		if (m.layout.size === 0 && !m.isBitwise) continue;
		if (m.isBitwise) {
			let j = i + 1;
			while (j < out.length && out[j]!.layout?.offset === f.layout.offset) j++;
			const nextOffset = j < out.length ? out[j]!.layout!.offset : totalSize;
			if (j === i + 1) {
				const pad = nextOffset - (f.layout.offset + 1);
				if (pad > 0) f.layout.paddingAfter = pad;
			}
		} else {
			const nextOffset =
				i < out.length - 1 ? out[i + 1]!.layout!.offset : totalSize;
			const pad = nextOffset - (f.layout.offset + m.layout.paddedSize);
			if (pad > 0) f.layout.paddingAfter = pad;
		}
	}

	if (ctx.layoutType === "zero-padding") {
		// Re-pack: every alignment becomes 1, size collapses to bytes used.
		// Since fields were laid out with alignment, need to recompute as packed.
		return packTight(meta);
	}

	return {
		fields: out,
		size: totalSize,
		align: finalAlign,
		paddedSize: totalSize,
	};
}

/**
 * `zero-padding` strategy — packed layout. Every primitive aligns to
 * 1, struct align is 1, fields are strictly adjacent. Bitfields still
 * aggregate into byte containers.
 */
function packTight(
	meta: {
		f: IRField;
		layout: IRTypeLayout;
		isBitwise: boolean;
		bitSize: number;
	}[],
): LayoutFieldsResult {
	const out: IRField[] = [];
	let off = 0;
	let bitOff = 0;
	for (const m of meta) {
		if (m.isBitwise) {
			if (bitOff + m.bitSize > 8) {
				off += 1;
				bitOff = 0;
			}
			out.push({
				...m.f,
				layout: {
					offset: off,
					size: 1,
					...(bitOff !== 0 && { bitOffset: bitOff }),
					...(m.bitSize !== 8 && { bitSize: m.bitSize }),
				},
			});
			bitOff += m.bitSize;
		} else {
			if (bitOff > 0) {
				off += 1;
				bitOff = 0;
			}
			out.push({
				...m.f,
				layout: { offset: off, size: m.layout.size },
			});
			off += m.layout.size;
		}
	}
	if (bitOff > 0) off += 1;
	return { fields: out, size: off, align: 1, paddedSize: off };
}

/**
 * Pure version of `SchemaAnalyzer.getLayoutInternal` operating on
 * `IRType`. Refs resolve via `ctx.typeLayouts` populated by the
 * topo-walk in `computeLayoutPlan`.
 */
function getTypeLayout(t: IRType, ctx: DeriveCtx): IRTypeLayout {
	const raw = getTypeLayoutInternal(t, ctx);
	if (ctx.layoutType === "zero-padding") {
		return { size: raw.size, align: 1, paddedSize: raw.size };
	}
	return raw;
}

function getTypeLayoutInternal(t: IRType, ctx: DeriveCtx): IRTypeLayout {
	switch (t.kind) {
		case "primitive": {
			const size = primitiveSize(t.name);
			let align = primitiveAlign(t.name);
			if (ctx.wordSize === 32 && size >= 8) align = Math.min(align, 4);
			return { size, align, paddedSize: Math.ceil(size / align) * align };
		}
		case "ref": {
			// Pointer / reference indirection — sizeof(void*), pointee layout
			// is irrelevant. This is what makes self-referential structs
			// (`struct node *next` inside `struct node`) and forward
			// declarations (`struct foo *`) lay out without a topo cycle.
			if (t.indirection === "pointer" || t.indirection === "reference") {
				const ptrSize = ctx.wordSize === 32 ? 4 : 8;
				return { size: ptrSize, align: ptrSize, paddedSize: ptrSize };
			}
			const r = ctx.typeLayouts.get(t.name);
			if (!r) {
				throw new Error(
					`computeLayoutPlan: ref "${t.name}" not yet resolved. ` +
						`IR items must be topologically sorted (refs follow their target).`,
				);
			}
			return r;
		}
		case "array": {
			const isFixed = t.exactLength !== undefined;
			const max = isFixed ? t.exactLength! : (t.maxLength ?? 0);
			const itemL = getTypeLayout(t.item, ctx);
			let align = isFixed ? itemL.align : Math.max(4, itemL.align);
			let stride = itemL.paddedSize;
			const isVector =
				isFixed && t.item.kind === "primitive" && max >= 2 && max <= 4;
			if (ctx.layoutType === "std140" || ctx.layoutType === "std430") {
				if (isVector) {
					align = max === 2 ? 2 * itemL.size : 4 * itemL.size;
					stride = itemL.size;
				} else if (ctx.layoutType === "std140") {
					align = Math.max(align, 16);
					stride = Math.ceil(stride / 16) * 16;
				}
			}
			const baseSize =
				(isFixed && isVector ? 0 : isFixed ? 0 : 4) + max * stride;
			const paddedSize = Math.ceil(baseSize / align) * align;
			return { size: baseSize, align, paddedSize };
		}
		case "string": {
			const max = t.maxLength ?? 0;
			const size = 4 + max;
			return { size, align: 4, paddedSize: Math.ceil(size / 4) * 4 };
		}
		case "optional": {
			const inner = getTypeLayout(t.inner, ctx);
			const tagSize = 1;
			const align = inner.align;
			const padBefore = (align - (tagSize % align)) % align;
			const total = tagSize + padBefore + inner.size;
			return {
				size: total,
				align,
				paddedSize: Math.ceil(total / align) * align,
			};
		}
		case "inlineStruct": {
			if (t.layout) return t.layout;
			const r = layoutFields(t.fields, ctx);
			return { size: r.size, align: r.align, paddedSize: r.paddedSize };
		}
		case "bit":
			return { size: 1, align: 1, paddedSize: 1 };
		case "map":
		case "any":
		case "unit":
		case "unknown":
		case "unsupported":
			return { size: 0, align: 1, paddedSize: 0 };
	}
}

/* ───────────────────────── plan emit ─────────────────────────── */

function itemToTypePlan(item: IRItem): TypePlan {
	switch (item.kind) {
		case "struct":
			return structToTypePlan(item);
		case "enum":
			return enumToTypePlan(item);
		case "union":
			return unionToTypePlan(item);
		case "alias":
			return aliasToTypePlan(item);
		case "function":
			throw new Error(
				"computeLayoutPlan: function items are filtered before dispatch",
			);
	}
}

function requireTypeLayout(item: { name: string; layout?: unknown }): {
	size: number;
	align: number;
	paddedSize: number;
} {
	if (!item.layout) {
		throw new Error(
			`computeLayoutPlan: item "${item.name}" still missing layout after derive`,
		);
	}
	return item.layout as { size: number; align: number; paddedSize: number };
}

function structToTypePlan(item: IRItem & { kind: "struct" }): StructPlan {
	const layout = requireTypeLayout(item);
	return {
		kind: "struct",
		name: item.name,
		fields: item.fields.map((f) => fieldToFieldPlan(f, item.name)),
		size: layout.size,
		align: layout.align,
		paddedSize: layout.paddedSize,
		...(item.description !== undefined && { description: item.description }),
		...(item.obsolete !== undefined && { obsolete: item.obsolete }),
		...(item.obsoleteReason !== undefined && {
			obsoleteReason: item.obsoleteReason,
		}),
		...(item.migrationMeta !== undefined && {
			migrationMeta: item.migrationMeta,
		}),
	};
}

function enumToTypePlan(item: IRItem & { kind: "enum" }): EnumPlan {
	const layout = requireTypeLayout(item);
	return {
		kind: "enum",
		name: item.name,
		variants: item.variants.map(
			(v, i): EnumVariant => ({
				name: v.name,
				value: v.kind === "unit" && v.value !== undefined ? v.value : i,
				...(v.description !== undefined && { description: v.description }),
				...(v.migrationMeta !== undefined && {
					migrationMeta: v.migrationMeta,
				}),
			}),
		),
		underlyingType: item.underlyingType ?? "u8",
		size: layout.size,
		align: layout.align,
		paddedSize: layout.paddedSize,
		...(item.description !== undefined && { description: item.description }),
		...(item.obsolete !== undefined && { obsolete: item.obsolete }),
		...(item.obsoleteReason !== undefined && {
			obsoleteReason: item.obsoleteReason,
		}),
		...(item.migrationMeta !== undefined && {
			migrationMeta: item.migrationMeta,
		}),
	};
}

function unionToTypePlan(item: IRItem & { kind: "union" }): UnionPlan {
	const layout = requireTypeLayout(item);
	if (item.tagOffset === undefined || item.tagSize === undefined) {
		throw new Error(
			`computeLayoutPlan: union "${item.name}" missing tagOffset/tagSize sidecar.`,
		);
	}
	return {
		kind: "union",
		name: item.name,
		tagOffset: item.tagOffset,
		tagSize: item.tagSize,
		tagType: item.tagType,
		variants: item.variants.map(
			(v: IRVariant): VariantPlan => ({
				name: v.name,
				type: irTypeToField(v.type),
				...(v.migrationMeta !== undefined && {
					migrationMeta: v.migrationMeta,
				}),
			}),
		),
		size: layout.size,
		align: layout.align,
		paddedSize: layout.paddedSize,
		...(item.description !== undefined && { description: item.description }),
		...(item.obsolete !== undefined && { obsolete: item.obsolete }),
		...(item.obsoleteReason !== undefined && {
			obsoleteReason: item.obsoleteReason,
		}),
		...(item.migrationMeta !== undefined && {
			migrationMeta: item.migrationMeta,
		}),
	};
}

function aliasToTypePlan(item: IRItem & { kind: "alias" }): AliasPlan {
	const layout = requireTypeLayout(item);
	return {
		kind: "alias",
		name: item.name,
		type: irTypeToField(item.type),
		size: layout.size,
		align: layout.align,
		paddedSize: layout.paddedSize,
		...(item.description !== undefined && { description: item.description }),
		...(item.obsolete !== undefined && { obsolete: item.obsolete }),
		...(item.obsoleteReason !== undefined && {
			obsoleteReason: item.obsoleteReason,
		}),
		...(item.migrationMeta !== undefined && {
			migrationMeta: item.migrationMeta,
		}),
	};
}

function fieldToFieldPlan(f: IRField, parentName: string): FieldPlan {
	if (!f.layout) {
		throw new Error(
			`computeLayoutPlan: field "${parentName}.${f.name}" missing layout after derive.`,
		);
	}
	const type = irTypeToField(f.type);
	const size = f.layout.size;
	return {
		name: f.name,
		type,
		offset: f.layout.offset,
		bitOffset: f.layout.bitOffset ?? 0,
		bitSize: f.layout.bitSize ?? size * 8,
		size,
		paddingAfter: f.layout.paddingAfter ?? 0,
		...(f.description !== undefined && { description: f.description }),
		...(f.obsolete !== undefined && { obsolete: f.obsolete }),
		...(f.obsoleteReason !== undefined && { obsoleteReason: f.obsoleteReason }),
		...(f.migrationMeta !== undefined && { migrationMeta: f.migrationMeta }),
	} as FieldPlan;
}

function irTypeToField(t: IRType): Field {
	switch (t.kind) {
		case "primitive":
			return {
				kind: "primitive",
				name: t.name,
				size: primitiveSize(t.name),
				align: primitiveAlign(t.name),
				paddedSize: primitiveSize(t.name),
				bitSize: t.bitSize ?? primitiveSize(t.name) * 8,
				popKind: t.popKind ?? "binary",
			} as Field;
		case "ref":
			return {
				kind: "reference",
				name: t.name,
				indirection: t.indirection ?? "inline",
				isForward: t.isForward ?? false,
			};
		case "array":
			return {
				kind: "array",
				item: irTypeToField(t.item),
				...(t.exactLength !== undefined && { exactLength: t.exactLength }),
				...(t.maxLength !== undefined && { maxLength: t.maxLength }),
			};
		case "string":
			return {
				kind: "string",
				...(t.maxLength !== undefined && { maxLength: t.maxLength }),
			};
		case "optional":
			return { kind: "optional", inner: irTypeToField(t.inner) };
		case "inlineStruct": {
			if (!t.layout) {
				throw new Error(
					"computeLayoutPlan: inlineStruct missing layout after derive.",
				);
			}
			return {
				kind: "inlineStruct",
				fields: t.fields.map((f) => fieldToFieldPlan(f, "<inline>")),
				size: t.layout.size,
				align: t.layout.align,
				paddedSize: t.layout.paddedSize,
			};
		}
		case "map":
			return {
				kind: "map",
				keyKind: t.keyKind,
				value: irTypeToField(t.value),
			};
		case "any":
			return {
				kind: "any",
				...(t.originalType !== undefined && { originalType: t.originalType }),
			};
		case "unit":
			return { kind: "unit" };
		case "bit":
			return {
				kind: "primitive",
				name: t.underlying,
				size: 1,
				align: 1,
				paddedSize: 1,
				bitSize: t.widthBits,
				popKind: "bitwise",
			} as Field;
		case "unknown":
			return { kind: "any", originalType: t.raw };
		case "unsupported":
			return { kind: "unit" };
	}
}

const PRIMITIVE_SIZE: Record<string, number> = {
	bool: 1,
	u8: 1,
	i8: 1,
	u16: 2,
	i16: 2,
	u32: 4,
	i32: 4,
	f32: 4,
	u64: 8,
	i64: 8,
	f64: 8,
	u128: 16,
	i128: 16,
};

function primitiveSize(name: string): number {
	return PRIMITIVE_SIZE[name] ?? 1;
}

function primitiveAlign(name: string): number {
	const size = PRIMITIVE_SIZE[name] ?? 1;
	return size === 16 ? 8 : size;
}
