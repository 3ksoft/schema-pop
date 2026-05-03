import type {
	IRField,
	IREnumVariant,
	IRItem,
	SchemaPopIR,
	IRPrimitive,
	IRType,
} from "@schema-pop/treesitter-importer";
import { downgradeUnknownRefs } from "@schema-pop/treesitter-importer";
import {
	type ClangNode,
	isFromInclude,
	isImplicit,
	locFile,
} from "./clang";

/**
 * stdint / common-typedef table — same set as the tree-sitter walker so
 * users get identical mappings whether they import via clang or
 * tree-sitter.
 */
const STDINT_ALIASES: Record<string, IRPrimitive> = {
	uint8_t: "u8",
	uint16_t: "u16",
	uint32_t: "u32",
	uint64_t: "u64",
	int8_t: "i8",
	int16_t: "i16",
	int32_t: "i32",
	int64_t: "i64",
	uint_least8_t: "u8",
	uint_least16_t: "u16",
	uint_least32_t: "u32",
	uint_least64_t: "u64",
	uint_fast8_t: "u8",
	uint_fast16_t: "u16",
	uint_fast32_t: "u32",
	uint_fast64_t: "u64",
	int_least8_t: "i8",
	int_least16_t: "i16",
	int_least32_t: "i32",
	int_least64_t: "i64",
	int_fast8_t: "i8",
	int_fast16_t: "i16",
	int_fast32_t: "i32",
	int_fast64_t: "i64",
	float32_t: "f32",
	float64_t: "f64",
};

/**
 * Map a fully-spelled C builtin (already qualifier-stripped) to our IR
 * primitive set. Returns `null` for ambiguous platform-dependent types
 * (`int`, `long`) — caller can decide whether to fall through to LP64
 * assumptions or report the type as unsupported.
 */
function resolveCBuiltin(text: string): IRPrimitive | null {
	const t = text.replace(/\s+/g, " ").trim();
	switch (t) {
		case "char":
		case "unsigned char":
			return "u8";
		case "signed char":
			return "i8";
		case "unsigned short":
		case "unsigned short int":
			return "u16";
		case "short":
		case "short int":
		case "signed short":
		case "signed short int":
			return "i16";
		case "unsigned long long":
		case "unsigned long long int":
			return "u64";
		case "long long":
		case "long long int":
		case "signed long long":
		case "signed long long int":
			return "i64";
		case "float":
			return "f32";
		case "double":
			return "f64";
		case "_Bool":
		case "bool":
			return "bool";
		default:
			return null;
	}
}

/**
 * Resolve a clang `qualType` string to a `IRType`. Pointers are
 * lowered to `ref` (FFI semantics — schema-pop's binary types are
 * value-typed; pointer indirection is the caller's concern). Arrays
 * become `array`. Tag types (`struct X`) become refs to `X`. Anything
 * unrecognized falls through as `unsupported`.
 *
 * `lp64` controls how `int`/`long` are mapped on platforms where they're
 * ambiguous. Default LP64 (Linux/macOS): `int → i32`, `long → i64`.
 */
