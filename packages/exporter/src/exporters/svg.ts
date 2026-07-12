import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldPlan,
	LayoutPlan,
	TypePlan,
} from "@schema-pop/schema";

export interface SvgConfig extends BaseConfig {
	width?: number;
	rowHeight?: number;
	mode?: "bars" | "grid";
	rowBytes?: number;
}

const PAD = 16;
const AXIS = 18;
const TITLE_GAP = 18;

function fieldTypeLabel(f: Field): string {
	switch (f.kind) {
		case "primitive":
			return f.name;
		case "reference":
			return f.name;
		case "array": {
			const inner = fieldTypeLabel(f.item);
			const len = (f as any).exactLength ?? (f as any).maxLength;
			return len !== undefined ? `[${inner}; ${len}]` : `${inner}[]`;
		}
		case "string": {
			const len = (f as any).maxLength;
			return len !== undefined ? `string<${len}>` : "string";
		}
		case "optional":
			return `${fieldTypeLabel(f.inner)}?`;
		case "inlineStruct":
			return "{…}";
		case "map": {
			const k = f.keyKind === "number" ? "number" : "string";
			return `Record<${k}, ${fieldTypeLabel(f.value)}>`;
		}
		case "any":
			return "unknown";
		case "unit":
			return "unit";
		default:
			return "?";
	}
}

function hueFor(seed: string | number): number {
	if (typeof seed === "number") return Math.round((seed * 137.508) % 360);
	let h = 0;
	for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
	return Math.round((h * 137.508) % 360);
}

function fillFor(seed: string | number) {
	const hue = hueFor(seed);
	return {
		bg: `hsl(${hue} var(--sp-sat, 70%) var(--sp-bg-light, 92%) / var(--sp-bg-alpha, 1))`,
		stroke: `hsl(${hue} var(--sp-sat, 70%) var(--sp-stroke-light, 40%))`,
	};
}

function svgWrap(
	width: number,
	height: number,
	body: string,
	title: string,
): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" class="sp-viz" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="${title}">
<defs>
<pattern id="sp-pad" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
<line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-opacity="0.25" stroke-width="1" />
</pattern>
</defs>
${body}
</svg>`;
}

function renderStructBars(t: any, cfg: SvgConfig): string {
	const totalSize: number = t.paddedSize || t.size;
	if (totalSize <= 0)
		return svgWrap(cfg.width!, cfg.rowHeight! + PAD * 2, "", t.name);
	const rowH = cfg.rowHeight!;
	const innerW = cfg.width! - PAD * 2;
	const scale = innerW / totalSize;
	const totalH = AXIS + rowH + PAD * 2;
	// For large structures (multi-KB profile blobs etc.) emit only the major
	// axis ticks; one tick per byte at totalSize=60KB blows up the SVG.
	const stride = Math.max(1, Math.floor(totalSize / 8));
	const minorTicks = totalSize <= 256;
	let body = `<g class="sp-axis" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity="0.55">`;
	for (let i = 0; i <= totalSize; i += minorTicks ? 1 : stride) {
		const x = PAD + i * scale;
		const major = i % stride === 0 || i === totalSize;
		body += `<line x1="${x}" y1="${PAD + AXIS}" x2="${x}" y2="${PAD + AXIS + rowH}" stroke="currentColor" stroke-opacity="${major ? 0.18 : 0.08}" />`;
		if (major)
			body += `<text x="${x}" y="${PAD + AXIS - 4}" text-anchor="middle">+${i}</text>`;
	}
	body += `</g>\n<g class="sp-fields">`;
	const groups = new Map<number, FieldPlan[]>();
	for (const f of t.fields as FieldPlan[]) {
		const list = groups.get(f.offset) || [];
		list.push(f);
		groups.set(f.offset, list);
	}
	for (const [offset, fields] of groups.entries()) {
		const isBitfield = fields.some((f) => f.bitSize && f.bitSize < 8);
		const x = PAD + offset * scale;
		const y = PAD + AXIS;
		if (!isBitfield) {
			const f = fields[0]!;
			const w = f.size * scale;
			const c = fillFor(`${t.name}.${f.name}`);
			body += `<g class="sp-field"><title>${f.name} : ${fieldTypeLabel(f.type)} · ${f.size}b @ +${f.offset}</title>`;
			body += `<rect x="${x}" y="${y}" width="${Math.max(w, 1)}" height="${rowH}" rx="3" fill="${c.bg}" stroke="${c.stroke}" stroke-width="1.25" />`;
			if (w > 28) {
				body += `<text x="${x + w / 2}" y="${y + rowH / 2 - 2}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="600" fill="${c.stroke}">${f.name}</text>`;
				if (rowH > 26) {
					body += `<text x="${x + w / 2}" y="${y + rowH / 2 + 11}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="8.5" fill="${c.stroke}" fill-opacity="0.75">${fieldTypeLabel(f.type)}</text>`;
				}
			}
			body += `</g>`;
			if (f.paddingAfter > 0) {
				const pw = f.paddingAfter * scale;
				body += `<g class="sp-pad"><title>pad · ${f.paddingAfter}b @ +${f.offset + f.size}</title>`;
				body += `<rect x="${x + w}" y="${y}" width="${pw}" height="${rowH}" rx="3" fill="url(#sp-pad)" stroke="currentColor" stroke-opacity="0.18" stroke-dasharray="3 2" /></g>`;
			}
		} else {
			const containerW = scale;
			body += `<g class="sp-bitfield"><rect x="${x}" y="${y}" width="${containerW}" height="${rowH}" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.25" />`;
			for (const f of fields) {
				const bx = x + (f.bitOffset * containerW) / 8;
				const bw = (f.bitSize * containerW) / 8;
				const c = fillFor(`${t.name}.${f.name}`);
				body += `<g><title>${f.name} : ${f.bitSize}b @ +${offset}.${f.bitOffset}</title>`;
				body += `<rect x="${bx}" y="${y + 2}" width="${bw}" height="${rowH - 4}" fill="${c.bg}" />`;
				if (f.bitOffset > 0)
					body += `<line x1="${bx}" y1="${y}" x2="${bx}" y2="${y + rowH}" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="2 2" />`;
				body += `</g>`;
			}
			body += `</g>`;
		}
	}
	body += `</g>`;
	return svgWrap(cfg.width!, totalH, body, `${t.name} memory layout`);
}

