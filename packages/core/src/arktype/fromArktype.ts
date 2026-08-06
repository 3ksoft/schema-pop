import type {
	BaseRoot,
	DomainNode,
	IntersectionNode,
	StructureNode,
	UnionNode,
	UnitNode,
} from "@ark/schema";
import type { ExtractionContext, PopModule } from "@schema-pop/schema";
import {
	ArkMeta,
	Base,
	binary,
	PopSchema,
	PopSchemaSettings,
	PopSchemaSettingsDefaults,
	PopType,
} from "@schema-pop/schema";
import { type } from "arktype";
import { getConstraints } from "./shared";

const ANY = PopType.assert({
	type: "any",
	description: "Could not resolve type",
});

function assertPopType(field: unknown, ctx: ExtractionContext): PopType {
	const valid = PopType(field);
	if (valid instanceof type.errors) {
		for (const error of valid) {
			ctx.errors.push(error.toString());
		}
		return { type: "any" };
	}
	return valid;
}

export function fromModule(
	module: PopModule,
	options?: PopSchemaSettings,
): ExtractionContext {
	const ctx: ExtractionContext = {
		warnings: [],
		errors: [],
		map: new Map(),
		module,
		schema: PopSchema.assert({
			...PopSchemaSettingsDefaults,
			...options,
			types: {},
			functions: {},
		}),
	};

	// Skip generic definitions (arktype `GenericRoot`, e.g. the `Renamed` /
	// `Obsolete` / `Scale` markers a user adds to their scope so `"Renamed<...>"`
	// resolves). They're resolvers, not data types — a Type always has a `.kind`,
	// a generic never does. Without this they leak into the plan as bogus
	// `undefined`-typed aliases and every exporter emits junk for them.
	const isDataType = (exType: any): boolean =>
		exType != null && exType.kind !== undefined;

	for (const [name, exType] of Object.entries(module)) {
		if (!isDataType(exType)) continue;
		ctx.map.set(exType.internal, name);
	}

	for (const [name, exType] of Object.entries(module)) {
		if (!isDataType(exType)) continue;
		// arktype canonicalizes object propsByKey and union branches into
		// alphabetical order, which destroys the field-declaration order
		// the user wrote in `scope({...})`. The raw definition is preserved
		// on the scope as `scope.aliases[name]` and is reachable from any
		// exported type via `.$`. We thread that raw def through extraction
		// so we can re-derive the original ordering at every nesting level.
		const rawDef = (exType as { $?: { aliases?: Record<string, unknown> } })
			.$?.aliases?.[name];
		ctx.schema.types[name] = extractBaseRoot(
			name,
			exType.internal,
			ctx,
			rawDef,
		);
	}

	return ctx;
}