export function resolveQualType(
	qualTypeRaw: string,
	opts: { lp64?: boolean } = {},
): IRType {
	const lp64 = opts.lp64 ?? true;
	let qt = qualTypeRaw
		.replace(/\bconst\b/g, "")
		.replace(/\bvolatile\b/g, "")
		.replace(/\brestrict\b/g, "")
		.replace(/\b__restrict\b/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!qt) return { kind: "unsupported", raw: qualTypeRaw };

	// Pointer: T *
	if (qt.endsWith("*")) {
		const inner = qt.slice(0, -1).trim();
		const innerType = resolveQualType(inner, { lp64 });
		// Pointer to a known type → ref to that type, marked `pointer` so
		// `computeLayoutPlan` treats it as wordsize-sized without needing
		// the pointee's layout (matters for self-referential structs and
		// forward declarations — `struct node *next` inside `struct node`).
		if (innerType.kind === "ref") {
			return { ...innerType, indirection: "pointer" };
		}
		// Pointer to primitive (`int *`, `char *`, `const uint8_t *`) —
		// previously skipped as `unsupported`, which dropped the field
		// from the IR and silently misaligned every subsequent field in
		// the containing struct (the pointer's 8 bytes vanish but the
		// struct still occupies them). Modeling as a ref-to-primitive
		// with pointer indirection preserves layout (sizeof void*) and
		// gives exporters something concrete to render (`*mut u8`,
		// `int*`, etc.). Buckets ~2.7k fields in the ESP-IDF corpus.
		if (innerType.kind === "primitive") {
			return {
				kind: "ref",
				name: innerType.name,
				indirection: "pointer",
			};
		}
		return { kind: "unsupported", raw: qualTypeRaw };
	}

	// Array: T[N]
	const arr = qt.match(/^(.+?)\s*\[(\d+)\]$/);
	if (arr) {
		const elem = resolveQualType(arr[1]!.trim(), { lp64 });
		const len = parseInt(arr[2]!, 10);
		// schema-pop's arktype string form doesn't render nested arrays
		// correctly (`T[] == N[] == M` is not valid). Surface multidim
		// arrays as unsupported for now — the user can pick an
		// alternative shape (flat byte buffer + accessor, etc.).
		if (elem.kind === "array") return { kind: "unsupported", raw: qualTypeRaw };
		return { kind: "array", item: elem, exactLength: len };
	}

	// Tag type: `struct X`, `enum X`, `union X`, `class X`
	for (const prefix of ["struct ", "enum ", "union ", "class "]) {
		if (qt.startsWith(prefix)) {
			return { kind: "ref", name: qt.slice(prefix.length).trim() };
		}
	}

	// std:: templates we model:
	//   std::string                  → string
	//   std::vector<T>               → T[]   (one level only)
	//   std::array<T, N>             → T[] == N
	//   std::optional<T>             → T | undefined
	// Any other / multi-arg / nested template falls through as unsupported
	// so the user gets a `// Skipped` note instead of a broken arktype
	// expression.
	if (qt === "std::string") return { kind: "string" };
	const stl = qt.match(/^std::(\w+)\s*<(.+)>$/);
	if (stl) {
		const tplName = stl[1]!;
		const args = parseTemplateArgs(stl[2]!);
		if (tplName === "vector" && args.length === 1) {
			const elem = resolveQualType(args[0]!, { lp64 });
			if (elem.kind === "unsupported" || elem.kind === "array")
				return { kind: "unsupported", raw: qualTypeRaw };
			return { kind: "array", item: elem };
		}
		if (tplName === "array" && args.length === 2) {
			const elem = resolveQualType(args[0]!, { lp64 });
			const len = parseInt(args[1]!, 10);
			if (
				Number.isNaN(len) ||
				elem.kind === "unsupported" ||
				elem.kind === "array"
			)
				return { kind: "unsupported", raw: qualTypeRaw };
			return { kind: "array", item: elem, exactLength: len };
		}
		if (tplName === "optional" && args.length === 1) {
			const inner = resolveQualType(args[0]!, { lp64 });
			if (inner.kind === "unsupported")
				return { kind: "unsupported", raw: qualTypeRaw };
			return { kind: "optional", inner };
		}
		return { kind: "unsupported", raw: qualTypeRaw };
	}

	// Anything else carrying template syntax we don't recognize — mark
	// as unsupported (covers `std::pair<>`, `std::map<>`, project-local
	// templates, etc.).
	if (qt.includes("<") && qt.includes(">")) {
		return { kind: "unsupported", raw: qualTypeRaw };
	}

	// stdint typedefs we understand directly.
	const stdint = STDINT_ALIASES[qt];
	if (stdint) return { kind: "primitive", name: stdint };

	// Plain builtin (no qualifier).
	const builtin = resolveCBuiltin(qt);
	if (builtin) return { kind: "primitive", name: builtin };

	// LP64 fallthrough for ambiguous int/long.
	if (lp64) {
		switch (qt) {
			case "int":
			case "signed int":
				return { kind: "primitive", name: "i32" };
			case "unsigned int":
			case "unsigned":
				return { kind: "primitive", name: "u32" };
			case "long":
			case "long int":
			case "signed long":
			case "signed long int":
				return { kind: "primitive", name: "i64" };
			case "unsigned long":
			case "unsigned long int":
				return { kind: "primitive", name: "u64" };
		}
	}

	// Otherwise: assume it's a user-defined named type.
	return { kind: "ref", name: qt };
}

