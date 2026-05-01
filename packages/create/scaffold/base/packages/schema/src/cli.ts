import { buildConfig } from "schema-pop";

console.log("🚀 Building schema...");
buildConfig("pop.config.ts")
	.then(() => {
		console.log("✨ Schema build complete.");
	})
	.catch((err) => {
		console.error("❌ Schema build failed:", err);
		process.exit(1);
	});
