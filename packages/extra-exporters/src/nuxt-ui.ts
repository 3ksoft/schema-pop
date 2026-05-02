import type { LayoutPlan, BaseConfig, ExporterPlugin } from "schema-pop";
import { applyNaming } from "schema-pop";

export interface NuxtUiConfig extends BaseConfig {
	schemaImport?: string;
}

export function nuxtUi(config: NuxtUiConfig): ExporterPlugin<NuxtUiConfig> {
	const cfg = {
		fieldNaming: "original",
		typeNaming: "PascalCase",
		commentStyle: "slash",
		...config,
	} as NuxtUiConfig;
	return {
		name: "nuxt-ui",
		extension: "vue",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			let script = `<script setup lang="ts">\nimport { reactive } from 'vue';\n\n`;
			for (const t of plan.types) {
				if (t.kind === "struct") {
					script += `const state${t.name} = reactive({\n`;
					t.fields.forEach((f) => {
						if (f.type.kind !== "unit") {
							script += `  ${applyNaming(f.name, cfg.fieldNaming!)}: null,\n`;
						}
					});
					script += `});\n\n`;
				}
			}
			script += `</script>\n\n<template>\n  <div class="space-y-4">\n    <!-- Generated Forms -->\n  </div>\n</template>\n`;
			return script;
		},
	};
}