/**
 * Extract documentation from a clang decl. Looks for a `FullComment`
 * child (produced when clang is invoked with `-fparse-all-comments`)
 * and renders its inner ParagraphComment / ParamCommandComment /
 * BlockCommandComment nodes back into a plain-text description-string.
 *
 * The output preserves @param / @return metadata as Doxygen-style
 * lines, since the rest of schema-pop's pipeline (analyzer, HTML/MD
 * exporters) treats `description` as opaque text and just renders it.
 *
 * Returns `undefined` if the decl has no description-comment.
 */
export function extractDoc(node: ClangNode): string | undefined {
	const fc = (node.inner ?? []).find((c) => c.kind === "FullComment");
	if (!fc) return undefined;
	const lines: string[] = [];
	for (const child of fc.inner ?? []) {
		const rendered = renderCommentBlock(child);
		if (rendered) lines.push(rendered);
	}
	const out = lines.join("\n").trim();
	return out || undefined;
}

function renderCommentBlock(node: ClangNode): string {
	switch (node.kind) {
		case "ParagraphComment":
			return collectText(node).trim();
		case "ParamCommandComment": {
			const name = (node as { param?: string }).param ?? "";
			const text = collectText(node).trim();
			return `@param ${name}${text ? " " + text : ""}`.trim();
		}
		case "BlockCommandComment": {
			const cmd = (node as { name?: string }).name ?? "";
			const text = collectText(node).trim();
			return `@${cmd}${text ? " " + text : ""}`.trim();
		}
		case "VerbatimBlockComment":
		case "VerbatimLineComment":
			return collectText(node).trim();
		default:
			return collectText(node).trim();
	}
}

/**
 * Recursively gather `TextComment.text` from a comment subtree, joined
 * with single spaces. Empty/whitespace-only fragments are dropped.
 */
function collectText(node: ClangNode): string {
	const parts: string[] = [];
	const stack: ClangNode[] = [node];
	while (stack.length) {
		const n = stack.shift()!;
		if (n.kind === "TextComment") {
			const t = (n as { text?: string }).text;
			if (t && t.trim()) parts.push(t.trim());
		}
		if (n.inner && n.inner.length) stack.push(...n.inner);
	}
	return parts.join(" ");
}

interface WalkContext {
	inputFile: string;
	items: IRItem[];
	skipped: { name: string; reason: string }[];
	emittedNames: Set<string>;
	/** Map of clang decl id → top-level node, used to resolve `typedef
	 *  struct { ... } Foo` where the RecordDecl is an anonymous sibling. */
	declById: Map<string, ClangNode>;
	/** IDs of anonymous tag decls that have been consumed by a typedef and
	 *  should not be re-emitted on their own. */
	consumed: Set<string>;
}

export interface WalkOptions {
	/** Treat the entire AST as input (do not filter by file). Useful for tests. */
	noFileFilter?: boolean;
	lp64?: boolean;
	/**
	 * Extra type names that should resolve as `ref` (not get downgraded
	 * to `unknown`). Pass the keys of any user-provided extras scope
	 * spliced into the generated file — e.g. custom `Bit<u32, 9>` /
	 * `Binary<...>` aliases.
	 */
	extraKnownNames?: readonly string[];
}

export function walkClangAst(
	root: ClangNode,
	inputFile: string,
	opts: WalkOptions = {},
): SchemaPopIR {
	const ctx: WalkContext = {
		inputFile,
		items: [],
		skipped: [],
		emittedNames: new Set(),
		declById: new Map(),
		consumed: new Set(),
	};

	const lp64 = opts.lp64 ?? true;
	const noFileFilter = opts.noFileFilter ?? false;
	const resolve = (qt: string) => resolveQualType(qt, { lp64 });

	// First pass: index every anonymous RecordDecl / EnumDecl by id so the
	// typedef pass can look them up. Also track ALL decls in the input file
	// (so user-named tag decls can resolve too if needed).
	const decls = root.inner ?? [];
	for (const node of decls) {
		if (node.id) ctx.declById.set(node.id, node);
	}

	for (const node of decls) {
		if (isImplicit(node)) continue;
		if (!noFileFilter) {
			if (isFromInclude(node)) continue;
			const file = locFile(node.loc) ?? locFile(node.range?.begin);
			if (file && file !== inputFile) continue;
		}
		if (node.id && ctx.consumed.has(node.id)) continue;
		visitTopLevel(node, ctx, resolve);
	}

	// Final pass: downgrade refs whose target name doesn't exist in
	// scope (typical for system typedefs we filtered out, like `size_t`).
	// Without this, arktype throws ParseError("'size_t' is unresolvable")
	// when the generated scope is loaded. Replacing with `unknown` keeps
	// the field while preserving the original type name for the description.
	downgradeUnknownRefs(ctx.items, opts.extraKnownNames);

	return { source: inputFile, items: ctx.items, skipped: ctx.skipped };
}

