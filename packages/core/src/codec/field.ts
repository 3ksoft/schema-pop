/**
 * Bidirectional codec between arktype `Type` objects and the form-field
 * descriptor tree defined in `fields.pop.ts`.
 *
 * - `getArkType(field)` — FormField → arktype Type (for validation / schema gen)
 * - `fromArktype(t, opts)` — arktype Type → FormField (for roundtripping pop.ts scopes)
 *
 * Named `FormField` internally to disambiguate from the binary-layout `Field`
 * exported by `schema/layout.ts`.
 */

import { type Type, type } from "arktype";
import type { FormField, FormSchema } from "../schema/fields.pop";

export type { FormField, FormSchema };

// ── getArkType ────────────────────────────────────────────────────────────────

/**
 * Encode a `FormField` descriptor as an arktype `Type` suitable for runtime
 * validation or JSON-schema generation.
 */
export function getArkType(def: FormField): Type<any, any> {
	if (!def) return type("unknown");
	let resType: Type<any, any>;
	switch (def.type) {
		case "file": {
			resType = type({ path: "string", name: "string", ext: "string" });
			break;
		}
		case "image": {
			resType = type({
				path: "string",
				name: "string",
				ext: "string",
				width: "number",
				height: "number",
			});
			break;
		}
		case "number": {
			let t = type("number");
			if (typeof def.min === "number") t = t.atLeast(def.min);
			if (typeof def.max === "number") t = t.atMost(def.max);
			// `divisibleBy` is integer-only — fractional step values used as UI
			// snapping intervals would throw.
			if (
				typeof def.step === "number" &&
				def.step > 0 &&
				Number.isInteger(def.step)
			)
				t = t.divisibleBy(def.step);
			resType = t;
			break;
		}
		case "boolean": {
			resType = type("boolean");
			break;
		}
		case "enum": {
			const options: string[] = (def.options ?? []).map((o: any) =>
				typeof o === "string" ? `'${o}'` : `'${o.value}'`,
			);
			resType =
				options.length === 0
					? type("string")
					: type(options.join(" | ") as any);
			break;
		}
		case "array": {
			let t: Type<any, any> = def.item
				? (getArkType(def.item as FormField).array() as Type<any, any>)
				: (type("unknown[]") as Type<any, any>);
			if (typeof def.minItems === "number")
				t = (t as any).atLeastLength(def.minItems);
			if (typeof def.maxItems === "number")
				t = (t as any).atMostLength(def.maxItems);
			resType = t;
			break;
		}
		case "object": {
			const result: Record<string, Type> = {};
			if (def.fields) {
				for (const [key, field] of Object.entries(def.fields)) {
					const k = (field as any).required === false ? `${key}?` : key;
					result[k] = getArkType(field as FormField);
				}
			}
			resType = type(result);
			break;
		}
		case "string":
		case "text": {
			let t: Type<any, any> = type("string");
			if (typeof def.minLength === "number")
				t = (t as any).atLeastLength(def.minLength);
			if (typeof def.maxLength === "number")
				t = (t as any).atMostLength(def.maxLength);
			if (typeof def.pattern === "string" && def.pattern.length > 0) {
				try {
					t = (t as any).matching(new RegExp(def.pattern));
				} catch {}
			}
			resType = t;
			break;
		}
		case "any":
			resType = type("unknown.any");
			break;
		case "link":
			// link target rides on a dedicated `ref` meta key. We use `object` as
			// the carrier because arktype optimises unknown-as-array-item by
			// dropping the `sequence` slot, which would strip the meta.
			resType = type("object").configure({
				ref: (def as any).target ?? "",
			} as any);
			break;
		default:
			resType = type("unknown");
			break;
	}

	if (def.description) resType = resType.describe(def.description);
	if (def.default !== undefined)
		resType = resType.configure({ default: def.default } as any);

	const meta: Record<string, unknown> = {};
	const da = def as any;
	if (da.popKind) meta["SCHEMA_POP_KIND"] = da.popKind;
	if (typeof da.size === "number") meta["size"] = da.size;
	if (typeof da.align === "number") meta["align"] = da.align;
	if (da.binaryType) meta["type"] = da.binaryType;
	if (typeof da.scale === "number") meta["scale"] = da.scale;
	if (typeof da.addr === "number") meta["addr"] = da.addr;
	if (da.isBinary !== undefined) meta["isBinary"] = da.isBinary;
	if (da.obsolete) meta["obsolete"] = true;
	if (da.obsoleteReason) meta["obsoleteReason"] = da.obsoleteReason;
	if (da.renamedFrom) meta["renamedFrom"] = da.renamedFrom;
	if (Object.keys(meta).length > 0) resType = resType.configure(meta as any);

	return resType;
}

