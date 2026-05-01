import type { LayoutPlan, BaseConfig, ExporterPlugin } from "schema-pop";
import { ExporterTools } from "schema-pop";

export interface MdConfig extends Omit<BaseConfig, "commentStyle"> {
	commentStyle?: "none";
	includeTable?: boolean;
}

export function md(config: MdConfig): ExporterPlugin<MdConfig> {
	const cfg: MdConfig = { includeTable: true, commentStyle: "none", ...config };
	const { typeName } = ExporterTools(cfg);

	return {
		name: "md",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			let out = `# Schema Report - ${plan.version}\n\n`;
			out += `**Endian:** ${plan.endian === "le" ? "Little Endian" : "Big Endian"}  \n`;
			out += `**Word Size:** ${plan.wordSize}-bit\n\n`;

			for (const t of plan.types) {
				out += `## ${typeName(t.name)} (${t.kind})\n\n`;
				if (t.description) out += `${t.description}\n\n`;

				out += `**Total Size:** ${t.paddedSize || t.size} bytes  \n`;
				out += `**Alignment:** ${t.align}\n\n`;

				if (t.kind === "struct") {
					out += "| Offset | Field | Type | Size | Padding |\n";
					out += "| :--- | :--- | :--- | :--- | :--- |\n";
					for (const f of t.fields) {
						const offsetStr =
							f.bitSize && f.bitSize < 8
								? `${f.offset}.${f.bitOffset}`
								: `${f.offset}`;
						const typeStr =
							f.type.kind === "primitive" || f.type.kind === "reference"
								? f.type.name
								: f.type.kind;
						const sizeStr =
							f.bitSize && f.bitSize < 8 ? `${f.bitSize} bits` : `${f.size}b`;
						out += `| +${offsetStr} | **${f.name}** | \`${typeStr}\` | ${sizeStr} | ${f.paddingAfter || "-"} |\n`;
					}
					out += "\n";
				} else if (t.kind === "enum") {
					out += `**Underlying:** \`${t.underlyingType}\`\n\n`;
					out += "### Variants\n\n";
					for (const v of t.variants) {
						out += `- **${v.name}** (= ${v.value})\n`;
					}
					out += "\n";
				} else if (t.kind === "union") {
					out += `**Tag:** \`${t.tagType}\` @ +${t.tagOffset}\n\n`;
					out += "### Variants\n\n";
					for (const v of t.variants) {
						const target =
							v.type.kind === "reference" ? ` → \`${v.type.name}\`` : "";
						out += `- **${v.name}**${target}\n`;
					}
					out += "\n";
				} else if (t.kind === "alias") {
					const target =
						t.type.kind === "primitive" || t.type.kind === "reference"
							? `\`${t.type.name}\``
							: `\`${t.type.kind}\``;
					out += `**Aliases:** ${target}\n\n`;
				}
			}
			return out;
		},
	};
}