// `downgradeUnknownRefs` lives in @schema-pop/treesitter-importer so
// every walker (rust / c / cpp / ts / clang) shares one implementation.
// Imported at the top of this file.

function visitTopLevel(
	node: ClangNode,
	ctx: WalkContext,
	resolve: (qt: string) => IRType,
) {
	switch (node.kind) {
		case "TypedefDecl":
		case "TypeAliasDecl": // C++ `using X = T;`
			handleTypedef(node, ctx, resolve);
			break;
		case "RecordDecl":
		case "CXXRecordDecl":
			handleRecord(node, null, ctx, resolve);
			break;
		case "EnumDecl":
			handleEnum(node, null, ctx);
			break;
		case "FunctionDecl":
			handleFunction(node, ctx, resolve);
			break;
		case "NamespaceDecl": {
			// Flatten C++ namespaces into top-level (schema-pop scope is flat).
			for (const child of node.inner ?? []) {
				if (isImplicit(child)) continue;
				visitTopLevel(child, ctx, resolve);
			}
			break;
		}
		case "LinkageSpecDecl": {
			// `extern "C" { ... }` — descend.
			for (const child of node.inner ?? []) {
				if (isImplicit(child)) continue;
				visitTopLevel(child, ctx, resolve);
			}
			break;
		}
		default:
			break;
	}
}

/**
 * `typedef X Name;` — three sub-cases:
 *   1. X is a known struct (by tag) and Name is what the user wants to use
 *      → emit struct as `Name`, suppress the underlying tag.
 *   2. X is an enum (by tag) → similar, emit enum as `Name`.
 *   3. X is a primitive / typedef chain → emit alias.
 */
function handleTypedef(
	node: ClangNode,
	ctx: WalkContext,
	resolve: (qt: string) => IRType,
) {
	const name = node.name;
	if (!name) return;

	const qt = node.type?.qualType?.trim() ?? "";

	// `typedef struct { ... } Foo;` — clang emits an anonymous RecordDecl
	// as a sibling. The typedef's inner has a RecordType / EnumType whose
	// `decl.id` references the sibling. We resolve that sibling here and
	// emit it under the typedef's name, then mark it consumed so the
	// top-level loop skips it.
	//
	// For named tags (`typedef struct Foo { ... } Foo;`) the sibling has
	// its own name and will be visited normally; we skip the typedef so
	// the struct emits exactly once under its tag name.
	const typedefDoc = extractDoc(node);
	const sibling = findSiblingTagDecl(node, ctx);
	if (sibling) {
		const siblingName = sibling.name;
		if (siblingName) {
			// Named tag — let the top-level loop emit the sibling on its
			// own. We just suppress this typedef.
			return;
		}
		if (sibling.id) ctx.consumed.add(sibling.id);
		if (sibling.kind === "RecordDecl" || sibling.kind === "CXXRecordDecl") {
			handleRecord(sibling, name, ctx, resolve, typedefDoc);
			return;
		}
		if (sibling.kind === "EnumDecl") {
			handleEnum(sibling, name, ctx, typedefDoc);
			return;
		}
	}

	// `typedef struct Foo Foo;` (re-tagging the same name) — common idiom.
	// If the qualType is `struct Foo` and we already emitted Foo, skip silently.
	for (const prefix of ["struct ", "enum ", "union ", "class "]) {
		if (qt.startsWith(prefix)) {
			const tag = qt.slice(prefix.length).trim();
			if (tag === name) return; // already emitted as the tag
		}
	}

	// Plain alias.
	const t = resolve(qt);
	pushItem(ctx, {
		kind: "alias",
		name,
		type: t,
		description: typedefDoc,
		pub: true,
	});
}

