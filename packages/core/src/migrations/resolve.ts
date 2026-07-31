import type { Field, FieldPlan, LayoutPlan, TypePlan } from "@schema-pop/schema";
import type { FieldChange, PlanDiff, TypeDiff } from "./diff";
import {
	type Migration,
	type MigrationHooks,
	isWholeMapper,
	mapperFieldKeys,
} from "./runtime";

/**
 * Resolver — turns a raw `PlanDiff` plus the user's hook registry into a
 * language-neutral `MigrationPlan` (IR) that emitters consume, OR throws a
 * `MigrationError` listing every ambiguous change the user hasn't covered.
 *
 * This is where the two hard decisions from docs/migrations-plan.md live:
 *  - **Hard generation error**: any `user-supplied` change with no matching
 *    hook is collected and reported as a punch-list — generation refuses.
 *  - **Nested composition**: a field referencing a type that itself changed is
 *    emitted as `copyTransformed` (call the child's transform), computed via a
 *    transitive "dirty" fixpoint so deep struct graphs migrate correctly.
 */

/** How one `to`-field's value is produced from the v1 object. */
export type FieldOp =
	/** v2[to] = v1[from] — same value (identity, widen, reorder, plain copy). */
	| { kind: "copy"; to: string; from: string }
	/** v2[to] = transform<refType>(v1[from]) — referenced type also migrated. */
	| { kind: "copyTransformed"; to: string; from: string; refType: string }
	/** v2[to] = <literal> — new field with an ArkType default. */
	| { kind: "defaultLiteral"; to: string; value: unknown }
	/** v2[to] = zero value for `field.type` (0 / false / "" / []). */
	| { kind: "defaultZero"; to: string; field: FieldPlan }
	/** v2[to] = hooks[Type][to](v1) — user-supplied per-field mapper. */
	| { kind: "hookField"; to: string };

export type TypeMigration =
	/** Structurally identical (no own change, no dirty reference) — shallow copy. */
	| { kind: "identity"; name: string; toName: string }
	/** hooks[Type](v1) owns the whole conversion. */
	| { kind: "wholeHook"; name: string; toName: string }
	/** Per-field struct transform. */
	| { kind: "fields"; name: string; toName: string; ops: FieldOp[] }
	/** New type in v2 — no transform (no v1 input). */
	| { kind: "added"; toName: string }
	/** Removed in v2 — no transform. */
	| { kind: "removed"; name: string };

export type MigrationPlan = {
	from: LayoutPlan;
	to: LayoutPlan;
	types: TypeMigration[];
	/** v2 type names whose transform calls into a user hook (per-field or whole). */
	hookedTypes: string[];
};

/** One unresolved ambiguous change — becomes a line in the punch-list. */
export type MigrationGap = {
	type: string;
	detail: string;
};

export class MigrationError extends Error {
	constructor(public readonly gaps: MigrationGap[]) {
		super(
			`Cannot auto-generate migration — ${gaps.length} change(s) need a user hook:\n` +
				gaps.map((g) => `  - ${g.type}: ${g.detail}`).join("\n") +
				`\nProvide the missing logic via defineMigration(...) and pass it to resolveMigration.`,
		);
		this.name = "MigrationError";
	}
}

/** Collect the type names a field structurally references (recursing wrappers). */
function referencedTypeNames(field: Field, out: Set<string>): void {
	switch (field.kind) {
		case "reference":
			out.add((field as any).name);
			break;
		case "optional":
			referencedTypeNames((field as any).inner, out);
			break;
		case "array":
			referencedTypeNames((field as any).item, out);
			break;
		case "inlineStruct":
			for (const f of (field as any).fields)
				referencedTypeNames(f.type, out);
			break;
		default:
			break;
	}
}

/** Direct scalar reference target (not wrapped in array/optional), else null. */
function scalarRefTarget(field: Field): string | null {
	return field.kind === "reference" ? (field as any).name : null;
}

