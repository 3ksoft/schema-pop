import { $bridge } from "./vault/bridge.1";
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import { exportPlan } from "@schema-pop/exporter";

const ctx = fromModule($bridge.export());
console.log("=== SCHEMA TYPES ===");
for (const [k, v] of Object.entries(ctx.schema.types)) {
	console.log(k, JSON.stringify(v));
}

const analyzer = new SchemaAnalyzer();
const { plan } = analyzer.analyze(ctx, {
	wordSize: "64",
	layout: "aligned",
	mode: "binary",
	version: "1.0",
	endian: "le",
});
console.log("\n=== PLAN TYPES ===");
for (const t of plan.types) {
	console.log(
		t.name,
		t.kind,
		JSON.stringify(
			(t as any).fields?.map((f: any) => ({
				name: f.name,
				size: f.size,
				kind: f.type?.kind,
			})),
		),
	);
}

console.log("\n=== RUST OUTPUT ===");
const rustOut = exportPlan(plan, "rust");
console.log(rustOut);

console.log("\n=== TS CODEC OUTPUT ===");
const tsOut = exportPlan(plan, "ts:codec");
console.log(tsOut);