// ── fromArktype ───────────────────────────────────────────────────────────────

export type FromArktypeOpts = {
	label?: string;
	/** Pass `scope.export()` to turn structured alias shapes into link refs. */
	scopeExports?: Record<string, Type<any, any>>;
	scopeId?: string;
	aliases?: string[];
	/** Don't link-replace this alias (when decoding the alias itself). */
	skipName?: string;
};

/**
 * Decode an arktype `Type` (via its canonical `.json`) into a `FormField`
 * descriptor. Lossless within the meta + validators that `getArkType` emits.
 *
 * Pass `scopeExports` (result of `scope.export()`) to make structured alias
 * references round-trip as `{ type: "link", target: "#/schemas/<id>/<name>" }`
 * instead of inlining the resolved shape.
 */
export function fromArktype(
	t: Type<any, any>,
	opts: FromArktypeOpts = {},
): FormField {
	const label = opts.label ?? "Field";
	const registry = opts.scopeExports
		? buildAliasRegistry(
				opts.scopeExports,
				opts.scopeId ?? "schema",
				opts.aliases,
				opts.skipName ?? label,
			)
		: null;
	return jsonToField((t as any).json, label, registry);
}

// ── private helpers ───────────────────────────────────────────────────────────

type AliasRegistry = {
	scopeId: string;
	byHash: Map<string, string>;
	skipName: string;
};

function buildAliasRegistry(
	exports: Record<string, Type<any, any>>,
	scopeId: string,
	aliases: string[] | undefined,
	skipName: string,
): AliasRegistry {
	const byHash = new Map<string, string>();
	const names = aliases ?? Object.keys(exports);
	for (const name of names) {
		const t = exports[name] as any;
		if (!t || typeof t.json !== "object" || t.json === null) continue;
		if (!aliases && !isStructuredJson(t.json)) continue;
		const hash = canonicalize(t.json);
		if (byHash.has(hash)) continue;
		byHash.set(hash, name);
	}
	return { scopeId, byHash, skipName };
}

function isStructuredJson(json: any): boolean {
	if (Array.isArray(json)) return true;
	if (json && typeof json === "object") {
		if (json.domain === "object") return true;
		if (json.proto === "Array") return true;
		if (Array.isArray(json.branches)) return true;
	}
	return false;
}

function canonicalize(json: any): string {
	if (json === null || typeof json !== "object") return JSON.stringify(json);
	if (Array.isArray(json)) return "[" + json.map(canonicalize).join(",") + "]";
	const keys = Object.keys(json).sort();
	return (
		"{" +
		keys
			.map((k) => JSON.stringify(k) + ":" + canonicalize((json as any)[k]))
			.join(",") +
		"}"
	);
}

