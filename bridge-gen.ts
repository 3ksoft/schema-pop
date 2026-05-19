import { $bridge } from "./packages/tests/vault/bridge.1.pop.ts";
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import { exportPlan } from "@schema-pop/exporter";

const schema = fromModule($bridge.export());
console.log("=== SCHEMA TYPES ===");
for (const [k, v] of Object.entries(schema.types)) {
	console.log(k, JSON.stringify(v));
}

const analyzer = new SchemaAnalyzer(schema, {
	wordSize: "64",
	autoLayout: false,
	layoutType: "aligned",
	mode: "binary",
});
const plan = analyzer.analyze("1.0", "le");
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
