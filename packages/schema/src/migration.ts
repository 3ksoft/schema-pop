import {
	EnumVariant,
	Field,
	FieldPlan,
	LayoutPlan,
	TypePlan,
	VariantPlan,
} from "./layout";
import { MappingProgram } from "./mapping";
/**
 * Diff classifier — compares two LayoutPlans (e.g., v1 vs v2) and produces
 * a structured description of every change. Per-language emit passes consume
 * this to decide what to auto-generate vs what to leave as a user-supplied
 * impl stub.
 *
 * The classifier is purely declarative — no code generation here. See the
 * migrations spec (docs/migrations-spec.md) for taxonomy and the strategy
 * for per-language emission.
 */

/** Resolution status for a change or aggregated type diff. */
export type DiffStatus =
	| "auto" /** schema-pop can emit a complete migration body */
	| "user-supplied" /** user must provide an impl in their target-language code */;

/** Strategy chosen for a newly-added field. */
export type AddedFieldDefault =
	| { kind: "literal"; value: unknown } // ArkType `"T = value"` default
	| { kind: "language-default" } // Rust Default::default(), TS undefined-ish
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
			program?: MappingProgram;
	  }
	| {
			kind: "changed";
			from: TypePlan;
			to: TypePlan;
			fieldChanges: FieldChange[];
			variantChanges: VariantChange[];
			aliasChange?: { from: Field; to: Field; status: DiffStatus };
			status: DiffStatus;
			program?: MappingProgram;
	  };

export type PlanDiff = {
	from: LayoutPlan;
	to: LayoutPlan;
	types: TypeDiff[];
	/** Aggregate status — `"auto"` only if every TypeDiff is auto-resolvable. */
	status: DiffStatus;
};

export const PRIMITIVE_RANK: Record<string, number> = {
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