function jsonToField(
	json: any,
	label: string,
	registry: AliasRegistry | null = null,
): FormField {
	// Recursive-alias reference: arktype emits "$AliasName" to avoid cycles.
	if (typeof json === "string" && json.startsWith("$") && registry) {
		const name = json.slice(1);
		return {
			label,
			type: "link",
			target: `#/schemas/${registry.scopeId}/${name}`,
		} as FormField;
	}

	// Alias-aware lookup: structured nodes matching a registered alias's hash
	// become a link instead of being inlined.
	if (registry && json && typeof json === "object" && isStructuredJson(json)) {
		const match = registry.byHash.get(canonicalize(json));
		if (match && match !== registry.skipName) {
			return {
				label,
				type: "link",
				target: `#/schemas/${registry.scopeId}/${match}`,
			} as FormField;
		}
	}

	// Bare string shorthand ("string", "number", ...).
	if (typeof json === "string") {
		return jsonToField({ domain: json }, label, registry);
	}

	// Node carrying a `ref` meta key is a forward-encoded link.
	if (json && typeof json === "object" && !Array.isArray(json)) {
		const earlyMeta = readMeta((json as any).meta);
		if (typeof earlyMeta.ref === "string" && earlyMeta.ref.length > 0) {
			const linked = {
				label,
				type: "link",
				target: earlyMeta.ref,
			} as FormField;
			const { ref: _r, ...earlyMetaWithoutRef } = earlyMeta;
			applyMeta(linked, earlyMetaWithoutRef);
			return linked;
		}
	}

	// `{}` or `{meta:...}` only → unknown.any.
	if (
		json &&
		typeof json === "object" &&
		!Array.isArray(json) &&
		Object.keys(json).filter((k) => k !== "meta").length === 0
	) {
		const f: FormField = { label, type: "any" } as FormField;
		applyMeta(f, readMeta((json as any).meta));
		return f;
	}

	// Union as bare array.
	if (Array.isArray(json)) {
		if (json.every((n) => n && "unit" in n)) {
			return literalsToField(json, label, undefined);
		}
		const first = jsonToField(json[0], label, registry);
		const desc = `union of ${json.length} variants (first variant kept)`;
		const existing = (first as any).description;
		(first as any).description = existing ? `${existing}; ${desc}` : desc;
		return first;
	}

	// Union wrapped as `{branches: [...], meta?}`.
	if (
		json &&
		typeof json === "object" &&
		Array.isArray((json as any).branches)
	) {
		const branches = (json as any).branches as any[];
		const rootMeta = readMeta((json as any).meta);
		if (branches.every((b) => b && "unit" in b)) {
			return literalsToField(branches, label, rootMeta);
		}
		const first = jsonToField(branches[0], label, registry);
		applyMeta(first, rootMeta);
		return first;
	}

	if (!json || typeof json !== "object") {
		return { label, type: "any" } as FormField;
	}

	const fromMeta = readMeta((json as any).meta);
	const domainStr = unwrapDomain(json);

	let field: FormField;

	if ((json as any).proto === "Array") {
		const arr: any = {
			label,
			type: "array",
			item: jsonToField((json as any).sequence, "Item", registry),
		};
		const minLen = unwrapNumber((json as any).minLength);
		const maxLen = unwrapNumber((json as any).maxLength);
		if (minLen !== undefined) arr.minItems = minLen;
		if (maxLen !== undefined) arr.maxItems = maxLen;
		field = arr;
	} else if (domainStr === "object") {
		const fields: Record<string, FormField> = {};
		for (const r of (json as any).required ?? []) {
			fields[r.key] = {
				...jsonToField(r.value, r.key, registry),
				required: true,
			} as any;
		}
		for (const o of (json as any).optional ?? []) {
			const sub: any = {
				...jsonToField(o.value, o.key, registry),
				required: false,
			};
			if (o.default !== undefined) sub.default = o.default;
			fields[o.key] = sub;
		}
		field = { label, type: "object", fields } as FormField;
	} else if (domainStr === "string") {
		const s: any = { label, type: "string" };
		const minLen = unwrapNumber((json as any).minLength);
		const maxLen = unwrapNumber((json as any).maxLength);
		if (minLen !== undefined) s.minLength = minLen;
		if (maxLen !== undefined) s.maxLength = maxLen;
		const pat = (json as any).pattern;
		if (Array.isArray(pat) && pat.length > 0) s.pattern = String(pat[0]);
		else if (typeof pat === "string") s.pattern = pat;
		field = s;
	} else if (domainStr === "number") {
		const n: any = { label, type: "number" };
		const minN = unwrapNumber((json as any).min);
		const maxN = unwrapNumber((json as any).max);
		const div = unwrapNumber((json as any).divisor);
		if (minN !== undefined) n.min = minN;
		if (maxN !== undefined) n.max = maxN;
		if (div !== undefined) n.step = div;
		field = n;
	} else if (domainStr === "bigint") {
		// No bigint in FormField; binaryType meta already carries the precise width.
		field = { label, type: "number" } as FormField;
	} else if (domainStr === "boolean") {
		field = { label, type: "boolean" } as FormField;
	} else {
		field = { label, type: "any" } as FormField;
	}

	applyMeta(field, fromMeta);

	// Inverse-link decoding: forward emitter encodes link as unknown + description "ref:<target>".
	if (
		(field as any).type === "any" &&
		typeof fromMeta.description === "string" &&
		fromMeta.description.startsWith("ref:")
	) {
		const target = fromMeta.description.slice(4);
		const linked = { label, type: "link", target } as FormField;
		const { description: _d, ...fromMetaWithoutDesc } = fromMeta;
		applyMeta(linked, fromMetaWithoutDesc);
		return linked;
	}

	return field;
}