function renderStructGrid(t: any, cfg: SvgConfig): string {
	const totalSize: number = t.paddedSize || t.size;
	if (totalSize <= 0) return svgWrap(cfg.width!, 60, "", t.name);
	// Grid renders one SVG cell per byte. For multi-KB structures (large
	// bounded arrays, profile blobs) this explodes the output. Cap it and
	// emit a compact placeholder; the bars view still shows the field
	// layout, and language exporters carry the precise byte offsets.
	const GRID_BYTES_CAP = 4096;
	if (totalSize > GRID_BYTES_CAP) {
		const msg = `${t.name}: ${totalSize.toLocaleString()} bytes — grid suppressed (cap ${GRID_BYTES_CAP})`;
		const body = `<g><rect x="${PAD}" y="${PAD}" width="${cfg.width! - PAD * 2}" height="60" rx="6" fill="url(#sp-pad)" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="4 3" /><text x="${cfg.width! / 2}" y="${PAD + 36}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="currentColor" fill-opacity="0.65">${msg}</text></g>`;
		return svgWrap(cfg.width!, 60 + PAD * 2, body, t.name);
	}
	const rowBytes =
		cfg.rowBytes ?? Math.min(16, Math.max(4, totalSize <= 8 ? totalSize : 8));
	const cols = rowBytes;
	const rows = Math.ceil(totalSize / rowBytes);
	const innerW = cfg.width! - PAD * 2;
	const cell = Math.floor(innerW / cols);
	const cellH = Math.max(28, Math.round(cell * 0.7));
	const totalW = PAD * 2 + cell * cols;
	const totalH = PAD * 2 + cellH * rows;

	const fieldByByte = new Map<
		number,
		{ f: FieldPlan; isPad: boolean; relIdx: number }
	>();
	for (const f of t.fields as FieldPlan[]) {
		for (let b = 0; b < f.size; b++)
			fieldByByte.set(f.offset + b, { f, isPad: false, relIdx: b });
		for (let b = 0; b < (f.paddingAfter || 0); b++)
			fieldByByte.set(f.offset + f.size + b, { f, isPad: true, relIdx: b });
	}

	let body = `<g class="sp-grid" font-family="ui-monospace, monospace" font-size="9">`;
	for (let i = 0; i < totalSize; i++) {
		const r = Math.floor(i / cols);
		const c = i % cols;
		const x = PAD + c * cell;
		const y = PAD + r * cellH;
		const ent = fieldByByte.get(i);
		if (!ent) {
			body += `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cellH - 2}" rx="3" fill="url(#sp-pad)" stroke="currentColor" stroke-opacity="0.18" />`;
			body += `<text x="${x + 4}" y="${y + 11}" fill="currentColor" fill-opacity="0.45">${i.toString(16).padStart(2, "0")}</text>`;
			continue;
		}
		const { f, isPad, relIdx } = ent;
		const fill = isPad ? `url(#sp-pad)` : fillFor(`${t.name}.${f.name}`).bg;
		const stroke = isPad
			? `currentColor`
			: fillFor(`${t.name}.${f.name}`).stroke;
		body += `<g><title>${isPad ? "pad" : `${f.name} : ${fieldTypeLabel(f.type)}`} @ +${i}</title>`;
		body += `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cellH - 2}" rx="3" fill="${fill}" stroke="${stroke}" stroke-opacity="${isPad ? 0.2 : 0.55}" stroke-width="1" />`;
		body += `<text x="${x + 4}" y="${y + 11}" fill="currentColor" fill-opacity="0.55">${i.toString(16).padStart(2, "0")}</text>`;
		if (relIdx === 0 && !isPad && cell > 26) {
			body += `<text x="${x + cell / 2}" y="${y + cellH - 6}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="9.5" font-weight="600" fill="${stroke}">${f.name}</text>`;
		}
		body += `</g>`;
	}
	body += `</g>`;
	return svgWrap(totalW, totalH, body, `${t.name} memory layout (grid)`);
}

