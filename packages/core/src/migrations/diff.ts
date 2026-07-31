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
} from "@schema-pop/schema";

/**
 * Diff classifier — compares two LayoutPlans (e.g., v1 vs v2) and produces
 * a structured description of every change. The migration resolver / emitters
 * consume this to decide what to auto-generate vs what must be filled by a
 * user-supplied hook.
 *
 * The classifier is purely declarative — no code generation here. See
 * `docs/migrations-plan.md` for the taxonomy and the codec-level emit strategy.
 *
 * Rename detection relies on the `renamedFrom` marker metadata that the
 * analyzer propagates onto plan nodes (from `Renamed<T, "oldName">`). New-field
 * defaults come from the ArkType default the analyzer lifts into
 * `FieldPlan.defaultValue` (from `"T = value"`).
 */

/** Resolution status for a change or aggregated type diff. */
export type DiffStatus =
	| "auto" /** schema-pop can emit a complete migration body */
	| "user-supplied" /** user must provide a hook (data-transform function) */;

/** Strategy chosen for a newly-added field. */
export type AddedFieldDefault =
	| { kind: "literal"; value: unknown } // ArkType `"T = value"` default
	| { kind: "language-default" } // 0 / false / "" / [] — safe zero value
	| { kind: "user-supplied" }; // requires a hook because the type has no auto fallback

export type FieldChange =
	| {
			kind: "added";
			field: FieldPlan;
			default: AddedFieldDefault;
			status: DiffStatus;
	  }
	| { kind: "removed"; field: FieldPlan; status: DiffStatus }
	| {
			kind: "renamed";
			from: FieldPlan;
			to: FieldPlan;
			oldName: string;
			status: DiffStatus;
	  }
	| { kind: "reordered"; from: FieldPlan; to: FieldPlan; status: DiffStatus }
	| {
			kind: "type-widened";
			from: FieldPlan;
			to: FieldPlan;
			status: DiffStatus;
	  }
	| {
			kind: "type-narrowed";
			from: FieldPlan;
			to: FieldPlan;
			status: DiffStatus;
	  }
	| {
			kind: "type-changed";
			from: FieldPlan;
			to: FieldPlan;
			status: DiffStatus;
	  };

export type VariantChange =
	| { kind: "added"; variant: VariantPlan | EnumVariant; status: DiffStatus }
	| { kind: "removed"; variant: VariantPlan | EnumVariant; status: DiffStatus }
	| {
			kind: "renamed";
			from: VariantPlan | EnumVariant;
			to: VariantPlan | EnumVariant;
			oldName: string;
			status: DiffStatus;
	  };

export type TypeDiff =
	| { kind: "added"; to: TypePlan; status: DiffStatus }
	| { kind: "removed"; from: TypePlan; status: DiffStatus }
	| {
			kind: "unchanged";
			from: TypePlan;
			to: TypePlan;
	  }
	| {
			kind: "renamed";
			from: TypePlan;
			to: TypePlan;
			oldName: string;
			fieldChanges: FieldChange[];
			variantChanges: VariantChange[];
			aliasChange?: { from: Field; to: Field; status: DiffStatus };
			status: DiffStatus;
	  }
	| {
			kind: "changed";
			from: TypePlan;
			to: TypePlan;
			fieldChanges: FieldChange[];
			variantChanges: VariantChange[];
			aliasChange?: { from: Field; to: Field; status: DiffStatus };
			status: DiffStatus;
	  };

export type PlanDiff = {
	from: LayoutPlan;
	to: LayoutPlan;
	types: TypeDiff[];
	/** Aggregate status — `"auto"` only if every TypeDiff is auto-resolvable. */
	status: DiffStatus;
};

const PRIMITIVE_RANK: Record<string, number> = {
	bool: 0,
	u8: 1,
	i8: 1,
	u16: 2,
	i16: 2,
	u32: 3,
	i32: 3,
	f32: 3,
	u64: 4,
	i64: 4,
	f64: 4,
	u128: 5,
	i128: 5,
};

