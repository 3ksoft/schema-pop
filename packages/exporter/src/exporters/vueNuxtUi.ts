import type {
	BaseConfig,
	EnumPlan,
	ExporterPlugin,
	Field,
	FieldPlan,
	LayoutPlan,
	StructPlan,
	TypePlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

/**
 * Nuxt UI v3 form exporter — turns each StructPlan into a `<UForm>`-based
 * Vue SFC backed by a self-contained arktype scope (only `arktype` as
 * runtime dep; primitive bounds u8 0..255, i32 ±2^31, … are inlined
 * into the generated scope). Multi-file output:
 *
 *   ${StructName}Form.vue   one polished form per struct
 *   schemas.ts              one arktype scope re-exporting every type
 *                           (also usable standalone — no UI dependency)
 *   index.ts                re-export barrel
 *
 * `<UForm :schema="…">` natively accepts arktype Type instances (Nuxt UI
 * v3 supports arktype, zod, valibot, yup, joi, superstruct out of the
 * box) so the SFC just imports `${Name}Schema` and hands it over.
 *
 * Enum references render as `<USelectMenu>` populated with the enum
 * variants. Struct references render as a child `*Form.vue` mounted via
 * `defineModel`. Arrays get add/remove controls. Optionals get a
 * "set / unset" toggle. Deprecated fields keep rendering with a hint.
 */
export interface NuxtUiConfig extends BaseConfig {
	/**
	 * Validation library to emit. Only `arktype` is implemented today —
	 * lines up with the rest of the project (binary supplies
	 * primitive bounds). Kept on the config so callers can opt-in to a
	 * different validator later without breaking the API.
	 */
	validator?: "arktype";
	/** Submit button label. Default `Submit`. */
	submitLabel?: string;
	/**
	 * String length (in chars) above which a field renders as
	 * `<UTextarea>` instead of `<UInput>`. Default 80.
	 */
	textareaThreshold?: number;
	/**
	 * Kept for backwards compatibility — a leading import line written
	 * verbatim into each generated SFC (e.g. for sharing the analyzer
	 * output). No-op when omitted.
	 */
	schemaImport?: string;
}

/**
 * Per-primitive UI metadata.
 *  - `arkDef` is the standalone arktype string definition we inline at
 *    the top of `schemas.ts` for every primitive the schema actually
 *    references. We embed (rather than `binary` from
 *    schema-pop) so the generated code carries no runtime dep on
 *    schema-pop — only `arktype`.
 *  - `min` / `max` / `step` drive `<UInputNumber>` props.
 *  - `bigint` switches the renderer to `<UInput type="text">` since
 *    `<UInputNumber>` only handles JS numbers.
 */
const PRIMITIVE_UI: Record<
	string,
	{
		arkDef: string;
		min?: number;
		max?: number;
		step?: number;
		bigint?: boolean;
	}
> = {
	bool: { arkDef: "boolean" },
	u8: { arkDef: "0 <= number.integer <= 255", min: 0, max: 255, step: 1 },
	i8: { arkDef: "-128 <= number.integer <= 127", min: -128, max: 127, step: 1 },
	u16: { arkDef: "0 <= number.integer <= 65535", min: 0, max: 65535, step: 1 },
	i16: {
		arkDef: "-32768 <= number.integer <= 32767",
		min: -32768,
		max: 32767,
		step: 1,
	},
	u32: {
		arkDef: "0 <= number.integer <= 4294967295",
		min: 0,
		max: 4294967295,
		step: 1,
	},
	i32: {
		arkDef: "-2147483648 <= number.integer <= 2147483647",
		min: -2147483648,
		max: 2147483647,
		step: 1,
	},
	u64: { arkDef: "bigint >= 0n", bigint: true },
	i64: { arkDef: "bigint", bigint: true },
	u128: { arkDef: "bigint >= 0n", bigint: true },
	i128: { arkDef: "bigint", bigint: true },
	f32: { arkDef: "number" },
	f64: { arkDef: "number" },
};

interface TypeIndex {
	enums: Map<string, EnumPlan>;
	structs: Map<string, StructPlan>;
	aliases: Map<string, TypePlan>;
}

function buildIndex(plan: LayoutPlan): TypeIndex {
	const enums = new Map<string, EnumPlan>();
	const structs = new Map<string, StructPlan>();
	const aliases = new Map<string, TypePlan>();
	for (const t of plan.types) {
		if (t.kind === "enum") enums.set(t.name, t);
		else if (t.kind === "struct") structs.set(t.name, t);
		else if (t.kind === "alias") aliases.set(t.name, t);
	}
	return { enums, structs, aliases };
}

/* ───────────────────────── arktype codegen ───────────────────────── */

/**
 * An arktype field expression — either a string definition (the
 * common case, e.g. `"u8"`, `"string <= 80"`, `"u32[] == 4"`) or a
 * raw JS literal (used for nested object shapes / scope references
 * that aren't expressible in the arktype string DSL).
 */
type ArkExpr =
	| { kind: "string"; value: string }
	| { kind: "raw"; value: string };

function ark(value: string): ArkExpr {
	return { kind: "string", value };
}

function arkForField(
	f: Field,
	idx: TypeIndex,
	typeName: (n: string) => string,
): ArkExpr {
	switch (f.kind) {
		case "primitive": {
			// Reference the alias name we hoist into the scope below
			// (e.g. `"u8"`). The scope's primitive aliases carry the
			// actual bound expression — this keeps field defs short.
			return ark(PRIMITIVE_UI[f.name] ? f.name : "unknown");
		}
		case "reference": {
			// Always emit a bare alias — the scope resolves it. Inlining would
			// duplicate the definition (the enum / struct / alias is already
			// declared at the top of the same scope).
			if (
				idx.enums.has(f.name) ||
				idx.structs.has(f.name) ||
				idx.aliases.has(f.name)
			) {
				return ark(typeName(f.name));
			}
			return ark("unknown");
		}
		case "string": {
			return ark(
				f.maxLength !== undefined ? `string <= ${f.maxLength}` : "string",
			);
		}
		case "array": {
			const inner = arkForField(f.item, idx, typeName);
			// arktype string DSL only chains array suffixes on string defs;
			// for raw object items we drop length constraints (they can be
			// re-added via .narrow() in user-land if needed).
			if (inner.kind === "raw")
				return { kind: "raw", value: `[${inner.value}, "[]"]` };
			let s = `${inner.value}[]`;
			if (f.exactLength !== undefined) s += ` == ${f.exactLength}`;
			else if (f.maxLength !== undefined) s += ` <= ${f.maxLength}`;
			return ark(s);
		}
		case "optional":
			// Optionals are encoded by a `?` on the *key* in arktype; the
			// value definition is the inner type. Caller (object emitter)
			// handles the key suffix — here we just unwrap.
			return arkForField(f.inner, idx, typeName);
		case "inlineStruct":
			return { kind: "raw", value: emitObjectLiteral(f.fields, idx, typeName) };
		case "map": {
			const v = arkForField(f.value, idx, typeName);
			// arktype's index-signature shape: `{ "[string]": "u8" }`.
			if (v.kind === "string") {
				return {
					kind: "raw",
					value: `{ "[${f.keyKind}]": ${JSON.stringify(v.value)} }`,
				};
			}
			return { kind: "raw", value: `{ "[${f.keyKind}]": ${v.value} }` };
		}
		case "any":
			return ark("unknown");
		case "unit":
			// `unit` is the analyzer's fallback for shapes it can't pin
			// to a fixed layout (e.g. `string[]` in binary or rich mode).
			// `unknown` keeps the field validatable without forcing the
			// user to satisfy `undefined` to submit.
			return ark("unknown");
		default:
			return ark("unknown");
	}
}

function escapeSingle(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function jsKey(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Emits an inline arktype object literal as a JS source string, e.g.
 *   `{ "name": "string", "age?": "u8", "nested": { ... } }`
 * Keys carry the `?` marker for optional fields; values are either
 * JSON-quoted strings or raw nested objects.
 */
function emitObjectLiteral(
	fields: { name: string; type: Field }[],
	idx: TypeIndex,
	typeName: (n: string) => string,
	indent = "\t\t",
): string {
	const lines = fields.map((fp) => {
		const isOpt = fp.type.kind === "optional";
		const expr = arkForField(fp.type, idx, typeName);
		const key = JSON.stringify(`${fp.name}${isOpt ? "?" : ""}`);
		const val =
			expr.kind === "string" ? JSON.stringify(expr.value) : expr.value;
		return `${indent}${key}: ${val},`;
	});
	return `{\n${lines.join("\n")}\n${indent.slice(1)}}`;
}

/* ─────────────────────────── ui codegen ──────────────────────────── */

interface InputDescriptor {
	template: string;
	imports?: Set<string>;
}

function inputForField(
	field: Field,
	bind: string,
	idx: TypeIndex,
	typeName: (n: string) => string,
	cfg: NuxtUiConfig,
	depth = 0,
): InputDescriptor {
	const imports = new Set<string>();
	switch (field.kind) {
		case "primitive": {
			const b = PRIMITIVE_UI[field.name];
			if (!b) return { template: `<UInput v-model="${bind}" />`, imports };
			if (field.name === "bool")
				return { template: `<UCheckbox v-model="${bind}" />`, imports };
			if (b.bigint) {
				return {
					template: `<UInput v-model="${bind}" type="text" inputmode="numeric" placeholder="${field.name}" />`,
					imports,
				};
			}
			const attrs = [
				b.min !== undefined ? `:min="${b.min}"` : "",
				b.max !== undefined ? `:max="${b.max}"` : "",
				b.step !== undefined ? `:step="${b.step}"` : "",
			]
				.filter(Boolean)
				.join(" ");
			return {
				template: `<UInputNumber v-model="${bind}" ${attrs} />`,
				imports,
			};
		}
		case "reference": {
			const enumPlan = idx.enums.get(field.name);
			if (enumPlan) {
				const items = JSON.stringify(enumPlan.variants.map((v) => v.name));
				return {
					template: `<USelectMenu v-model="${bind}" :items='${items}' placeholder="select ${field.name}" />`,
					imports,
				};
			}
			if (idx.structs.has(field.name)) {
				const comp = `${typeName(field.name)}Form`;
				imports.add(comp);
				return { template: `<${comp} v-model="${bind}" embedded />`, imports };
			}
			return { template: `<UInput v-model="${bind}" />`, imports };
		}
		case "string": {
			const max = field.maxLength ?? 0;
			const useTextarea = max > (cfg.textareaThreshold ?? 80);
			const attrs =
				field.maxLength !== undefined ? ` :maxlength="${field.maxLength}"` : "";
			return {
				template: useTextarea
					? `<UTextarea v-model="${bind}"${attrs} />`
					: `<UInput v-model="${bind}"${attrs} />`,
				imports,
			};
		}
		case "optional": {
			const inner = inputForField(
				field.inner,
				bind,
				idx,
				typeName,
				cfg,
				depth + 1,
			);
			inner.imports?.forEach((i) => imports.add(i));
			// `defaultLiteralFor` may emit a value containing `"` (e.g. `""` for
			// strings). Vue attributes use `"` as the delimiter, so escape any
			// double-quote in the literal so it survives template parsing.
			const defLit = defaultLiteralFor(field.inner, idx).replace(
				/"/g,
				"&quot;",
			);
			return {
				template: `<div class="flex items-center gap-2">
\t\t\t\t<UCheckbox :model-value="${bind} !== undefined && ${bind} !== null" @update:model-value="(v) => ${bind} = v ? ${defLit} : undefined" />
\t\t\t\t<template v-if="${bind} !== undefined && ${bind} !== null">${inner.template}</template>
\t\t\t\t<span v-else class="text-xs opacity-60">unset</span>
\t\t\t</div>`,
				imports,
			};
		}
		case "array": {
			const itemBind = `${bind}[i]`;
			const inner = inputForField(
				field.item,
				itemBind,
				idx,
				typeName,
				cfg,
				depth + 1,
			);
			inner.imports?.forEach((i) => imports.add(i));
			const fixed = field.exactLength !== undefined;
			const lenCap = field.exactLength ?? field.maxLength;
			const canAdd =
				lenCap !== undefined ? `${bind}.length < ${lenCap}` : "true";
			return {
				template: `<div class="space-y-2">
\t\t\t\t<div v-for="(_, i) in (${bind} || [])" :key="i" class="flex items-center gap-2">
\t\t\t\t\t<span class="text-xs opacity-50 font-mono w-6">[{{ i }}]</span>
\t\t\t\t\t<div class="flex-1">${inner.template}</div>
\t\t\t\t\t${
					fixed
						? ""
						: `<UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" @click="${bind}.splice(i, 1)" />`
				}
\t\t\t\t</div>
\t\t\t\t${
					fixed
						? ""
						: `<UButton size="xs" variant="soft" icon="i-lucide-plus" :disabled="!(${canAdd})" @click="${bind}.push(${defaultLiteralFor(field.item, idx)})">add</UButton>`
				}
\t\t\t</div>`,
				imports,
			};
		}
		case "inlineStruct": {
			const blocks = field.fields
				.map((fp) => {
					const sub = inputForField(
						fp.type,
						`${bind}.${fp.name}`,
						idx,
						typeName,
						cfg,
						depth + 1,
					);
					sub.imports?.forEach((i) => imports.add(i));
					return `<UFormField label=${JSON.stringify(fp.name)} name=${JSON.stringify(fp.name)}>\n\t\t\t\t\t${sub.template}\n\t\t\t\t</UFormField>`;
				})
				.join("\n\t\t\t\t");
			return {
				template: `<fieldset class="border border-neutral-200 dark:border-neutral-800 rounded-md p-3 space-y-2">\n\t\t\t\t${blocks}\n\t\t\t</fieldset>`,
				imports,
			};
		}
		case "map":
			return {
				template: `<UTextarea v-model="${bind}" placeholder='{"key": value}' :rows="3" />`,
				imports,
			};
		case "any":
			return { template: `<UTextarea v-model="${bind}" :rows="3" />`, imports };
		case "unit":
			// Analyzer sometimes folds rich-only shapes (e.g. `string[]`)
			// to `unit` even in rich mode. Render a passthrough textarea
			// instead of swallowing the field — better than `<!-- unit -->`
			// which leaves UFormField empty.
			return {
				template: `<UTextarea v-model="${bind}" :rows="2" placeholder="rich field — analyzer dropped layout" />`,
				imports,
			};
		default:
			return { template: `<UInput v-model="${bind}" />`, imports };
	}
}

function defaultLiteralFor(field: Field, idx: TypeIndex): string {
	switch (field.kind) {
		case "primitive":
			return field.name === "bool"
				? "false"
				: PRIMITIVE_UI[field.name]?.bigint
					? "0n"
					: "0";
		case "string":
			return '""';
		case "array":
			return "[]";
		case "optional":
			return "undefined";
		case "reference":
			if (idx.enums.get(field.name)) {
				const v = idx.enums.get(field.name)!.variants[0]?.name;
				return v ? JSON.stringify(v) : "undefined";
			}
			return "{}";
		case "inlineStruct":
			return "{}";
		case "map":
			return "{}";
		default:
			return "undefined";
	}
}

function defaultStateFor(field: Field, idx: TypeIndex): string {
	if (field.kind === "optional") return "undefined";
	return defaultLiteralFor(field, idx);
}

/* ───────────────────────── file emitters ─────────────────────────── */

/**
 * Walks every field type in the plan to find which `binary` primitives
 * are actually referenced. We only inline those — keeps `schemas.ts`
 * tight (a contact form schema doesn't need to declare `i128`).
 */
function collectReferencedPrimitives(plan: LayoutPlan): string[] {
	const used = new Set<string>();
	function walk(f: Field): void {
		switch (f.kind) {
			case "primitive":
				if (PRIMITIVE_UI[f.name]) used.add(f.name);
				return;
			case "array":
				walk(f.item);
				return;
			case "optional":
				walk(f.inner);
				return;
			case "inlineStruct":
				for (const fp of f.fields) walk(fp.type);
				return;
			case "map":
				walk(f.value);
				return;
		}
	}
	for (const t of plan.types) {
		if (t.kind === "struct") for (const fp of t.fields) walk(fp.type);
		else if (t.kind === "alias") walk(t.type);
		else if (t.kind === "union")
			for (const v of t.variants) walk(v.type as Field);
	}
	// Stable order — keeps the diff between regenerations minimal.
	const order = Object.keys(PRIMITIVE_UI);
	return order.filter((n) => used.has(n));
}

function emitSchemasFile(
	plan: LayoutPlan,
	idx: TypeIndex,
	typeName: (n: string) => string,
	fieldName: (n: string) => string,
): string {
	const lines: string[] = [];
	lines.push(`import { scope } from "arktype";`);
	lines.push("");
	lines.push(`/**`);
	lines.push(` * Self-contained arktype scope. The only runtime dep is`);
	lines.push(` * \`arktype\` itself — primitive bounds (u8, i32, …) are`);
	lines.push(` * inlined at the top of the scope, not imported from`);
	lines.push(` * \`schema-pop\`. Each named type is re-exported below as`);
	lines.push(
		` * \`\${Name}Schema\` (a Type instance) plus a \`type \${Name}\``,
	);
	lines.push(` * inferred from it.`);
	lines.push(` */`);
	lines.push(`export const $ = scope({`);

	// Inline only the primitives the plan actually references.
	const usedPrimitives = collectReferencedPrimitives(plan);
	for (const p of usedPrimitives) {
		lines.push(`\t${p}: ${JSON.stringify(PRIMITIVE_UI[p]!.arkDef)},`);
	}
	if (usedPrimitives.length > 0) lines.push("");

	const exportable: { name: string; declaredAs: string }[] = [];

	// Plan types are pre-sorted by the analyzer (refs always come after
	// the type they point to in topological order — see writing_own_exporters.md §9).
	for (const t of plan.types) {
		const declared = typeName(t.name);
		if (t.kind === "struct") {
			const literal = emitObjectLiteral(
				t.fields.map((fp) => ({ name: fieldName(fp.name), type: fp.type })),
				idx,
				typeName,
				"\t\t",
			);
			lines.push(`\t${declared}: ${literal},`);
			exportable.push({ name: t.name, declaredAs: declared });
		} else if (t.kind === "enum") {
			const variants = t.variants
				.map((v) => `'${escapeSingle(v.name)}'`)
				.join(" | ");
			lines.push(`\t${declared}: ${JSON.stringify(variants)},`);
			exportable.push({ name: t.name, declaredAs: declared });
		} else if (t.kind === "alias") {
			const expr = arkForField(t.type, idx, typeName);
			const val =
				expr.kind === "string" ? JSON.stringify(expr.value) : expr.value;
			lines.push(`\t${declared}: ${val},`);
			exportable.push({ name: t.name, declaredAs: declared });
		}
	}
	lines.push(`});`);
	lines.push("");

	// Destructure-rename to ${Name}Schema so the value/type names don't collide.
	const renamePairs = exportable
		.map((e) => `${e.declaredAs}: ${e.declaredAs}Schema`)
		.join(", ");
	lines.push(`export const { ${renamePairs} } = $.export();`);
	lines.push("");

	for (const e of exportable) {
		lines.push(
			`export type ${e.declaredAs} = typeof ${e.declaredAs}Schema.infer;`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

function emitStructForm(
	t: StructPlan,
	idx: TypeIndex,
	typeName: (n: string) => string,
	fieldName: (n: string) => string,
	cfg: NuxtUiConfig,
): string {
	const schemaName = `${typeName(t.name)}Schema`;
	const childImports = new Set<string>();
	const fieldBlocks: string[] = [];
	const stateInit: string[] = [];

	for (const fp of t.fields) {
		const fname = fieldName(fp.name);
		const desc = inputForField(fp.type, `state.${fname}`, idx, typeName, cfg);
		desc.imports?.forEach((i) => childImports.add(i));
		const required = fp.type.kind !== "optional";
		// Field-level `description` is always arktype's auto-stringified
		// type form (e.g. `"a string and at most length 60"`). It's noisy
		// and the field label already names the field — skip it. Users who
		// want explicit guidance can wrap the SFC in their own UFormField.
		const deprecated = (fp as FieldPlan).obsolete
			? `\n\t\t\t<p class="text-xs text-amber-600">⚠ deprecated${
					(fp as FieldPlan).obsoleteReason
						? `: ${escapeHtml((fp as FieldPlan).obsoleteReason!)}`
						: ""
				}</p>`
			: "";
		fieldBlocks.push(
			`\t\t<UFormField label=${attrJson(fname)} name=${attrJson(fname)}${
				required ? " required" : ""
			}>${deprecated}\n\t\t\t${desc.template}\n\t\t</UFormField>`,
		);
		stateInit.push(`\t${jsKey(fname)}: ${defaultStateFor(fp.type, idx)},`);
	}

	const childImportLines = [...childImports]
		.map((c) => `import ${c} from "./${c}.vue";`)
		.join("\n");

	const submitLabel = cfg.submitLabel ?? "Submit";
	// Same reason as field hints — type-level `description` is the
	// arktype stringified form, never user prose. Skip the doc header.
	const docHeader = "";
	const deprecatedBanner = t.obsolete
		? `\n\t<p class="text-xs text-amber-600 border-l-2 border-amber-500 pl-2">⚠ deprecated${
				t.obsoleteReason ? `: ${escapeHtml(t.obsoleteReason)}` : ""
			}</p>`
		: "";

	return `<script setup lang="ts">
import { reactive, watch } from "vue";
import { ${schemaName}, type ${typeName(t.name)} } from "./schemas";
${cfg.schemaImport ? `${cfg.schemaImport}\n` : ""}${childImportLines}

defineProps<{ embedded?: boolean }>();
const model = defineModel<Partial<${typeName(t.name)}>>({ default: () => ({}) });
const emit = defineEmits<{ submit: [${typeName(t.name)}] }>();

const state = reactive<Partial<${typeName(t.name)}>>({
${stateInit.join("\n")}
\t...model.value,
});

watch(state, (v) => { model.value = { ...v }; }, { deep: true });

async function onSubmit(event: { data: ${typeName(t.name)} }) {
\temit("submit", event.data);
}
</script>

<template>
\t<UForm :schema="${schemaName}" :state="state" class="space-y-3" @submit="onSubmit">${docHeader}${deprecatedBanner}
${fieldBlocks.join("\n")}
\t\t<div v-if="!embedded" class="pt-2">
\t\t\t<UButton type="submit" color="primary">${escapeHtml(submitLabel)}</UButton>
\t\t</div>
\t</UForm>
</template>
`;
}

function emitIndex(
	structs: StructPlan[],
	typeName: (n: string) => string,
): string {
	const lines: string[] = [`export * from "./schemas";`];
	for (const s of structs) {
		const c = `${typeName(s.name)}Form`;
		lines.push(`export { default as ${c} } from "./${c}.vue";`);
	}
	return `${lines.join("\n")}\n`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Vue-safe attribute literal: JSON-stringify, then swap the wrapping
 * `"…"` for `'…'` and HTML-escape any embedded `'` so the value can sit
 * inside an attribute without breaking the parser. Returns the value
 * *with* its surrounding `'…'` quotes — drop them in directly:
 * `label=${attrJson(name)}`.
 */
function attrJson(s: string): string {
	const raw = JSON.stringify(s).slice(1, -1);
	return `'${raw.replace(/'/g, "&#39;")}'`;
}

/* ─────────────────────────── plugin api ──────────────────────────── */

export function nuxtUi(
	config: NuxtUiConfig = {},
): ExporterPlugin<NuxtUiConfig> {
	const cfg: NuxtUiConfig = {
		fieldNaming: "camelCase",
		typeNaming: "PascalCase",
		// Multi-file output (.vue + .ts) — slash-style auto-headers
		// would land at the top of every file and break SFC parsing.
		// "none" tells the builder to skip the header altogether.
		commentStyle: "none",
		validator: "arktype",
		submitLabel: "Submit",
		textareaThreshold: 80,
		...config,
	};
	const { typeName, fieldName } = ExporterTools(cfg);

	return {
		name: "nuxt-ui",
		extension: "vue",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const idx = buildIndex(plan);
			const out: Record<string, string> = {};
			out["schemas.ts"] = emitSchemasFile(plan, idx, typeName, fieldName);
			const renderable = plan.types.filter(
				(t): t is StructPlan => t.kind === "struct" && !t.obsolete,
			);
			for (const s of renderable) {
				const compName = `${typeName(s.name)}Form`;
				out[`${compName}.vue`] = emitStructForm(
					s,
					idx,
					typeName,
					fieldName,
					cfg,
				);
			}
			out["index.ts"] = emitIndex(renderable, typeName);
			return out;
		},
	};
}
