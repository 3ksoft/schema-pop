import { SchemaAnalyzer } from "./layout/analyzer";
import { testScope } from "./schema/test";

const analyzer = new SchemaAnalyzer(testScope);

try {
	const plan = analyzer.analyze("1.0");
	console.log("✅ analyze() ok");
	console.log(
		"types:",
		plan.types.map((t) => `${t.name}(${t.kind})`).join(", "),
	);
	for (const t of plan.types) {
		console.log(JSON.stringify(t, null, 2));
	}
} catch (e: any) {
	console.log("❌ analyze() failed:", e.message);
	console.log("collected errors:", analyzer.getErrors());
}