function primitiveRank(name: string): number | undefined {
	return PRIMITIVE_RANK[name];
}

/**
 * Compare two Field shapes structurally.
 * Returns one of: "equal", "widened", "narrowed", "changed".
 *  - "equal": identical (same kind + same parameters).
 *  - "widened": same kind, target is strictly larger (auto-derivable).
 *  - "narrowed": same kind, target is strictly smaller (user must clamp).
 *  - "changed": different kinds OR different references — needs a hook.
 */
function compareFields(
	from: Field,
	to: Field,
): "equal" | "widened" | "narrowed" | "changed" {
	if (from.kind !== to.kind) return "changed";

	switch (from.kind) {
		case "primitive": {
			const f = from as any;
			const t = to as any;
			if (f.name === t.name && f.bitSize === t.bitSize) return "equal";
			const fr = primitiveRank(f.name);
			const tr = primitiveRank(t.name);
			if (fr === undefined || tr === undefined) return "changed";
			// Don't treat int↔float or signed↔unsigned cross-family as widening.
			const sameFamily =
				f.name[0] === t.name[0] ||
				(f.name.startsWith("f") && t.name.startsWith("f"));
			if (!sameFamily) return "changed";
			if (tr > fr) return "widened";
			if (tr < fr) return "narrowed";
			return "equal";
		}
		case "reference": {
			const f = from as any;
			const t = to as any;
			return f.name === t.name ? "equal" : "changed";
		}
		case "string": {
			const f = from as any;
			const t = to as any;
			if (f.maxLength === t.maxLength) return "equal";
			if (
				f.maxLength !== undefined &&
				t.maxLength !== undefined &&
				t.maxLength > f.maxLength
			) {
				return "widened";
			}
			return "narrowed";
		}
		case "array": {
			const f = from as any;
			const t = to as any;
			const itemCmp = compareFields(f.item, t.item);
			if (itemCmp === "changed") return "changed";
			if (f.exactLength !== t.exactLength) return "changed";
			if (f.maxLength === t.maxLength && itemCmp === "equal") return "equal";
			if (
				f.maxLength !== undefined &&
				t.maxLength !== undefined &&
				t.maxLength >= f.maxLength &&
				itemCmp !== "narrowed"
			) {
				return "widened";
			}
			return "narrowed";
		}
		case "optional": {
			const f = from as any;
			const t = to as any;
			return compareFields(f.inner, t.inner);
		}
		case "map":
		case "any":
		case "unit":
			return "equal";
		case "inlineStruct": {
			// Inline structs are anonymous; equal only if shape matches exactly.
			// Anything else falls to "changed" — user hook required.
			const f = from as any;
			const t = to as any;
			if (f.fields.length !== t.fields.length) return "changed";
			for (let i = 0; i < f.fields.length; i++) {
				const a = f.fields[i] as FieldPlan;
				const b = t.fields[i] as FieldPlan;
				if (a.name !== b.name) return "changed";
				if (compareFields(a.type, b.type) !== "equal") return "changed";
			}
			return "equal";
		}
		default:
			return "changed";
	}
}

function classifyAddedField(field: FieldPlan): {
	default: AddedFieldDefault;
	status: DiffStatus;
} {
	if (field.defaultValue !== undefined) {
		return {
			default: { kind: "literal", value: field.defaultValue },
			status: "auto",
		};
	}
	// Primitive without default → language-native default (0 / false / etc.).
	// Auto-resolvable at the data-transform level.
	if (field.type.kind === "primitive") {
		return { default: { kind: "language-default" }, status: "auto" };
	}
	if (field.type.kind === "string" || field.type.kind === "array") {
		return { default: { kind: "language-default" }, status: "auto" };
	}
	// Reference / inline struct / map / any → can't safely default without
	// knowing the user's intent. Surface as user-supplied.
	return { default: { kind: "user-supplied" }, status: "user-supplied" };
}