/** True if the field wraps a reference (array/optional of a ref, or inline). */
function wrapsReferenceTo(field: Field, dirty: Set<string>): boolean {
	if (field.kind === "reference") return false; // handled as scalar
	const refs = new Set<string>();
	referencedTypeNames(field, refs);
	for (const r of refs) if (dirty.has(r)) return true;
	return false;
}

/**
 * Compute the set of v2 type names that need a field-wise transform: those with
 * their own changes, plus (transitively) any type referencing a dirty type.
 * This is what makes nested struct graphs migrate — an otherwise-unchanged
 * parent whose child changed is still "dirty" and gets a real transform.
 */
function computeDirty(diff: PlanDiff): Set<string> {
	const dirty = new Set<string>();

	// Seed: types with their own changes (changed / renamed with changes).
	for (const td of diff.types) {
		if (td.kind === "changed" || td.kind === "renamed") dirty.add(td.to.name);
	}

	// Fixpoint: a type referencing a dirty type becomes dirty.
	const byName = new Map(diff.to.types.map((t) => [t.name, t]));
	let changed = true;
	while (changed) {
		changed = false;
		for (const t of diff.to.types) {
			if (dirty.has(t.name)) continue;
			if (t.kind !== "struct") continue;
			for (const f of t.fields) {
				const refs = new Set<string>();
				referencedTypeNames(f.type, refs);
				if ([...refs].some((r) => dirty.has(r))) {
					dirty.add(t.name);
					changed = true;
					break;
				}
			}
		}
	}
	void byName;
	return dirty;
}

/** Index a type-diff's field changes by the affected `to` field name. */
function fieldChangesByToName(
	changes: FieldChange[],
): Map<string, FieldChange> {
	const m = new Map<string, FieldChange>();
	for (const c of changes) {
		switch (c.kind) {
			case "added":
				m.set(c.field.name, c);
				break;
			case "renamed":
			case "reordered":
			case "type-widened":
			case "type-narrowed":
			case "type-changed":
				m.set(c.to.name, c);
				break;
			case "removed":
				break; // no `to` field
		}
	}
	return m;
}

/** Build the copy/copyTransformed op for an auto field, honoring nested refs. */
function copyOp(
	to: string,
	from: string,
	fieldType: Field,
	dirty: Set<string>,
): FieldOp {
	const ref = scalarRefTarget(fieldType);
	if (ref && dirty.has(ref)) {
		return { kind: "copyTransformed", to, from, refType: ref };
	}
	return { kind: "copy", to, from };
}

/**
 * Resolve a `PlanDiff` + hooks into a `MigrationPlan`. Throws `MigrationError`
 * with the full punch-list if any ambiguous change lacks a hook.
 */
