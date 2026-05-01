import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	Field,
	FunctionPlan,
	TypePlan,
} from "schema-pop";
import { ExporterTools } from "schema-pop";

export interface MdConfig extends Omit<BaseConfig, "commentStyle"> {
	commentStyle?: "hash" | "none";
	/**
	 * Optional preamble inserted at the top of the generated file (before
	 * the `# version` heading). Plain markdown.
	 */
	preamble?: string;
}

/**
 * Markdown documentation exporter — renders the LayoutPlan as a
 * human-readable .md file. Sections per version: types (struct, union,
 * enum, alias) followed by functions when present. Designed for
 * embedding in a docs site (mkdocs / docusaurus / GH Pages).
 */
export function md(config: MdConfig = {}): ExporterPlugin<MdConfig> {
	const cfg: MdConfig = {
		commentStyle: "none",
		fieldNaming: "original",
		typeNaming: "original",
		...config,
	};
	const { typeName, fieldName } = ExporterTools(cfg as BaseConfig);

	function fieldText(f: Field): string {
		switch (f.kind) {
			case "primitive":
				return `\`${(f as any).name}\``;
			case "reference":
				return `[\`${(f as any).name}\`](#${anchor((f as any).name)})`;
			case "string":
				return `\`string\``;
			case "array": {
				const item = fieldText((f as any).item);
				const len = (f as any).exactLength;
				return len !== undefined ? `${item}\\[${len}\\]` : `${item}\\[\\]`;
			}
			case "optional":
				return `${fieldText((f as any).inner)}?`;
			case "inlineStruct":
				return "`{ … }`";
			case "map":
				return `\`Map<${(f as any).keyKind}, ${fieldText((f as any).value)}>\``;
			case "any":
				return "`any`";
			case "unit":
				return "`void`";
			default:
				return "`unknown`";
		}
	}

	function anchor(name: string): string {
		return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	}

	function renderType(t: TypePlan): string {
		const tAny = t as any;
		const lines: string[] = [];
		const obsoleteTag = tAny.obsolete
			? ` _[deprecated${tAny.obsoleteReason ? `: ${tAny.obsoleteReason}` : ""}]_`
			: "";
		lines.push(`### \`${typeName(t.name)}\` <small>${t.kind}</small>${obsoleteTag}`);
		lines.push("");
		if (tAny.description) {
			lines.push(`> ${tAny.description.replace(/\n/g, "\n> ")}`);
			lines.push("");
		}
		lines.push(
			`<sub>size **${t.size}** · align **${t.align}** · padded **${t.paddedSize}**</sub>`,
		);
		lines.push("");
		if (t.kind === "struct") {
			lines.push("| Offset | Field | Type | Size | Notes |");
			lines.push("|-------:|-------|------|-----:|-------|");
			for (const f of t.fields) {
				const fAny = f as any;
				const notes: string[] = [];
				if (fAny.obsolete)
					notes.push(`_deprecated${fAny.obsoleteReason ? `: ${fAny.obsoleteReason}` : ""}_`);
				if (fAny.description) notes.push(fAny.description.replace(/\|/g, "\\|"));
				lines.push(
					`| ${f.offset} | \`${fieldName(f.name)}\` | ${fieldText(f.type)} | ${f.size} | ${notes.join("; ")} |`,
				);
			}
		} else if (t.kind === "enum") {
			lines.push("| Variant | Value |");
			lines.push("|---------|------:|");
			for (const v of t.variants) {
				lines.push(`| \`${v.name}\` | ${v.value} |`);
			}
		} else if (t.kind === "union") {
			lines.push(`<sub>tag size **${t.tagSize}** at offset **${t.tagOffset}**</sub>`);
			lines.push("");
			lines.push("| Variant | Type |");
			lines.push("|---------|------|");
			for (const v of t.variants) {
				lines.push(`| \`${v.name}\` | ${fieldText(v.type)} |`);
			}
		} else if (t.kind === "alias") {
			lines.push(`Alias for ${fieldText((t as any).type)}.`);
		}
		lines.push("");
		return lines.join("\n");
	}

	function renderFunction(fn: FunctionPlan): string {
		const lines: string[] = [];
		const abiSuffix = fn.abi ? ` _\`extern "${fn.abi}"\`_` : "";
		const obsoleteTag = fn.obsolete
			? ` _[deprecated${fn.obsoleteReason ? `: ${fn.obsoleteReason}` : ""}]_`
			: "";
		lines.push(`### \`${fn.name}\`${abiSuffix}${obsoleteTag}`);
		lines.push("");
		if (fn.description) {
			lines.push(`> ${fn.description.replace(/\n/g, "\n> ")}`);
			lines.push("");
		}
		const sigArgs = fn.args
			.map((a) => `${a.name ? `${a.name}: ` : ""}${fieldText(a.type)}`)
			.join(", ");
		const ret =
			fn.returnType.kind === "unit" ? "`void`" : fieldText(fn.returnType);
		lines.push(`\`\`\``);
		lines.push(
			`${fn.name}(${fn.args
				.map((a) =>
					`${a.name ?? "_"}: ${plainFieldText(a.type)}`,
				)
				.join(", ")}) -> ${plainFieldText(fn.returnType)}`,
		);
		lines.push(`\`\`\``);
		lines.push("");
		lines.push(`Signature: ${fn.name}(${sigArgs}) → ${ret}`);
		if (fn.symbol && fn.symbol !== fn.name) {
			lines.push("");
			lines.push(`Symbol: \`${fn.symbol}\``);
		}
		lines.push("");
		return lines.join("\n");
	}

	function plainFieldText(f: Field): string {
		switch (f.kind) {
			case "primitive":
				return (f as any).name;
			case "reference":
				return (f as any).name;
			case "string":
				return "string";
			case "array": {
				const item = plainFieldText((f as any).item);
				const len = (f as any).exactLength;
				return len !== undefined ? `${item}[${len}]` : `${item}[]`;
			}
			case "optional":
				return `${plainFieldText((f as any).inner)}?`;
			case "unit":
				return "void";
			default:
				return f.kind;
		}
	}

	return {
		name: "md",
		config: cfg,
		wrapVersion: (version, code) =>
			`# v${version}\n\n${code}\n`,
		generate: (plan: LayoutPlan) => {
			const parts: string[] = [];
			if (cfg.preamble) {
				parts.push(cfg.preamble);
				parts.push("");
			}
			if (plan.types.length > 0) {
				parts.push("## types");
				parts.push("");
				for (const t of plan.types) parts.push(renderType(t));
			}
			if (plan.functions && plan.functions.length > 0) {
				parts.push("## functions");
				parts.push("");
				for (const fn of plan.functions) parts.push(renderFunction(fn));
			}
			return parts.join("\n");
		},
	};
}