function renderEnum(t: any, cfg: SvgConfig): string {
	const variants: { name: string; value: number }[] = t.variants;
	const cols = Math.min(4, Math.max(1, variants.length));
	const rows = Math.ceil(variants.length / cols);
	const innerW = cfg.width! - PAD * 2;
	const cellW = Math.floor(innerW / cols);
	const cellH = 30;
	const totalW = PAD * 2 + cellW * cols;
	const totalH = PAD * 2 + cellH * rows + TITLE_GAP;

	let body = `<g class="sp-enum" font-family="Inter, system-ui, sans-serif" font-size="11">`;
	body += `<text x="${PAD}" y="${PAD + 11}" fill="currentColor" fill-opacity="0.55" font-family="ui-monospace, monospace" font-size="9">enum · ${t.underlyingType} · ${variants.length} variants</text>`;
	variants.forEach((v, i) => {
		const r = Math.floor(i / cols);
		const c = i % cols;
		const x = PAD + c * cellW;
		const y = PAD + TITLE_GAP + r * cellH;
		const col = fillFor(v.name);
		body += `<g><title>${v.name} = ${v.value}</title>`;
		body += `<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="14" fill="${col.bg}" stroke="${col.stroke}" stroke-width="1" />`;
		body += `<circle cx="${x + 16}" cy="${y + cellH / 2}" r="9" fill="${col.stroke}" />`;
		body += `<text x="${x + 16}" y="${y + cellH / 2 + 3.5}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--sp-paper, #fff)">${v.value}</text>`;
		body += `<text x="${x + 30}" y="${y + cellH / 2 + 3.5}" font-weight="600" fill="${col.stroke}">${v.name}</text>`;
		body += `</g>`;
	});
	body += `</g>`;
	return svgWrap(totalW, totalH, body, `${t.name} enum variants`);
}

