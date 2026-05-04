import type {
	Field,
	FieldPlan,
	LayoutPlan,
	StructPlan,
	TypePlan,
	UnionPlan,
} from "../schema/layout";

export interface DumpOptions {
	/** Restrict output to one or more type names (case-sensitive). */
	types?: string[];
	/** Width of the offset column in chars. Default: 5 (fits 5-digit offsets). */
	offsetWidth?: number;
	/** Indent string. Default: "  " (two spaces). */
	indent?: string;
}

/**
 * Render a `LayoutPlan` as a human-readable text dump showing each
 * type's size + align + per-field offset and size. Designed as the TS
 * side of a cross-language layout diff: paste the output next to a
 * Rust `core::mem::offset_of!` printout and any divergence is an
 * encoder/decoder bug — see docs/requests.md P16.
 *
 * Output shape (ASCII so it pastes cleanly into bug reports):
 *
 *     struct WsMessage  size=448 align=8 paddedSize=448
 *         tag      0  1  u8       (variant discriminant)
 *         payload  1  447 union  variants:
 *             SystemHealth  payloadOffset=1
 *                 uptime_secs   1   8  u64
 *                 heap_free     9   4  u32
 *                 ...
 *
 * Fields in bitfield positions show their bit range explicitly.
 */
export function dumpLayoutPlan(
	plan: LayoutPlan,
	opts: DumpOptions = {},
): string {
	const indent = opts.indent ?? "  ";
	const offWidth = opts.offsetWidth ?? 5;
	const wantNames = opts.types ? new Set(opts.types) : null;

	const out: string[] = [];
	out.push(
		`# Layout dump — endian=${plan.endian} wordSize=${plan.wordSize} version=${plan.version}`,
	);
	out.push("");

	for (const t of plan.types) {
		if (wantNames && !wantNames.has(t.name)) continue;
		out.push(...renderType(t, plan, indent, offWidth));
		out.push("");
	}

	return out.join("\n");
}

function renderType(
	t: TypePlan,
	plan: LayoutPlan,
	indent: string,
	offWidth: number,
): string[] {
	const layout = `size=${t.size} align=${t.align} paddedSize=${t.paddedSize}`;
	if (t.kind === "struct") {
		return renderStruct(t, plan, indent, offWidth, layout);
	}
	if (t.kind === "union") {
		return renderUnion(t, plan, indent, offWidth, layout);
	}
	if (t.kind === "enum") {
		const variants = t.variants.map((v) => `${v.name}=${v.value}`).join(", ");
		return [
			`enum ${t.name}  ${layout}  underlying=${t.underlyingType}`,
			`${indent}${variants}`,
		];
	}
	// alias
	return [
		`alias ${t.name}  ${layout}`,
		`${indent}→ ${renderField(t.type, plan)}`,
	];
}

function renderStruct(
	t: StructPlan,
	plan: LayoutPlan,
	indent: string,
	offWidth: number,
	layout: string,
): string[] {
	const lines = [`struct ${t.name}  ${layout}`];
	for (const f of t.fields) {
		lines.push(`${indent}${renderFieldLine(f, plan, offWidth)}`);
	}
	const tail = trailingPad(t);
	if (tail > 0) {
		const start = t.size - tail;
		lines.push(
			`${indent}${pad(String(start), offWidth)}  ${pad(String(tail), 4)} <trailing-pad>`,
		);
	}
	return lines;
}

function renderUnion(
	t: UnionPlan,
	plan: LayoutPlan,
	indent: string,
	offWidth: number,
	layout: string,
): string[] {
	// Payload offset = align-up(tagOffset + tagSize, max-variant-align).
	// The analyzer doesn't store this directly on the union plan, but
	// `t.align` IS the max-variant-align (computed via reduce on each
	// variant's struct align), so we can reproduce it here. The codec
	// uses the same trick (`baseOffset + plan.align`) to find payloads.
	const tagEnd = t.tagOffset + t.tagSize;
	const payloadStart = Math.ceil(tagEnd / t.align) * t.align;
	const lines = [
		`union ${t.name}  ${layout}  tag=${t.tagType}@${t.tagOffset}+${t.tagSize}  payload@${payloadStart}`,
	];
	for (const v of t.variants) {
		lines.push(`${indent}variant ${v.name}  payloadStart=${payloadStart}`);
		// Resolve the variant's referenced struct to expand its fields.
		if (v.type.kind === "reference") {
			const ref = plan.types.find(
				(x) => x.name === (v.type as { name: string }).name,
			);
			if (ref && ref.kind === "struct") {
				for (const f of ref.fields) {
					// Show the field's absolute offset within the union (variant
					// offset = payloadStart + field.offset within variant struct).
					const absOffset = payloadStart + f.offset;
					lines.push(
						`${indent}${indent}${renderFieldLineAbs(
							f,
							absOffset,
							plan,
							offWidth,
						)}`,
					);
				}
			} else {
				lines.push(`${indent}${indent}→ ${renderField(v.type, plan)}`);
			}
		} else {
			lines.push(`${indent}${indent}→ ${renderField(v.type, plan)}`);
		}
	}
	return lines;
}

function renderFieldLine(
	f: FieldPlan,
	plan: LayoutPlan,
	offWidth: number,
): string {
	const off = pad(String(f.offset), offWidth);
	const sz = pad(String(f.size), 4);
	const bits =
		f.bitSize > 0 && f.bitSize < 8
			? ` bits[${f.bitOffset}..${f.bitOffset + f.bitSize}]`
			: "";
	const padTail = f.paddingAfter > 0 ? `  +pad=${f.paddingAfter}` : "";
	return `${off}  ${sz} ${f.name}: ${renderField(f.type, plan)}${bits}${padTail}`;
}

function renderFieldLineAbs(
	f: FieldPlan,
	abs: number,
	plan: LayoutPlan,
	offWidth: number,
): string {
	const off = pad(String(abs), offWidth);
	const sz = pad(String(f.size), 4);
	const bits =
		f.bitSize > 0 && f.bitSize < 8
			? ` bits[${f.bitOffset}..${f.bitOffset + f.bitSize}]`
			: "";
	const padTail = f.paddingAfter > 0 ? `  +pad=${f.paddingAfter}` : "";
	return `${off}  ${sz} ${f.name}: ${renderField(f.type, plan)}${bits}${padTail}`;
}

function renderField(f: Field, _plan: LayoutPlan): string {
	switch (f.kind) {
		case "primitive":
			return f.name;
		case "reference":
			return f.name;
		case "string":
			return f.maxLength !== undefined ? `string<=${f.maxLength}` : "string";
		case "array": {
			const inner = renderField(f.item, _plan);
			if (f.exactLength !== undefined) return `${inner}[${f.exactLength}]`;
			if (f.maxLength !== undefined) return `${inner}[]<=${f.maxLength}`;
			return `${inner}[]`;
		}
		case "optional":
			return `${renderField(f.inner, _plan)}?`;
		case "unit":
			return "unit";
		case "any":
			return "unknown";
		case "inlineStruct":
			return `inlineStruct(${f.fields.length} fields)`;
		case "map":
			return `map<${f.keyKind}, ${renderField(f.value, _plan)}>`;
		default:
			return JSON.stringify(f);
	}
}

function trailingPad(t: StructPlan): number {
	if (t.fields.length === 0) return t.paddedSize;
	const last = t.fields[t.fields.length - 1]!;
	const fieldsEnd = last.offset + last.size + last.paddingAfter;
	return Math.max(0, t.paddedSize - fieldsEnd);
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}
