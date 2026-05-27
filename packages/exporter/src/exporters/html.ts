import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldPlan,
	LayoutPlan,
	StructPlan,
	TypePlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";
import { htmlAppScript } from "./htmlApp";
import { svg as defaultSvg, svgInternal } from "./svg";

const { toSafeVersionIdentifier } = ExporterTools({
	typeNaming: "original",
});

export interface HtmlConfig extends BaseConfig {
	title?: string;
	viz?: ExporterPlugin<any>;
	/**
	 * When `false`, hides binary-layout columns (byte offset, size, range) and
	 * the memory-layout SVG. Use for schemas without binary annotations where
	 * those values are meaningless.  Default: `true`.
	 */
	layout?: boolean;
}

function fieldTypeLabel(f: Field): string {
	return svgInternal.fieldTypeLabel(f);
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Same shape as fieldTypeLabel but emits HTML with `<a>` anchors around
 * known type names. Anchor href matches the TypeCard `id` pattern in
 * html-app.ts (`t-<vid>-<TypeName>`), so clicking jumps in-page.
 */
function fieldTypeHtml(f: Field, knownNames: Set<string>, vid: string): string {
	const anchorFor = (name: string) =>
		`<a href="#t-${vid}-${name}" class="sp-type-link">${escapeHtml(name)}</a>`;
	switch (f.kind) {
		case "primitive":
			return escapeHtml(f.name);
		case "reference":
			return knownNames.has(f.name) ? anchorFor(f.name) : escapeHtml(f.name);
		case "array": {
			const inner = fieldTypeHtml(f.item, knownNames, vid);
			const len = (f as any).exactLength ?? (f as any).maxLength;
			return len !== undefined ? `[${inner}; ${len}]` : `${inner}[]`;
		}
		case "string": {
			const len = (f as any).maxLength;
			return len !== undefined ? `string&lt;${len}&gt;` : "string";
		}
		case "optional":
			return `${fieldTypeHtml(f.inner, knownNames, vid)}?`;
		case "inlineStruct":
			return "{…}";
		case "map": {
			const k = f.keyKind === "number" ? "number" : "string";
			return `Record&lt;${k}, ${fieldTypeHtml(f.value, knownNames, vid)}&gt;`;
		}
		case "any":
			return "unknown";
		case "unit":
			return "unit";
		default:
			return "?";
	}
}

function rangeFor(f: FieldPlan): string | undefined {
	const t = f.type;
	if (t.kind !== "primitive") return undefined;
	const n = t.name;
	if (n === "u8") return "0 … 255";
	if (n === "u16") return "0 … 65,535";
	if (n === "u32") return "0 … 4,294,967,295";
	if (n === "u64") return "0 … 2⁶⁴-1";
	if (n === "i8") return "−128 … 127";
	if (n === "i16") return "−32,768 … 32,767";
	if (n === "i32") return "−2,147,483,648 … 2,147,483,647";
	if (n === "i64") return "−2⁶³ … 2⁶³-1";
	if (n === "f32") return "IEEE-754 single";
	if (n === "f64") return "IEEE-754 double";
	if (n === "bool") return "0 / 1";
	return undefined;
}

type LinkCtx = { knownNames: Set<string>; vid: string } | undefined;

function fieldLabel(f: Field, linkCtx: LinkCtx): string {
	return linkCtx
		? fieldTypeHtml(f, linkCtx.knownNames, linkCtx.vid)
		: fieldTypeLabel(f);
}

function renderFunctionSignature(
	fn: {
		name: string;
		args: { name?: string; type: Field }[];
		returnType: Field;
	},
	linkCtx: LinkCtx,
): string {
	const argParts = fn.args.map((a) => {
		const t = fieldLabel(a.type, linkCtx);
		return a.name ? `${a.name}: ${t}` : t;
	});
	const ret =
		fn.returnType.kind === "unit" ? "void" : fieldLabel(fn.returnType, linkCtx);
	return `${fn.name}(${argParts.join(", ")}) → ${ret}`;
}

function typeToDocs(
	t: TypePlan,
	svgBars: string | undefined,
	linkCtx?: { knownNames: Set<string>; vid: string },
	withLayout = true,
): any {
	const labelOf = (f: Field) => fieldLabel(f, linkCtx);
	const tAny = t as any;
	const common = {
		name: t.name,
		size: t.size,
		paddedSize: tAny.paddedSize ?? t.size,
		align: t.align,
		docstring: tAny.description,
		obsolete: tAny.obsolete === true ? true : undefined,
		obsoleteReason: tAny.obsoleteReason,
		svgBars: svgBars || "",
	};
	if (t.kind === "struct") {
		return {
			...common,
			kind: "struct",
			fields: t.fields.map((f) => {
				const fAny = f as any;
				return {
					...(withLayout && {
						offset: f.offset,
						size: f.size,
						pad: f.paddingAfter || 0,
						bitSize: f.bitSize,
						bitOffset: f.bitOffset,
						range: rangeFor(f),
					}),
					name: f.name,
					type: labelOf(f.type),
					typeKind: f.type.kind,
					description: fAny.description,
					obsolete: fAny.obsolete === true ? true : undefined,
					obsoleteReason: fAny.obsoleteReason,
				};
			}),
		};
	}
	if (t.kind === "enum") {
		return {
			...common,
			kind: "enum",
			underlyingType: t.underlyingType,
			variants: t.variants.map((v) => ({
				name: v.name,
				value: v.value,
				description: v.description,
			})),
		};
	}
	if (t.kind === "union") {
		return {
			...common,
			kind: "union",
			tagOffset: t.tagOffset,
			tagSize: t.tagSize,
			tagType: t.tagType,
			variants: t.variants.map((v) => ({
				name: v.name,
				type: labelOf(v.type as Field),
			})),
		};
	}
	if (t.kind === "alias") {
		return {
			...common,
			kind: "alias",
			aliasOf: labelOf(t.type),
		};
	}
	return common;
}

function jsonScript(payload: any): string {
	return JSON.stringify(payload)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

export function html(config: HtmlConfig = {}): ExporterPlugin<HtmlConfig> {
	const cfg: HtmlConfig = {
		commentStyle: "none",
		title: "schema-pop · report",
		...config,
	};
	const vizBars =
		cfg.viz ?? defaultSvg({ mode: "bars", width: 720, rowHeight: 38 });

	return {
		name: "html",
		extension: "html",
		config: cfg,
		getFileHeader: () => {
			return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${cfg.title}</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  html, body { font-family: 'Inter', system-ui, -apple-system, sans-serif; }
  .sp-viz { color: inherit; }
  .sp-viz text { font-family: 'Inter', system-ui, sans-serif; }
  :root { --sp-paper: #fffae3; --sp-sat: 70%; --sp-bg-light: 92%; --sp-stroke-light: 38%; --sp-bg-alpha: 1; }
  .dark { --sp-paper: #160814; --sp-sat: 55%; --sp-bg-light: 26%; --sp-stroke-light: 72%; --sp-bg-alpha: 0.8; }
  .sp-type-link { color: inherit; text-decoration: none; border-bottom: 1px dashed currentColor; opacity: 0.85; }
  .sp-type-link:hover { opacity: 1; border-bottom-style: solid; }
</style>
<script>
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        fontFamily: { sans: ['Inter','system-ui','sans-serif'], mono: ['JetBrains Mono','monospace'] },
        colors: {
          ink: '#00241b', paper: '#fffae3', night: '#160814',
          dusk: '#404e7c', accent: '#f7567c',
          good: '#1f8a5a', warn: '#c47a08', bad: '#c0392b',
        },
      }
    }
  };
  window.SCHEMA_POP_DATA = window.SCHEMA_POP_DATA || { meta: { layout: 'Little Endian', generated: new Date().toISOString() }, versions: [], diffs: [] };
</script>
</head>
<body class="bg-paper text-ink dark:bg-night dark:text-paper antialiased text-[13px] leading-relaxed">
<div id="root"></div>
`;
		},
		generate: (plan: LayoutPlan) => {
			const withLayout = cfg.layout !== false;
			const barsRecords = withLayout
				? (vizBars.generate(plan) as Record<string, string>)
				: {};
			const knownNames = new Set(plan.types.map((t) => t.name));
			const vid = toSafeVersionIdentifier(plan.version);
			const linkCtx = { knownNames, vid };
			const versionData = {
				id: plan.version,
				label: plan.version,
				endian: (plan as any).endian,
				layout: withLayout,
				types: (plan.types as TypePlan[]).map((t) =>
					typeToDocs(
						t,
						withLayout ? barsRecords[`${t.name}.svg`] : undefined,
						linkCtx,
						withLayout,
					),
				),
				// functions: (plan.functions ?? []).map((fn) => ({
				// 	name: fn.name,
				// 	symbol: fn.symbol ?? fn.name,
				// 	abi: fn.abi,
				// 	description: fn.description,
				// 	obsolete: fn.obsolete,
				// 	obsoleteReason: fn.obsoleteReason,
				// 	signature: renderFunctionSignature(fn, linkCtx),
				// 	returnLabel: fieldLabel(fn.returnType as Field, linkCtx),
				// 	args: fn.args.map((a) => ({
				// 		name: a.name,
				// 		label: fieldLabel(a.type as Field, linkCtx),
				// 	})),
				// })),
			};
			return `<script>window.SCHEMA_POP_DATA.versions.push(${jsonScript(versionData)});</script>\n`;
		},
		getFileFooter: () => {
			return `<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
<script type="text/babel">
${htmlAppScript()}
</script>
</body>
</html>
`;
		},
	};
}