function literalsToField(
	literals: Array<{ unit: unknown; meta?: unknown }>,
	label: string,
	rootMeta: ReturnType<typeof readMeta> | undefined,
): FormField {
	const units = literals.map((n) => n.unit);
	const allBool = units.every((u) => typeof u === "boolean");
	const f =
		allBool && units.length === 2
			? ({ label, type: "boolean" } as FormField)
			: ({
					label,
					type: "enum",
					options: units.map((u) => String(u)),
				} as FormField);
	if (rootMeta) applyMeta(f, rootMeta);
	else if (literals[0]?.meta) applyMeta(f, readMeta(literals[0].meta));
	return f;
}

function applyMeta(field: FormField, m: ReturnType<typeof readMeta>): void {
	const f = field as any;
	if (m.description) f.description = m.description;
	if (m.popKind) f.popKind = m.popKind;
	if (m.size !== undefined) f.size = m.size;
	if (m.align !== undefined) f.align = m.align;
	if (m.binaryType !== undefined) f.binaryType = m.binaryType;
	if (m.scale !== undefined) f.scale = m.scale;
	if (m.addr !== undefined) f.addr = m.addr;
	if (m.isBinary !== undefined) f.isBinary = m.isBinary;
	if (m.obsolete) f.obsolete = true;
	if (m.obsoleteReason) f.obsoleteReason = m.obsoleteReason;
	if (m.renamedFrom) f.renamedFrom = m.renamedFrom;
}

function unwrapDomain(json: any): string | undefined {
	const d = json?.domain;
	if (typeof d === "string") return d;
	if (d && typeof d === "object" && typeof d.domain === "string")
		return d.domain;
	return undefined;
}

function unwrapNumber(v: unknown): number | undefined {
	if (typeof v === "number") return v;
	if (v && typeof v === "object" && typeof (v as any).rule === "number")
		return (v as any).rule;
	return undefined;
}

function readMeta(meta: unknown): {
	description?: string;
	ref?: string;
	popKind?: "binary" | "bitwise" | "reserved";
	size?: number;
	align?: number;
	binaryType?: string;
	scale?: number;
	addr?: number;
	isBinary?: boolean;
	obsolete?: boolean;
	obsoleteReason?: string;
	renamedFrom?: string;
} {
	if (!meta) return {};
	if (typeof meta === "string") {
		if (meta.startsWith("ref:")) return { ref: meta.slice(4) };
		return { description: meta };
	}
	if (typeof meta !== "object") return {};
	const m = meta as Record<string, any>;
	const out: ReturnType<typeof readMeta> = {};
	if (typeof m["description"] === "string") out.description = m["description"];
	if (typeof m["ref"] === "string") out.ref = m["ref"];
	if (m["SCHEMA_POP_KIND"]) out.popKind = m["SCHEMA_POP_KIND"];
	if (typeof m["size"] === "number") out.size = m["size"];
	if (typeof m["align"] === "number") out.align = m["align"];
	if (typeof m["type"] === "string") out.binaryType = m["type"];
	if (typeof m["scale"] === "number") out.scale = m["scale"];
	if (typeof m["addr"] === "number") out.addr = m["addr"];
	if (typeof m["isBinary"] === "boolean") out.isBinary = m["isBinary"];
	if (m["obsolete"] === true) out.obsolete = true;
	if (typeof m["obsoleteReason"] === "string") out.obsoleteReason = m["obsoleteReason"];
	if (typeof m["renamedFrom"] === "string") out.renamedFrom = m["renamedFrom"];
	return out;
}