function renderUnion(t: any, cfg: SvgConfig): string {
	const totalSize: number = t.paddedSize || t.size;
	if (totalSize <= 0) return svgWrap(cfg.width!, 60, "", t.name);
	const rowH = cfg.rowHeight!;
	const innerW = cfg.width! - PAD * 2;
	const scale = innerW / totalSize;
	const totalH = AXIS + rowH + PAD * 2 + TITLE_GAP + 14 * t.variants.length;
	const minorTicks = totalSize <= 256;
	const stride = minorTicks ? 1 : Math.max(1, Math.floor(totalSize / 8));
	let body = `<g class="sp-axis" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity="0.55">`;
	const ticks = new Set<number>();
	if (minorTicks) {
		for (let i = 0; i <= totalSize; i++) ticks.add(i);
	} else {
		for (let i = 0; i <= totalSize; i += stride) ticks.add(i);
		ticks.add(totalSize);
		ticks.add(t.tagOffset);
		ticks.add(t.tagOffset + t.tagSize);
	}
	for (const i of [...ticks].sort((a, b) => a - b)) {
		const x = PAD + i * scale;
		const major =
			i === 0 ||
			i === t.tagOffset ||
			i === t.tagOffset + t.tagSize ||
			i === totalSize;
		body += `<line x1="${x}" y1="${PAD + AXIS}" x2="${x}" y2="${PAD + AXIS + rowH}" stroke="currentColor" stroke-opacity="${major ? 0.2 : 0.08}" />`;
		if (major)
			body += `<text x="${x}" y="${PAD + AXIS - 4}" text-anchor="middle">+${i}</text>`;
	}
	body += `</g>`;
	const tagX = PAD + t.tagOffset * scale;
	const tagW = t.tagSize * scale;
	const payloadX = tagX + tagW;
	const payloadW = (totalSize - t.tagOffset - t.tagSize) * scale;
	const tagCol = fillFor(`${t.name}.tag`);
	const payCol = fillFor(`${t.name}.payload`);
	body += `<g class="sp-union">`;
	body += `<g><title>tag : ${t.tagType} · ${t.tagSize}b @ +${t.tagOffset}</title>`;
	body += `<rect x="${tagX}" y="${PAD + AXIS}" width="${tagW}" height="${rowH}" rx="3" fill="${tagCol.bg}" stroke="${tagCol.stroke}" stroke-width="1.25" />`;
	body += `<text x="${tagX + tagW / 2}" y="${PAD + AXIS + rowH / 2 + 4}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="600" fill="${tagCol.stroke}">tag</text></g>`;
	body += `<g><title>payload · ${totalSize - t.tagOffset - t.tagSize}b</title>`;
	body += `<rect x="${payloadX}" y="${PAD + AXIS}" width="${payloadW}" height="${rowH}" rx="3" fill="${payCol.bg}" stroke="${payCol.stroke}" stroke-width="1.25" stroke-dasharray="4 3" />`;
	body += `<text x="${payloadX + payloadW / 2}" y="${PAD + AXIS + rowH / 2 + 4}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="600" fill="${payCol.stroke}">payload</text></g>`;
	body += `</g>`;
	body += `<g class="sp-variants" font-family="Inter, system-ui, sans-serif" font-size="10">`;
	body += `<text x="${PAD}" y="${PAD + AXIS + rowH + TITLE_GAP}" fill="currentColor" fill-opacity="0.55" font-family="ui-monospace, monospace" font-size="9">${t.variants.length} variants</text>`;
	t.variants.forEach((v: any, i: number) => {
		const y = PAD + AXIS + rowH + TITLE_GAP + 14 + i * 14;
		const col = fillFor(v.name);
		body += `<circle cx="${PAD + 5}" cy="${y - 3}" r="3.5" fill="${col.stroke}" />`;
		body += `<text x="${PAD + 14}" y="${y}" font-weight="600" fill="currentColor" fill-opacity="0.85">${v.name}</text>`;
		body += `<text x="${PAD + 14 + (v.name.length * 6.5) + 8}" y="${y}" fill="currentColor" fill-opacity="0.5" font-family="ui-monospace, monospace" font-size="9">${fieldTypeLabel(v.type)}</text>`;
	});
	body += `</g>`;
	return svgWrap(cfg.width!, totalH, body, `${t.name} union layout`);
}

function renderAlias(t: any, cfg: SvgConfig): string {
	const totalH = PAD * 2 + 30;
	const body = `<g class="sp-alias" font-family="Inter, system-ui, sans-serif" font-size="12">
<text x="${PAD}" y="${PAD + 18}" font-weight="700" fill="currentColor">${t.name}</text>
<text x="${PAD + (t.name.length * 7.5) + 8}" y="${PAD + 18}" fill="currentColor" fill-opacity="0.4" font-size="14">≡</text>
<text x="${PAD + (t.name.length * 7.5) + 24}" y="${PAD + 18}" font-family="ui-monospace, monospace" fill="${fillFor(t.name).stroke}">${fieldTypeLabel(t.type)}</text>
<text x="${PAD}" y="${PAD + 18 + 14}" fill="currentColor" fill-opacity="0.5" font-family="ui-monospace, monospace" font-size="9">alias · ${t.size}b · align ${t.align}</text>
</g>`;
	return svgWrap(cfg.width!, totalH, body, `${t.name} alias`);
}

export function svg(
	config: SvgConfig = {},
): ExporterPlugin<SvgConfig, Record<string, string>> {
	const cfg = {
		width: 800,
		rowHeight: 36,
		mode: "bars",
		commentStyle: "none",
		...config,
	} as Required<Pick<SvgConfig, "width" | "rowHeight" | "mode">> & SvgConfig;

	return {
		name: "svg",
		extension: "svg",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const results: Record<string, string> = {};
			for (const t of plan.types as TypePlan[]) {
				const key = `${t.name}.svg`;
				if (t.kind === "struct") {
					results[key] =
						cfg.mode === "grid"
							? renderStructGrid(t, cfg)
							: renderStructBars(t, cfg);
				} else if (t.kind === "enum") {
					results[key] = renderEnum(t, cfg);
				} else if (t.kind === "union") {
					results[key] = renderUnion(t, cfg);
				} else if (t.kind === "alias") {
					results[key] = renderAlias(t, cfg);
				}
			}
			return results;
		},
	};
}

export const svgInternal = {
	renderStructBars,
	renderStructGrid,
	renderEnum,
	renderUnion,
	renderAlias,
	fieldTypeLabel,
};