export function resolveMigration(
	diff: PlanDiff,
	hooks: MigrationHooks = {},
): MigrationPlan {
	const dirty = computeDirty(diff);
	const gaps: MigrationGap[] = [];
	const hookedTypes = new Set<string>();
	const types: TypeMigration[] = [];

	const hookFor = (name: string): Migration | undefined => hooks[name];

	for (const td of diff.types) {
		if (td.kind === "added") {
			types.push({ kind: "added", toName: td.to.name });
			continue;
		}
		if (td.kind === "removed") {
			types.push({ kind: "removed", name: td.from.name });
			continue;
		}

		const toName = td.to.name;
		const fromName = "from" in td ? td.from.name : toName;
		const hook = hookFor(toName);

		// Whole-type escape hatch wins outright.
		if (hook && isWholeMapper(hook)) {
			hookedTypes.add(toName);
			types.push({ kind: "wholeHook", name: fromName, toName });
			continue;
		}

		// Unchanged and not dirty-by-reference → identity shallow copy.
		if (td.kind === "unchanged" && !dirty.has(toName)) {
			types.push({ kind: "identity", name: fromName, toName });
			continue;
		}

		// Only structs get an auto field-wise transform. Non-struct dirty types
		// (union/enum/alias with own changes, or referencing a dirty type) need a
		// whole-type hook — honest gap otherwise (auto union/alias transform is a
		// later phase; see docs/migrations-plan.md open questions).
		if (td.to.kind !== "struct") {
			if (dirty.has(toName)) {
				gaps.push({
					type: toName,
					detail: `${td.to.kind} changed — provide a whole-type defineMigration<...>((v1) => ...)`,
				});
			} else {
				types.push({ kind: "identity", name: fromName, toName });
			}
			continue;
		}

		// Struct transform: classify every v2 field.
		const changes =
			td.kind === "changed" || td.kind === "renamed"
				? [...td.fieldChanges]
				: [];
		const changeByTo = fieldChangesByToName(changes);
		const hookKeys = hook ? mapperFieldKeys(hook) : new Set<string>();
		const ops: FieldOp[] = [];
		let usesHook = false;

		const requireHook = (fieldName: string, detail: string): boolean => {
			if (hookKeys.has(fieldName)) {
				usesHook = true;
				ops.push({ kind: "hookField", to: fieldName });
				return true;
			}
			gaps.push({ type: toName, detail: `${detail} — add "${fieldName}" to defineMigration` });
			return false;
		};

		for (const tf of (td.to as any).fields as FieldPlan[]) {
			const ch = changeByTo.get(tf.name);

			// A field wrapping (array/optional/inline) a dirty ref can't be
			// auto-composed yet — require a hook rather than silently miscopy.
			const wrapsDirty = wrapsReferenceTo(tf.type, dirty);

			if (!ch) {
				// Unchanged field (or reordered-only) → copy, composing nested refs.
				if (wrapsDirty && !hookKeys.has(tf.name)) {
					requireHook(
						tf.name,
						`field '${tf.name}' wraps a changed type (array/optional of a migrated struct)`,
					);
					continue;
				}
				if (hookKeys.has(tf.name)) {
					usesHook = true;
					ops.push({ kind: "hookField", to: tf.name });
					continue;
				}
				ops.push(copyOp(tf.name, tf.name, tf.type, dirty));
				continue;
			}

			switch (ch.kind) {
				case "added": {
					if (ch.status === "auto") {
						if (ch.default.kind === "literal") {
							ops.push({
								kind: "defaultLiteral",
								to: tf.name,
								value: ch.default.value,
							});
						} else {
							ops.push({ kind: "defaultZero", to: tf.name, field: tf });
						}
					} else {
						requireHook(tf.name, `new field '${tf.name}' has no safe default`);
					}
					break;
				}
				case "renamed": {
					if (ch.status === "auto") {
						if (wrapsDirty) {
							requireHook(
								tf.name,
								`renamed field '${tf.name}' wraps a changed type`,
							);
						} else {
							ops.push(copyOp(tf.name, ch.oldName, tf.type, dirty));
						}
					} else {
						requireHook(
							tf.name,
							`field '${tf.name}' renamed with an incompatible type change`,
						);
					}
					break;
				}
				case "type-widened":
				case "reordered": {
					if (wrapsDirty) {
						requireHook(tf.name, `field '${tf.name}' wraps a changed type`);
					} else {
						ops.push(copyOp(tf.name, tf.name, tf.type, dirty));
					}
					break;
				}
				case "type-narrowed": {
					requireHook(
						tf.name,
						`field '${tf.name}' narrowed — needs a clamp/validation`,
					);
					break;
				}
				case "type-changed": {
					requireHook(
						tf.name,
						`field '${tf.name}' changed type structurally`,
					);
					break;
				}
			}
		}

		if (usesHook) hookedTypes.add(toName);
		types.push({ kind: "fields", name: fromName, toName, ops });
	}

	if (gaps.length > 0) throw new MigrationError(gaps);

	return {
		from: diff.from,
		to: diff.to,
		types,
		hookedTypes: [...hookedTypes],
	};
}
