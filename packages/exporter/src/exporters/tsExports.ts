import type {
	BaseConfig,
	ExporterPlugin,
	LayoutPlan,
	TypePlan,
	UnionPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface TsExportsConfig extends Omit<BaseConfig, "commentStyle"> {
	scopeVar?: string;
	importFrom?: string;
}

export function tsExports(
	config: TsExportsConfig,
): ExporterPlugin<TsExportsConfig> {
	const cfg = {
		fieldNaming: "original",
		typeNaming: "original",
		...config,
	} as any;
	const { typeName } = ExporterTools(cfg);
	const scopeVar = config.scopeVar ?? "$";

	return {
		name: "ts-exports",
		extension: "ts",
		config: cfg,
		getFileHeader: () =>
			config.importFrom
				? `import { ${scopeVar} } from ${JSON.stringify(config.importFrom)};\n\n`
				: "",
		generate: (plan: LayoutPlan) => {
			const visibleTypes = plan.types.filter((t) => !(t as any).syntetic);
			const unions = plan.types.filter(
				(t) => t.kind === "union",
			) as UnionPlan[];
			let code = `export const {\n`;
			for (const t of visibleTypes) {
				code += `\t${typeName(t.name)},\n`;
			}
			code += `} = ${scopeVar}.export();\n\n`;
			for (const t of visibleTypes) {
				code += `export type ${typeName(t.name)} = typeof ${typeName(t.name)}.infer;\n`;
			}
			if (unions.length > 0) {
				code += "\n";
				for (const t of unions) {
					const variants = t.variants.map((v) => `"${v.name}"`).join(" | ");
					code += `export type ${typeName(t.name)}Tag = ${variants};\n`;
				}
			}
			return code;
		},
		wrapVersion: (_version, code) => code,
	};
}