/**
 * Pair fields from the `from`-struct with fields in the `to`-struct using:
 * 1. `to.field.renamedFrom` — explicit rename marker.
 * 2. Same name (default).
 * Returns paired field changes plus list of unmatched (added/removed).
 */
function diffStructFields(from: StructPlan, to: StructPlan): FieldChange[] {
	const changes: FieldChange[] = [];
	const fromByName = new Map(from.fields.map((f) => [f.name, f]));
	const usedFromNames = new Set<string>();
	// Track shared (preserved) fields so we can detect relative reorder
	// without false positives from adjacent add/remove.
	type SharedRef = {
		ffIdx: number;
		tfIdx: number;
		ff: FieldPlan;
		tf: FieldPlan;
	};
	const shared: SharedRef[] = [];

	// Pass 1: explicit renames (to.renamedFrom)
	for (let ti = 0; ti < to.fields.length; ti++) {
		const tf = to.fields[ti]!;
		const oldName = tf.renamedFrom;
		if (!oldName) continue;
		const ff = fromByName.get(oldName);
		if (!ff) {
			const addInfo = classifyAddedField(tf);
			changes.push({
				kind: "added",
				field: tf,
				default: addInfo.default,
				status: "user-supplied",
			});
			continue;
		}
		usedFromNames.add(oldName);
		const cmp = compareFields(ff.type, tf.type);
		const status: DiffStatus =
			cmp === "changed" || cmp === "narrowed" ? "user-supplied" : "auto";
		changes.push({ kind: "renamed", from: ff, to: tf, oldName, status });
		shared.push({
			ffIdx: from.fields.indexOf(ff),
			tfIdx: ti,
			ff,
			tf,
		});
	}

	// Pass 2: name-matched fields
	const fromIndex = new Map(from.fields.map((f, i) => [f.name, i]));
	for (let ti = 0; ti < to.fields.length; ti++) {
		const tf = to.fields[ti]!;
		if (tf.renamedFrom) continue; // already handled
		const ff = fromByName.get(tf.name);
		if (!ff) {
			const addInfo = classifyAddedField(tf);
			changes.push({
				kind: "added",
				field: tf,
				default: addInfo.default,
				status: addInfo.status,
			});
			continue;
		}
		usedFromNames.add(tf.name);
		shared.push({ ffIdx: fromIndex.get(tf.name)!, tfIdx: ti, ff, tf });
		const cmp = compareFields(ff.type, tf.type);
		if (cmp === "equal") {
			// Reorder check happens after Pass 3 (relative-order pass).
			continue;
		}
		if (cmp === "widened") {
			changes.push({
				kind: "type-widened",
				from: ff,
				to: tf,
				status: "auto",
			});
			continue;
		}
		if (cmp === "narrowed") {
			changes.push({
				kind: "type-narrowed",
				from: ff,
				to: tf,
				status: "user-supplied",
			});
			continue;
		}
		changes.push({
			kind: "type-changed",
			from: ff,
			to: tf,
			status: "user-supplied",
		});
	}

	// Pass 3: removed fields (in from, not consumed)
	for (const ff of from.fields) {
		if (usedFromNames.has(ff.name)) continue;
		changes.push({ kind: "removed", field: ff, status: "auto" });
	}

	// Pass 4: relative reorder among shared fields. Sort `shared` by tfIdx,
	// then check if the resulting ffIdx sequence is non-monotonic — that
	// indicates the user actually changed the source order. If only count
	// differs (add/remove shifted absolute positions), shared stays monotonic.
	const sortedByTo = [...shared].sort((a, b) => a.tfIdx - b.tfIdx);
	for (let i = 1; i < sortedByTo.length; i++) {
		const prev = sortedByTo[i - 1]!;
		const cur = sortedByTo[i]!;
		if (cur.ffIdx < prev.ffIdx) {
			// Only emit one reorder per type-pair to avoid noise; mark on
			// the first out-of-order field encountered.
			changes.push({
				kind: "reordered",
				from: cur.ff,
				to: cur.tf,
				status: "auto",
			});
			break;
		}
	}

	return changes;
}

