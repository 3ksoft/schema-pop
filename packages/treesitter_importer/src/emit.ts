import type { IRField, IRItem, SchemaPopIR, IRType } from "schema-pop";

/**
 * @deprecated Legacy IR → arktype scope source emitter. Kept for the
 * hand-edit workflow (`schema-pop-import foo.h -o foo.pop.ts`), but
 * the default importer flow now writes `.layout.json` directly via
 * `computeLayoutPlan` + `writeLayoutPlan` and skips this round-trip
 * entirely. Use `.layout.json` output unless you specifically need the
 * editable arktype scope artifact.
 *
 * IR → arktype scope source. The output file is meant to be hand-readable
 * and to plug into a normal schema-pop pipeline as `versions[].source`.
 *
 * Conventions:
 *  - Primitives are emitted as the same string ("u32", etc.) — schema-pop's
 *    `binary` scope already exports those names.
 *  - References are emitted by name; cross-references inside one scope are
 *    fine because arktype resolves them lazily.
 *  - Doc-comments are converted to `.describe(...)` chains via the
 *    `describe` helper from schema-pop core.
 *  - Items with `repr(uN)` on an all-unit enum are emitted as a string
 *    literal union (closest equivalent in our analyzer).
 */

export type EmitOptions = {
	scopeName?: string; // default: "$"
	header?: string; // raw text prepended to file (e.g., a banner)
	/**
	 * User-provided extra scopes spliced into the generated output.
	 * Each entry produces an extra `import { <importName> } from "<importPath>"`
	 * line plus a `...<importName>.import()` spread inside the `scope({...})`.
	 * Names listed in `aliases` shadow generated items: if our IR happens
	 * to define one too (typically a typedef in source code), we skip our
	 * version and surface it in the `// Skipped` block so the user's
	 * definition wins without duplicate-key conflicts.
	 */
	extras?: ExtraScope[];
};

export interface ExtraScope {
	importPath: string;
	importName: string;
	aliases: string[];
}

export function emitArktypeScope(
	ir: SchemaPopIR,
	opts: EmitOptions = {},
): string {
	const scopeName = opts.scopeName ?? "$";
	const header = opts.header ?? defaultHeader(ir.source);

	const extras = opts.extras ?? [];
	const shadowed = new Set<string>();
	for (const e of extras) for (const a of e.aliases) shadowed.add(a);

	const typeItems = ir.items.filter(
		(i) => i.kind !== "function" && !shadowed.has(i.name),
	);
	const fnItems = ir.items.filter(
		(i): i is Extract<IRItem, { kind: "function" }> =>
			i.kind === "function" && !shadowed.has(i.name),
	);

	const shadowedItems = ir.items
		.filter((i) => shadowed.has(i.name))
		.map((i) => ({ name: i.name, reason: "shadowed by --extras" }));
	const allSkipped = [...shadowedItems, ...ir.skipped];

	const aliases: string[] = [];
	for (const item of typeItems) aliases.push(emitItem(item));

	const skipped =
		allSkipped.length > 0
			? `\n// Skipped (unsupported by tree-sitter MVP):\n${allSkipped
					.map((s) => `//   ${s.name} — ${s.reason}`)
					.join("\n")}\n`
			: "";

	const fnsBlock = fnItems.length ? emitFunctions(fnItems) : "";

	// Bitwise types (`u1`..`u7`, `Bit<u32, N>`) need the `bitwise` scope
	// to be in scope, otherwise arktype throws on `'u3' is unresolvable`.
	// `schemaPop` is the convenience bundle that covers binary + bitwise
	// + Reserved/Scale/At/OriginalType — switch to it when any `bit`,
	// `unknown`, or `unsupported` IR variant is in play (any of those
	// renders as an `OriginalType<...>` generic in scope source). Plain
	// binary stays the default for cheaper TS inference.
	const needsSchemaPopBundle = anyTypeMatches(
		typeItems,
		(t) => t.kind === "bit" || t.kind === "unknown" || t.kind === "unsupported",
	);
	const fnsImport = fnItems.length
		? `\nimport type { FunctionPlan } from "schema-pop";`
		: "";
	const importBlock = needsSchemaPopBundle
		? `import { scope, schemaPop } from "schema-pop";${fnsImport}`
		: `import { scope, binary } from "schema-pop";${fnsImport}`;
	const baseSpread = needsSchemaPopBundle
		? "...schemaPop,"
		: "...binary.import(),";

	const extraImports = extras
		.map(
			(e) =>
				`\nimport { ${e.importName} } from ${JSON.stringify(e.importPath)};`,
		)
		.join("");
	const extraSpreads = extras
		.map((e) => `\n\t...${e.importName}.import(),`)
		.join("");

	return `${header}