/**
 * Walk the typedef's `inner` chain looking for a `RecordType` / `EnumType`
 * whose `decl.id` matches a known sibling decl. Returns the resolved
 * sibling node, or `null` if the typedef points at something else
 * (another typedef, builtin, primitive, etc.).
 */
function findSiblingTagDecl(
	typedefNode: ClangNode,
	ctx: WalkContext,
): ClangNode | null {
	const stack = [...(typedefNode.inner ?? [])];
	while (stack.length) {
		const n = stack.shift()!;
		if (n.kind === "RecordType" || n.kind === "EnumType") {
			const declRef = (n as { decl?: { id?: string } }).decl;
			if (declRef?.id) {
				const sibling = ctx.declById.get(declRef.id);
				if (sibling) return sibling;
			}
		}
		// Descend through ElaboratedType / TypedefType wrappers.
		if (n.inner && n.inner.length) stack.push(...n.inner);
	}
	return null;
}

function handleRecord(
	node: ClangNode,
	typedefName: string | null,
	ctx: WalkContext,
	resolve: (qt: string) => IRType,
	overrideDoc?: string,
) {
	// Only emit complete definitions. Forward decls (`struct Foo;`) have
	// `completeDefinition` either missing or `false` — both treated as
	// "no body, skip silently".
	if (node.completeDefinition !== true) return;
	const tagName = node.name;
	const name = typedefName ?? tagName;
	if (!name) return;

	if (node.tagUsed === "union") {
		ctx.skipped.push({
			name,
			reason: "C union (raw — schema-pop has no native union mapping)",
		});
		return;
	}

	// Attributes attached to the struct itself live as child *Attr nodes:
	//   __attribute__((packed))    → PackedAttr     → repr: ["packed"]
	//   __attribute__((aligned(N))) → AlignedAttr   → repr: ["aligned(N)"]
	// schema-pop's analyzer only acts on `packed` today; `aligned` is
	// recorded for documentation so the user can see it in the output.
	const repr: string[] = [];
	for (const attr of node.inner ?? []) {
		if (attr.kind === "PackedAttr") repr.push("packed");
		else if (attr.kind === "MaxFieldAlignmentAttr") {
			// `#pragma pack(push, N)` — clang emits MaxFieldAlignmentAttr
			// without surfacing N in the JSON dump. We assume the common
			// case (`pack(1)` = byte-tight) and mark as packed. For
			// non-1 pack values the analyzer's auto-padding will be off
			// — caller can override `repr` manually if needed.
			if (!repr.includes("packed")) repr.push("packed");
		} else if (attr.kind === "AlignedAttr") {
			const n = extractIntegerLiteral(attr);
			repr.push(n !== null ? `aligned(${n})` : "aligned");
		}
	}

	const fields: IRField[] = [];
	let skippedAnyField = false;
	for (const child of node.inner ?? []) {
		if (child.kind !== "FieldDecl") continue;
		if (isImplicit(child)) continue;
		const fname = child.name;
		const qt = child.type?.qualType ?? "";
		if (!fname || !qt) continue;
		// Bitfields: clang sets `isBitfield: true` and embeds the width
		// as a `ConstantExpr.value` integer literal in the FieldDecl's
		// `inner`. We resolve the storage type from qualType and emit a
		// `bit`-kind IRType, which the emitter renders as `uN` (1..7)
		// or `Bit<storage, N>` (wider) — both valid schema-pop forms.
		if (child.isBitfield === true) {
			const width = extractBitfieldWidth(child);
			const storage = resolve(qt);
			if (width === null || storage.kind !== "primitive") {
				ctx.skipped.push({
					name: `${name}.${fname}`,
					reason: `bitfield with non-primitive storage (${qt})`,
				});
				skippedAnyField = true;
				continue;
			}
			const fieldDoc = extractDoc(child);
			fields.push({
				name: fname,
				type: {
					kind: "bit",
					widthBits: width,
					underlying: storage.name,
				},
				pub: true,
				description: fieldDoc,
			});
			continue;
		}
		// Function pointer field: qualType looks like `T (*)(args)` or
		// `T (*name)(args)`. We can't faithfully model these in
		// schema-pop's binary layout — skip with a note.
		if (isFunctionPointerType(qt)) {
			ctx.skipped.push({
				name: `${name}.${fname}`,
				reason: `function pointer (${qt})`,
			});
			skippedAnyField = true;
			continue;
		}
		const t = resolve(qt);
		if (t.kind === "unsupported") {
			ctx.skipped.push({
				name: `${name}.${fname}`,
				reason: `unsupported field type: ${qt}`,
			});
			skippedAnyField = true;
			continue;
		}
		const fieldDoc = extractDoc(child);
		fields.push({ name: fname, type: t, pub: true, description: fieldDoc });
	}

	// Empty struct (either originally empty, or all fields filtered out) →
	// skip emission. Arktype's scope can't represent zero-field shapes,
	// and emitting an empty object would produce broken output.
	if (fields.length === 0) {
		if (skippedAnyField) {
			ctx.skipped.push({
				name,
				reason: "all fields unsupported (bitfields / fn pointers / etc.)",
			});
		}
		return;
	}

	pushItem(ctx, {
		kind: "struct",
		name,
		fields,
		repr: repr.length ? repr : undefined,
		description: overrideDoc ?? extractDoc(node),
		pub: true,
	});
}