// Parses an arktype string union of unit literals into the user's declared
// variant order. Returns null when the string isn't a clean `'a' | 'b'`
// (e.g. it mixes a non-literal branch like `'a' | number`) — caller then
// falls back to arktype's canonical (alphabetical) order.
function parseStringUnionOrder(raw: string): string[] | null {
	const parts = raw.split("|").map((p) => p.trim());
	const result: string[] = [];
	for (const part of parts) {
		const m = part.match(/^(['"])(.*)\1$/);
		if (!m) return null;
		result.push(m[2]!);
	}
	return result;
}

function extractBaseRoot(
	label: string,
	root: BaseRoot,
	ctx: ExtractionContext,
	rawDef?: unknown,
): PopType & ArkMeta {
	if (!root.kind) return ANY;
	const linkedName = ctx.map.get(root);

	// ArkType preserves named references by reusing the exported type's internal
	// node object inside fields/union branches. Keep that identity as a link
	// instead of flattening the referenced object into an anonymous inline type.
	// Comparing node identity avoids false links between structurally-equal types.
	if (linkedName && linkedName !== label) {
		return assertPopType(
			{
				type: "link",
				target: linkedName,
				...ArkMeta.assert(root.meta),
				label,
			},
			ctx,
		);
	}

	let popType: PopType | null = null;

	if (root.hasKind("morph")) {
		const inputNode = (root as any).in ?? (root.inner as any)?.in;
		if (inputNode) {
			popType = extractBaseRoot(label, inputNode as BaseRoot, ctx, rawDef);
		}
	}
	else if (root.hasKind("domain")) popType = extractDomain(root, ctx);
	else if (root.hasKind("union"))
		popType = extractUnion(label, root, ctx, rawDef);
	else if (root.hasKind("unit")) popType = extractUnit(root, ctx);
	else if (root.hasKind("intersection")) {
		// popType = extractIntersection(label, root, ctx);
		if (root.structure?.sequence) {
			popType = extractSequence(root, root.structure, ctx);
		} else if (root.structure?.props) {
			popType = extractObject(root, root.structure, ctx, rawDef);
		} else {
			popType = extractConstrained(root, ctx);
		}
	}

	if (!popType) return ANY;

	return assertPopType(
		{ ...popType, ...ArkMeta.assert(root.meta), label },
		ctx,
	);
}

function extractDomain(node: DomainNode, ctx: ExtractionContext): PopType {
	return assertPopType({ type: node.domain }, ctx);
}

function extractSequence(
	node: IntersectionNode,
	structure: StructureNode,
	ctx: ExtractionContext,
): PopType {
	if (structure?.sequence) {
		const elementNode = structure.sequence.inner.variadic;
		if (elementNode) {
			return assertPopType(
				{
					type: "array",
					...getConstraints(node),
					item: extractBaseRoot("Item", elementNode as BaseRoot, ctx),
				},
				ctx,
			);
		}
	}
	return ANY;
}

function extractObject(
	node: IntersectionNode,
	structure: StructureNode,
	ctx: ExtractionContext,
	rawDef?: unknown,
): PopType & ArkMeta {
	const props = structure?.propsByKey;
	if (props) {
		const fields: Record<string, PopType> = {};

		// arktype's `propsByKey` is alphabetized. The raw user definition
		// (when it's a plain object literal) preserves declaration order in
		// its own `Object.keys`. Use those keys as the iteration order so the
		// resulting `fields` dict — and thus every downstream layout/exporter —
		// follows what the user actually wrote. Drop the schema-pop spread
		// key `"..."` because arktype has already inlined those props.
		const rawDefObj =
			rawDef &&
				typeof rawDef === "object" &&
				!Array.isArray(rawDef) &&
				!(rawDef instanceof RegExp)
				? (rawDef as Record<string, unknown>)
				: null;
		const propKeys = (() => {
			if (!rawDefObj) return Object.keys(props);
			const seen = new Set<string>();
			const ordered: string[] = [];
			for (const k of Object.keys(rawDefObj)) {
				if (k === "...") continue;
				const trimmed = k.endsWith("?") ? k.slice(0, -1) : k;
				if (trimmed in props && !seen.has(trimmed)) {
					ordered.push(trimmed);
					seen.add(trimmed);
				}
			}
			// Spread-inlined props live in `propsByKey` but not in the raw
			// object's own keys — append them in arktype's canonical order
			// after the explicitly declared ones.
			for (const k of Object.keys(props)) {
				if (!seen.has(k)) ordered.push(k);
			}
			return ordered;
		})();

		for (const key of propKeys) {
			const exType = props[key];
			if (!exType) continue;
			// arktype prop shapes (verified via `prop.json`, the documented
			// serialization API):
			//   `x: T`     → RequiredNode      → required, no default
			//   `x: T = V` → OptionalNode + `json.default = V`
			//   `x?: T`    → OptionalNode, no `default` key in json
			//
			// A defaulted prop is `kind === "optional"` in arktype's model
			// but binary layout treats it as a concrete primitive with a
			// fallback — mark `required = true` so the analyzer doesn't
			// wrap it in `optional`. The fallback flows through
			// `extracted.default` for the analyzer to lift into
			// `migrationMeta.defaultValue`.
			const propJson = (exType as { json?: { default?: unknown } })?.json;
			const hasDefault = !!propJson && "default" in propJson;
			const defaultValue = hasDefault ? propJson.default : undefined;
			const required = exType?.kind === "required" || hasDefault;
			const value = exType?.inner.value;
			if (value) {
				// Pick the child rawDef by raw-key (which may carry a `?` suffix
				// for optional props) so nested objects also keep declaration
				// order at every level.
				const childRawDef = rawDefObj
					? (rawDefObj[key] ?? rawDefObj[`${key}?`])
					: undefined;
				const extracted = extractBaseRoot(
					key,
					value as BaseRoot,
					ctx,
					childRawDef,
				);
				extracted.required = required;
				const isReadableDefault =
					hasDefault &&
					defaultValue !== undefined &&
					typeof defaultValue !== "function" &&
					!(typeof defaultValue === "string" && defaultValue.startsWith("$ark"));

				if (isReadableDefault) {
					(extracted as { default?: unknown }).default = defaultValue;
				}
				fields[key] = extracted;
			}
		}
		return assertPopType({ type: "object", fields }, ctx);
	}
	return ANY;
}

function extractConstrained(
	node: IntersectionNode,
	ctx: ExtractionContext,
): PopType {
	const i = node.inner;
	if (i.domain) {
		const result: any = { type: i.domain.domain };
		if (i.min) result.min = i.min.rule;
		if (i.max) result.max = i.max.rule;
		if (i.minLength) result.minLength = i.minLength.rule;
		if (i.maxLength) result.maxLength = i.maxLength.rule;
		if (i.pattern) result.pattern = i.pattern;
		if (i.divisor) result.step = i.divisor.rule;
		return assertPopType(result, ctx);
	}
	return ANY;
}

export function extractIntersection(
	name: string,
	node: IntersectionNode,
	ctx: ExtractionContext,
): PopType & ArkMeta {
	const structure = node.structure;
	if (structure) {
		if (structure.sequence) {
			const elementNode = structure.sequence.inner.variadic;
			if (elementNode) {
				return assertPopType(
					{
						type: "array",
						...getConstraints(node),
						item: extractBaseRoot("Item", elementNode as BaseRoot, ctx),
					},
					ctx,
				);
			}
		}

		const props = structure?.propsByKey;
		if (props) {
			const fields: Record<string, PopType> = {};
			for (const [key, exType] of Object.entries(props)) {
				const required = exType?.kind === "required";
				const value = exType?.inner.value;
				if (value) {
					const extracted = extractBaseRoot(key, value as BaseRoot, ctx);
					extracted.required = required;
					fields[key] = extracted;
				}
			}
			return assertPopType({ type: "object", fields }, ctx);
		}
	}

	const i = node.inner;
	if (i.domain) {
		const result: any = { type: i.domain.domain };
		if (i.min) result.min = i.min.rule;
		if (i.max) result.max = i.max.rule;
		if (i.minLength) result.minLength = i.minLength.rule;
		if (i.maxLength) result.maxLength = i.maxLength.rule;
		if (i.pattern) result.pattern = i.pattern;
		if (i.divisor) result.step = i.divisor.rule;
		return assertPopType(result, ctx);
	}

	throw new Error(
		`Unhandled intersection structure for node: ${node.expression}`,
	);
}

function extractUnion(
	name: string,
	node: UnionNode,
	ctx: ExtractionContext,
	rawDef?: unknown,
): PopType {
	const branches = node.branches;
	const isBool =
		branches.length === 2 &&
		branches.every((b) => b.hasKind("unit") && typeof b.unit === "boolean");

	if (isBool) return assertPopType({ type: "boolean" }, ctx);

	const isEnum =
		branches.length > 0 && branches.every((b) => b.hasKind("unit"));
	if (isEnum) {
		// Arktype sorts union branches alphabetically by canonicalization,
		// which silently renumbers enum variants away from the order the
		// user typed. When the raw definition is a string like
		// `"'distance' | 'bending' | 'area' | 'anchor'"`, parse it to
		// recover the declaration order before assigning indices.
		type BranchT = (typeof branches)[number];
		let orderedBranches: readonly BranchT[] = branches;
		if (typeof rawDef === "string") {
			const orderedNames = parseStringUnionOrder(rawDef);
			if (orderedNames) {
				const byKey = new Map<string, BranchT>();
				for (const b of branches) {
					const val = (b as UnitNode).unit ?? (b as UnitNode).compiledValue;
					byKey.set(String(val), b);
				}
				const reordered: BranchT[] = [];
				const consumed = new Set<string>();
				for (const n of orderedNames) {
					const hit = byKey.get(n);
					if (hit) {
						reordered.push(hit);
						consumed.add(n);
					}
				}
				// Tolerate any branch we didn't find in the raw text (defensive
				// for edge cases like escaped quotes) by appending in arktype's
				// canonical order.
				for (const b of branches) {
					const val = String(
						(b as UnitNode).unit ?? (b as UnitNode).compiledValue,
					);
					if (!consumed.has(val)) reordered.push(b);
				}
				if (reordered.length === branches.length) orderedBranches = reordered;
			}
		}
		return assertPopType(
			{
				type: "enum",
				options: orderedBranches.map((b) => {
					const raw = (b as UnitNode).unit ?? (b as UnitNode).compiledValue;
					const value =
						typeof raw === "string" || typeof raw === "number"
							? raw
							: String(raw);
					return {
						label: String(value),
						value,
						...(typeof raw === "string" ? { symbol: raw } : {}),
					};
				}),
			},
			ctx,
		);
	}

	const variants: PopType[] = [];
	let i = 1;
	for (const branch of branches) {
		const variantName = name ? `${name}Variant${i}` : `Variant${i}`;
		variants.push(extractBaseRoot(variantName, branch as BaseRoot, ctx));
		i++;
	}

	return assertPopType(
		{
			type: "union",
			discriminant: node.discriminant ? node.discriminant.path.join(".") : "",
			variants: variants,
		},
		ctx,
	);
}

function extractUnit(node: UnitNode, ctx: ExtractionContext): PopType {
	const value = String(node.unit);
	return assertPopType(
		{
			type: "symbol",
			size: 1,
			binaryType: "u8",
			value,
			symbol: value,
		},
		ctx,
	);
}