function diffUnionVariants(from: UnionPlan, to: UnionPlan): VariantChange[] {
	const changes: VariantChange[] = [];
	const fromByName = new Map(from.variants.map((v) => [v.name, v]));
	const usedFromNames = new Set<string>();

	// Pass 1: explicit per-variant rename (to.variant.renamedFrom).
	for (const tv of to.variants) {
		const oldName = tv.renamedFrom;
		if (!oldName) continue;
		const fv = fromByName.get(oldName);
		if (!fv) {
			// Marker references a variant that doesn't exist in v1 — treat as
			// added but flag as user-supplied so the user notices.
			changes.push({ kind: "added", variant: tv, status: "user-supplied" });
			continue;
		}
		usedFromNames.add(oldName);
		changes.push({
			kind: "renamed",
			from: fv,
			to: tv,
			oldName,
			status: "auto",
		});
	}

	// Pass 2: name-matched variants.
	for (const tv of to.variants) {
		if (tv.renamedFrom) continue;
		const fv = fromByName.get(tv.name);
		if (!fv) {
			changes.push({ kind: "added", variant: tv, status: "auto" });
			continue;
		}
		usedFromNames.add(tv.name);
	}

	// Pass 3: removed variants (lossy until OnRemoval ships).
	for (const fv of from.variants) {
		if (usedFromNames.has(fv.name)) continue;
		changes.push({ kind: "removed", variant: fv, status: "user-supplied" });
	}
	return changes;
}

function diffEnumVariants(from: EnumPlan, to: EnumPlan): VariantChange[] {
	const changes: VariantChange[] = [];
	const fromByName = new Map(from.variants.map((v) => [v.name, v]));
	const usedFromNames = new Set<string>();

	// Pass 1: explicit per-variant rename.
	for (const tv of to.variants) {
		const oldName = tv.renamedFrom;
		if (!oldName) continue;
		const fv = fromByName.get(oldName);
		if (!fv) {
			changes.push({ kind: "added", variant: tv, status: "user-supplied" });
			continue;
		}
		usedFromNames.add(oldName);
		changes.push({
			kind: "renamed",
			from: fv,
			to: tv,
			oldName,
			status: "auto",
		});
	}

	// Pass 2: name-matched.
	for (const tv of to.variants) {
		if (tv.renamedFrom) continue;
		const fv = fromByName.get(tv.name);
		if (!fv) {
			changes.push({ kind: "added", variant: tv, status: "auto" });
			continue;
		}
		usedFromNames.add(tv.name);
	}

	// Pass 3: removed.
	for (const fv of from.variants) {
		if (usedFromNames.has(fv.name)) continue;
		changes.push({ kind: "removed", variant: fv, status: "user-supplied" });
	}
	return changes;
}

function aggregateStatus(items: { status: DiffStatus }[]): DiffStatus {
	for (const it of items)
		if (it.status === "user-supplied") return "user-supplied";
	return "auto";
}

/**
 * Diff a single (from, to) type pair already matched by name or via Renamed.
 * Returns either an "unchanged", "renamed", or "changed" TypeDiff.
 */