${importBlock}${extraImports}

export const ${scopeName} = scope({
\t${baseSpread}${extraSpreads}
${aliases.map((a) => indent(a, 1)).join(",\n")}${aliases.length ? "," : ""}
});
${fnsBlock}${skipped}`;
}

/**
 * Recursive predicate over every `IRType` reachable from a list of
 * top-level items (struct fields, alias RHS, enum variant payloads).
 * Used to detect whether the output needs an extra import (`bitwise`,
 * `migrations`, etc.) before we render it.
 */
function anyTypeMatches(
	items: IRItem[],
	pred: (t: IRType) => boolean,
): boolean {
	const visit = (t: IRType): boolean => {
		if (pred(t)) return true;
		if (t.kind === "array") return visit(t.item);
		if (t.kind === "optional") return visit(t.inner);
		return false;
	};
	for (const item of items) {
		if (item.kind === "struct") {
			for (const f of item.fields) if (visit(f.type)) return true;
		} else if (item.kind === "alias") {
			if (visit(item.type)) return true;
		} else if (item.kind === "enum") {
			for (const v of item.variants) {
				if (v.kind === "tuple") {
					for (const t of v.types) if (visit(t)) return true;
				} else if (v.kind === "struct") {
					for (const f of v.fields) if (visit(f.type)) return true;
				}
			}
		}
	}
	return false;
}

/**
 * Emit a `export const functions: FunctionPlan[] = [...]` block. Each entry
 * is a plain object literal compatible with schema-pop's `FunctionPlan` TS
 * type. Field types are encoded directly as IR primitives → schema-pop
 * `Field` shapes (no string-form arktype expressions, since functions
 * bypass the arktype scope entirely).
 */
function emitFunctions(fns: Extract<IRItem, { kind: "function" }>[]): string {
	const entries = fns.map((fn) => {
		const argEntries = fn.args.map(
			(a) =>
				`\t\t\t{ ${a.name ? `name: ${JSON.stringify(a.name)}, ` : ""}type: ${emitFieldLiteral(a.type)} }`,
		);
		const ret = emitFieldLiteral(fn.returnType);
		const docPart = fn.description
			? `\n\t\tdescription: ${JSON.stringify(fn.description)},`
			: "";
		const abiPart = fn.abi ? `\n\t\tabi: ${JSON.stringify(fn.abi)},` : "";
		return `\t{
\t\tname: ${JSON.stringify(fn.name)},
\t\tsymbol: ${JSON.stringify(fn.name)},${abiPart}${docPart}
\t\treturnType: ${ret},
\t\targs: [${argEntries.length ? `\n${argEntries.join(",\n")}\n\t\t` : ""}],
\t}`;
	});
	return `\nexport const functions: FunctionPlan[] = [\n${entries.join(",\n")},\n];\n`;
}

/**
 * Emit a IR `IRType` as a literal `Field` object compatible with
 * schema-pop's `Field` union. Used inside function argument / return
 * types where there's no string-form arktype available.
 */
function emitFieldLiteral(t: IRType): string {
	switch (t.kind) {
		case "primitive":
			return `{ kind: "primitive", name: ${JSON.stringify(t.name)}, size: ${primitiveSize(t.name)}, align: ${primitiveAlign(t.name)}, paddedSize: ${primitiveSize(t.name)}, popKind: "binary" }`;
		case "ref":
			return `{ kind: "reference", name: ${JSON.stringify(t.name)}, indirection: "inline", isForward: false, size: 0, align: 1, paddedSize: 0 }`;
		case "string":
			return `{ kind: "string" }`;
		case "array": {
			const lenPart =
				t.exactLength !== undefined ? `, exactLength: ${t.exactLength}` : "";
			return `{ kind: "array", item: ${emitFieldLiteral(t.item)}${lenPart}, size: 0, align: 1, paddedSize: 0 }`;
		}
		case "optional": {
			return `{ kind: "optional", inner: ${emitFieldLiteral(t.inner)} }`;
		}
		case "bit": {
			// Bitfields don't appear in function-arg position in any
			// language we cover; we still emit a valid Field so the
			// downstream pipeline doesn't choke on the variant.
			return `{ kind: "primitive", name: ${JSON.stringify(t.underlying)}, size: 0, align: 1, paddedSize: 0, popKind: "bitwise" /* bit width: ${t.widthBits} */ }`;
		}
		case "unknown":
			return `{ kind: "any", originalType: ${JSON.stringify(t.raw)} }`;
		case "unsupported":
			// `()` (Rust unit) and `void` (C) → encode as `unit` field.
			if (t.raw === "()" || t.raw === "void") {
				return `{ kind: "unit" }`;
			}
			return `{ kind: "any", originalType: ${JSON.stringify(t.raw)} }`;
		case "inlineStruct":
		case "map":
		case "any":
		case "unit":
			// New IR variants produced by the arktype walker only;
			// tree-sitter walkers don't emit them, so the emitter
			// (which is tree-sitter-only) doesn't need to handle them.
			// Falls back to opaque so we don't crash if a stray IR slips through.
			return `{ kind: "any" }`;
	}
}

function escapeJsBlock(s: string): string {
	return s.replace(/\*\//g, "*\\/").replace(/\n/g, " ");
}

function primitiveSize(name: string): number {
	const m: Record<string, number> = {
		u8: 1,
		i8: 1,
		bool: 1,
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
	return m[name] ?? 0;
}
function primitiveAlign(name: string): number {
	return primitiveSize(name) || 1;
}

function defaultHeader(sourcePath: string): string {
	return `// AUTO-GENERATED by @schema-pop/treesitter-importer
