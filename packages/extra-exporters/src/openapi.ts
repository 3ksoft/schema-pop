import type { LayoutPlan, BaseConfig, ExporterPlugin } from "schema-pop";

export interface OpenApiConfig extends BaseConfig {}

export function openapi(config: OpenApiConfig): ExporterPlugin<OpenApiConfig> {
	const cfg = { commentStyle: "none", ...config } as OpenApiConfig;
	return {
		name: "openapi",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const doc = {
				openapi: "3.0.3",
				info: { title: "Generated API", version: plan.version || "1.0.0" },
				components: { schemas: {} as any },
			};
			for (const t of plan.types) {
				const tAny = t as any;
				if (t.kind === "struct") {
					const schema: any = { type: "object", properties: {} };
					if (tAny.description) schema.description = tAny.description;
					if (tAny.obsolete) {
						schema.deprecated = true;
						if (tAny.obsoleteReason)
							schema.description =
								(schema.description ? schema.description + " — " : "") +
								`DEPRECATED: ${tAny.obsoleteReason}`;
					}
					for (const f of t.fields) {
						const fAny = f as any;
						const prop: any = {
							type: f.type.kind === "primitive" ? "integer" : "string",
						};
						if (fAny.description) prop.description = fAny.description;
						if (fAny.obsolete) {
							prop.deprecated = true;
							if (fAny.obsoleteReason)
								prop.description =
									(prop.description ? prop.description + " — " : "") +
									`DEPRECATED: ${fAny.obsoleteReason}`;
						}
						schema.properties[f.name] = prop;
					}
					doc.components.schemas[t.name] = schema;
				} else if (t.kind === "enum") {
					const schema: any = {
						type: "string",
						enum: t.variants.map((v: any) => v.name),
					};
					if (tAny.description) schema.description = tAny.description;
					if (tAny.obsolete) {
						schema.deprecated = true;
						if (tAny.obsoleteReason)
							schema.description =
								(schema.description ? schema.description + " — " : "") +
								`DEPRECATED: ${tAny.obsoleteReason}`;
					}
					doc.components.schemas[t.name] = schema;
				}
			}
			return JSON.stringify(doc, null, 2);
		},
	};
}