/**
 * Extract a single positive integer literal from an attribute's inner
 * `ConstantExpr`. Used for `aligned(N)`, `__attribute__((aligned(32)))`
 * and similar attributes whose value lives in a child IntegerLiteral.
 */
function extractIntegerLiteral(node: ClangNode): number | null {
	for (const c of node.inner ?? []) {
		if (c.kind !== "ConstantExpr") continue;
		const v = (c as { value?: string | number }).value;
		if (typeof v === "number") return v;
		if (typeof v === "string") {
			const n = parseInt(v, 10);
			if (!Number.isNaN(n)) return n;
		}
	}
	return null;
}

/**
 * Heuristic: qualType is a function pointer if it contains `(*` or `(* `.
 * Matches `void (*)(int)`, `int (*name)(void)`, `T (* const)(void)`, etc.
 */
function isFunctionPointerType(qt: string): boolean {
	return /\(\s*\*/.test(qt);
}

/**
 * Split a template-argument string at top-level commas, respecting
 * nested `<...>`. e.g. `std::vector<uint8_t>, size_t` →
 * `["std::vector<uint8_t>", "size_t"]`.
 */
function parseTemplateArgs(args: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let buf = "";
	for (const ch of args) {
		if (ch === "<") depth++;
		else if (ch === ">") depth = Math.max(0, depth - 1);
		else if (ch === "," && depth === 0) {
			if (buf.trim()) out.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim()) out.push(buf.trim());
	return out;
}

/**
 * Pull a bitfield width from a FieldDecl's inner. Clang stores the
 * width as a `ConstantExpr` whose `value` field is a stringified
 * integer (e.g. `"3"`, `"20"`).
 */
function extractBitfieldWidth(node: ClangNode): number | null {
	for (const c of node.inner ?? []) {
		if (c.kind !== "ConstantExpr") continue;
		const v = (c as { value?: string | number }).value;
		if (typeof v === "number") return v;
		if (typeof v === "string") {
			const n = parseInt(v, 10);
			if (!Number.isNaN(n)) return n;
		}
	}
	return null;
}

function handleEnum(
	node: ClangNode,
	typedefName: string | null,
	ctx: WalkContext,
	overrideDoc?: string,
) {
	const name = typedefName ?? node.name;
	if (!name) return;

	const variants: IREnumVariant[] = [];
	for (const child of node.inner ?? []) {
		if (child.kind !== "EnumConstantDecl") continue;
		if (!child.name) continue;
		variants.push({ kind: "unit", name: child.name, description: extractDoc(child) });
	}

	// Detect explicit underlying type (C++11 / C23 `enum Name : uint8_t`).
	let repr: string[] | undefined;
	if (node.fixedUnderlyingType?.qualType) {
		const r = STDINT_ALIASES[node.fixedUnderlyingType.qualType];
		if (r) repr = [r];
	}

	pushItem(ctx, {
		kind: "enum",
		name,
		variants,
		repr,
		description: overrideDoc ?? extractDoc(node),
		pub: true,
	});
}

function handleFunction(
	node: ClangNode,
	ctx: WalkContext,
	resolve: (qt: string) => IRType,
) {
	const name = node.name;
	if (!name) return;

	// Pull return type out of the function's qualType: e.g.
	// `int (Foo *, DeviceId)` → return = `int`, params = the qualType list.
	// We use ParmVarDecl children for params (more reliable) and split the
	// qualType to grab just the return.
	const fnQt = node.type?.qualType ?? "";
	const retQt = extractReturnType(fnQt);
	const returnType = resolveReturnType(retQt, resolve);

	const args: { name?: string; type: IRType }[] = [];
	for (const child of node.inner ?? []) {
		if (child.kind !== "ParmVarDecl") continue;
		const argName = child.name || undefined;
		const qt = child.type?.qualType ?? "";
		args.push({ name: argName, type: resolve(qt) });
	}

	pushItem(ctx, {
		kind: "function",
		name,
		args,
		returnType,
		abi: extractAbi(node),
		description: extractDoc(node),
		pub: true,
	});
}

/**
 * Pull the calling-convention attribute off a FunctionDecl. Clang's JSON
 * dump embeds attributes inline in the qualType string
 * (`void (...) __attribute__((stdcall))`) AND occasionally as child
 * `*Attr` nodes. We check both — qualType first since it's the primary
 * surface in current clang JSON output.
 *
 * Returns one of: `cdecl`, `stdcall`, `fastcall`, `thiscall`,
 * `vectorcall`, `regcall`, `ms_abi`, `sysv_abi`. Returns `undefined`
 * for the platform default (cdecl on Linux/macOS, stdcall on
 * Win32 — schema-pop's emit layer handles platform defaults).
 */
function extractAbi(node: ClangNode): string | undefined {
	const qt = node.type?.qualType ?? "";
	const m = qt.match(
		/__attribute__\(\((stdcall|cdecl|fastcall|thiscall|vectorcall|regcall|ms_abi|sysv_abi)\)\)/,
	);
	if (m) return m[1];

	// Fallback: walk inner for *Attr nodes.
	for (const child of node.inner ?? []) {
		const k = child.kind ?? "";
		switch (k) {
			case "StdCallAttr":
				return "stdcall";
			case "CDeclAttr":
				return "cdecl";
			case "FastCallAttr":
				return "fastcall";
			case "ThisCallAttr":
				return "thiscall";
			case "VectorCallAttr":
				return "vectorcall";
			case "RegCallAttr":
				return "regcall";
			case "MSABIAttr":
				return "ms_abi";
			case "SysVABIAttr":
				return "sysv_abi";
		}
	}
	return undefined;
}

/**
 * Map a return-type qualType to a `IRType`. `void` → `unsupported`
 * with raw `"void"`, which the emitter renders as `{ kind: "unit" }`.
 */
function resolveReturnType(
	retQt: string,
	resolve: (qt: string) => IRType,
): IRType {
	if (!retQt) return { kind: "unsupported", raw: "void" };
	const t = retQt.replace(/\s+/g, " ").trim();
	if (t === "void") return { kind: "unsupported", raw: "void" };
	return resolve(retQt);
}

/**
 * Extract the return-type portion of a function qualType string.
 * `int (Foo *, DeviceId)` → `int`. Falls back to the whole string if the
 * paren-form isn't found (some C++ shapes get printed differently).
 */
function extractReturnType(fnQt: string): string {
	const idx = fnQt.indexOf("(");
	if (idx < 0) return fnQt.trim();
	return fnQt.slice(0, idx).trim();
}

function pushItem(ctx: WalkContext, item: IRItem) {
	if (ctx.emittedNames.has(item.name)) {
		// Same name twice — keep the first; record subsequent as skipped.
		ctx.skipped.push({
			name: item.name,
			reason: "duplicate declaration",
		});
		return;
	}
	ctx.emittedNames.add(item.name);
	ctx.items.push(item);
}