// Source: ${sourcePath}
// Edit the .rs file and re-run the importer; do not hand-edit this file.
`;
}

function emitItem(item: IRItem): string {
	if (item.kind === "struct") {
		const lines = item.fields
			.filter((f) => emittableField(f))
			.map((f) => emitField(f));
		return `${jsdoc(item.description)}${quoteTypeName(item.name)}: {\n${lines.join(",\n")}\n}`;
	}
	if (item.kind === "enum") {
		// All unit variants → string literal union; carry tag size via
		// description if repr is present.
		const allUnit = item.variants.every((v) => v.kind === "unit");
		if (allUnit) {
			const lits = item.variants.map((v) => `'${v.name}'`).join(" | ");
			return `${jsdoc(item.description)}${quoteTypeName(item.name)}: ${JSON.stringify(lits)}`;
		}
		// Discriminated tagged union: emit each variant as a struct ref then
		// a union of those refs. For MVP keep it simple: emit per-variant
		// inline structs and join them.
		const variantTypes: string[] = [];
		const sub: string[] = [];
		for (let i = 0; i < item.variants.length; i++) {
			const v = item.variants[i]!;
			const tagLit = String(i);
			if (v.kind === "unit") {
				const variantTypeName = `${item.name}_${v.name}`;
				sub.push(`${quoteTypeName(variantTypeName)}: { tag: '${tagLit}' }`);
				variantTypes.push(variantTypeName);
			} else if (v.kind === "tuple") {
				// One-arg tuple variant: `Variant(T)` → struct { tag, value }.
				if (v.types.length === 1) {
					const variantTypeName = `${item.name}_${v.name}`;
					sub.push(
						`${quoteTypeName(variantTypeName)}: { tag: '${tagLit}', value: ${emitTypeAsString(v.types[0]!)} }`,
					);
					variantTypes.push(variantTypeName);
				} else {
					sub.push(
						`// (skipped tuple variant ${item.name}::${v.name} with ${v.types.length} args)`,
					);
				}
			} else if (v.kind === "struct") {
				const variantTypeName = `${item.name}_${v.name}`;
				const lines = v.fields.map(
					(f) => `\t\t${quoteFieldName(f.name)}: ${emitTypeAsString(f.type)}`,
				);
				sub.push(
					`${quoteTypeName(variantTypeName)}: { tag: '${tagLit}',\n${lines.join(",\n")}\n}`,
				);
				variantTypes.push(variantTypeName);
			}
		}
		const unionExpr = variantTypes.join(" | ");
		const all = [
			...sub,
			`${quoteTypeName(item.name)}: ${JSON.stringify(unionExpr)}`,
		];
		return all.join(",\n");
	}
	if (item.kind === "alias") {
		return `${jsdoc(item.description)}${quoteTypeName(item.name)}: ${emitTypeAsString(item.type)}`;
	}
	// function items are emitted via emitFunctions, not inside the scope.
	return "";
}

function emittableField(f: IRField): boolean {
	return f.type.kind !== "unsupported";
}

function emitField(f: IRField): string {
	// Optional<T> at field level → "name?": "T" (arktype optional-key form).
	const docPrefix = jsdoc(f.description, "\t");
	if (f.type.kind === "optional") {
		const innerExpr = emitTypeAsString(f.type.inner);
		const key = f.name + "?";
		return `${docPrefix}\t${JSON.stringify(key)}: ${innerExpr}`;
	}
	return `${docPrefix}\t${quoteFieldName(f.name)}: ${emitTypeAsString(f.type)}`;
}

