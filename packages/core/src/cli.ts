#!/usr/bin/env bun
/// <reference types="node" />

import { buildConfig } from "./node";

async function main() {
	const configPath = process.argv[2] || "pop.config.ts";
	try {
		await buildConfig(configPath);
		console.log("✨ Schema generation complete.");
	} catch (e) {
		console.error("❌ Build failed:", e);
		process.exit(1);
	}
}

main();