function diffMatchedTypes(
	from: TypePlan,
	to: TypePlan,
	oldName: string | null,
): TypeDiff {
	const baseRenamed = oldName !== null && oldName !== to.name;

	if (from.kind !== to.kind) {
		// Different kinds (e.g., struct → union) — fundamentally a structural
		// change. Report as "changed" with empty change lists; user must
		// supply a full conversion.
		return baseRenamed
			? {
					kind: "renamed",
					from,
					to,
					oldName: oldName!,
					fieldChanges: [],
					variantChanges: [],
					status: "user-supplied",
				}
			: {
					kind: "changed",
					from,
					to,
					fieldChanges: [],
					variantChanges: [],
					status: "user-supplied",
				};
	}

	let fieldChanges: FieldChange[] = [];
	let variantChanges: VariantChange[] = [];
	let aliasChange: { from: Field; to: Field; status: DiffStatus } | undefined;

	if (from.kind === "struct") {
		fieldChanges = diffStructFields(from as StructPlan, to as StructPlan);
	} else if (from.kind === "union") {
		variantChanges = diffUnionVariants(from as UnionPlan, to as UnionPlan);
	} else if (from.kind === "enum") {
		variantChanges = diffEnumVariants(from as EnumPlan, to as EnumPlan);
	} else if (from.kind === "alias") {
		const fromType = (from as AliasPlan).type;
		const toType = (to as AliasPlan).type;
		const cmp = compareFields(fromType, toType);
		if (cmp !== "equal") {
			aliasChange = {
				from: fromType,
				to: toType,
				status: cmp === "widened" ? "auto" : "user-supplied",
			};
		}
	}

	const allChanges = [
		...fieldChanges,
		...variantChanges,
		...(aliasChange ? [aliasChange] : []),
	];
	const noChanges = allChanges.length === 0;

	if (noChanges && !baseRenamed) {
		return { kind: "unchanged", from, to };
	}

	const status = aggregateStatus(allChanges);

	return baseRenamed
		? {
				kind: "renamed",
				from,
				to,
				oldName: oldName!,
				fieldChanges,
				variantChanges,
				...(aliasChange ? { aliasChange } : {}),
				status,
			}
		: {
				kind: "changed",
				from,
				to,
				fieldChanges,
				variantChanges,
				...(aliasChange ? { aliasChange } : {}),
				status,
			};
}

/**
 * Top-level diff: classify every type pair across `from` → `to`.
 * Pairing rules:
 *  1. If `to.renamedFrom` is set, pair with that name in `from`.
 *  2. Otherwise pair by `to.name === from.name`.
 *  3. Unpaired `from` types → "removed". Unpaired `to` types → "added".
 */
export function diffPlans(from: LayoutPlan, to: LayoutPlan): PlanDiff {
	const fromByName = new Map(from.types.map((t) => [t.name, t]));
	const usedFromNames = new Set<string>();
	const types: TypeDiff[] = [];

	// Pass 1: explicit type-level renames
	for (const tt of to.types) {
		const oldName = tt.renamedFrom;
		if (!oldName) continue;
		const ft = fromByName.get(oldName);
		if (!ft) {
			// Renamed marker references a type that doesn't exist in `from`
			// — treat as added, but flag as user-supplied so the user notices.
			types.push({ kind: "added", to: tt, status: "user-supplied" });
			continue;
		}
		usedFromNames.add(oldName);
		types.push(diffMatchedTypes(ft, tt, oldName));
	}

	// Pass 2: name-matched
	for (const tt of to.types) {
		if (tt.renamedFrom) continue;
		const ft = fromByName.get(tt.name);
		if (!ft) {
			// New type — auto if it has no inputs from v1.
			types.push({ kind: "added", to: tt, status: "auto" });
			continue;
		}
		usedFromNames.add(tt.name);
		types.push(diffMatchedTypes(ft, tt, null));
	}

	// Pass 3: removed
	for (const ft of from.types) {
		if (usedFromNames.has(ft.name)) continue;
		types.push({ kind: "removed", from: ft, status: "auto" });
	}

	const withStatus = types.filter(
		(t): t is Exclude<TypeDiff, { kind: "unchanged" }> =>
			t.kind !== "unchanged",
	);
	return {
		from,
		to,
		types,
		status: aggregateStatus(withStatus),
	};
}