/**
 * Render a doc-string as a JSDoc-style block comment, emitted inline
 * before the entry it documents. Returns "" when the doc is empty.
 *
 * Single-line docs collapse to `/** text *​/`. Multi-line docs use the
 * three-line block form. The output ends with `\n${pad}` so the next
 * line lines up with the entry's indentation.
 */
function jsdoc(text: string | undefined, pad: string = ""): string {
	if (!text) return "";
	const trimmed = text.trim();
	if (!trimmed) return "";
	const lines = trimmed.split("\n").map((l) => l.trim());
	if (lines.length === 1) {
		return `${pad}/** ${escapeJsBlock(lines[0]!)} */\n`;
	}
	const body = lines.map((l) => `${pad} * ${escapeJsBlock(l)}`).join("\n");
	return `${pad}/**\n${body}\n${pad} */\n`;
}

function emitTypeAsString(t: IRType): string {
	switch (t.kind) {
		case "primitive":
			return JSON.stringify(t.name);
		case "ref":
			return JSON.stringify(t.name);
		case "string":
			return JSON.stringify("string");
		case "array": {
			const inner = innerStringForArktype(t.item);
			return JSON.stringify(
				t.exactLength !== undefined
					? `${inner}[] == ${t.exactLength}`
					: `${inner}[]`,
			);
		}
		case "optional": {
			const inner = innerStringForArktype(t.inner);
			return JSON.stringify(`${inner} | undefined`);
		}
		case "bit":
			return JSON.stringify(bitTypeString(t.widthBits, t.underlying));
		case "unknown":
			// schema-pop's `OriginalType<unknown, 'X'>` generic materialises
			// as an `unknown`-shaped Type carrying `meta.originalType = 'X'`,
			// which the analyzer surfaces on the resulting Field. Binary
			// exporters with `useOriginalType: true` then splat the original
			// spelling. Available via the `schemaPop` bundle (binary
			// scope users would need to import OriginalType separately).
			return JSON.stringify(`OriginalType<unknown, ${quoteForArktype(t.raw)}>`);
		case "unsupported":
			return JSON.stringify(`OriginalType<unknown, ${quoteForArktype(t.raw)}>`);
		case "inlineStruct":
		case "map":
		case "any":
		case "unit":
			// Tree-sitter walkers don't produce these; the emitter is
			// tree-sitter-only so a shared opaque fallback keeps the
			// switch exhaustive without generating bogus arktype source.
			return JSON.stringify("unknown");
	}
}

/**
 * Quote a string for use inside an arktype expression. Picks single-
 * quotes when safe, falls back to double-quotes otherwise. Used for the
 * `'X'` argument of generics like `OriginalType<unknown, 'X'>` and
 * `Describe<T, 'X'>`.
 */
function quoteForArktype(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	if (!s.includes('"')) return `"${s}"`;
	return `'${s.replace(/'/g, "\\'")}'`;
}

/**
 * Render a bit-packed field as a schema-pop arktype expression. Widths
 * 1..7 map to the predefined `u1`..`u7` aliases (which are the common
 * case for flag/mode fields). Wider bitfields fall back to the generic
 * `Bit<underlying, N>` form, since schema-pop's `bitwise` scope only
 * predefines the small widths.
 */
function bitTypeString(widthBits: number, underlying: string): string {
	if (widthBits >= 1 && widthBits <= 7) return `u${widthBits}`;
	return `Bit<${underlying}, ${widthBits}>`;
}

function innerStringForArktype(t: IRType): string {
	// For nested types inside a string-form arktype expression we strip the
	// outer quotes. Keep it conservative: only primitive/ref/string forms.
	if (t.kind === "primitive") return t.name;
	if (t.kind === "ref") return t.name;
	if (t.kind === "string") return "string";
	if (t.kind === "array") {
		return t.exactLength !== undefined
			? `${innerStringForArktype(t.item)}[] == ${t.exactLength}`
			: `${innerStringForArktype(t.item)}[]`;
	}
	if (t.kind === "optional") {
		return `${innerStringForArktype(t.inner)} | undefined`;
	}
	if (t.kind === "bit") return bitTypeString(t.widthBits, t.underlying);
	if (t.kind === "unknown") return "unknown";
	// `unsupported` and any other shape we can't render into a string-form
	// arktype expression collapse to `unknown` (the top type) so the
	// generated scope still loads.
	return "unknown";
}

function quoteFieldName(name: string): string {
	if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return name;
	return JSON.stringify(name);
}

function quoteTypeName(name: string): string {
	return quoteFieldName(name);
}

function indent(text: string, n: number): string {
	const pad = "\t".repeat(n);
	return text
		.split("\n")
		.map((l) => (l.length ? pad + l : l))
		.join("\n");
}
