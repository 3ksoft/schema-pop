import { scope } from "arktype";
import { wgsl } from "./packages/schema/src/wgsl";
import { fromModule, SchemaAnalyzer } from "./packages/core/src";

const atomicScope = scope({
    ...wgsl.import(),
    // single_grid: `ai32[] == 4`,
    spatials: {
        collision_grid: `ai32[] == 4`,
    }
});
const exported = atomicScope.export();
console.log("Exported types:", Object.keys(exported));


console.log("----- EXPORTED FROM ARKTYPE -------")
const schema = fromModule(exported);
console.log("Schema types:", JSON.stringify(schema, null, 2));

const analyzer = new SchemaAnalyzer();
const plan = analyzer.analyze(schema, { version: "1.0.0" });

console.log("\n\n");

console.log("----- PROCESSED BY ANALYZER -------")
console.log("Analyzer types:", JSON.stringify(plan, null, 2));