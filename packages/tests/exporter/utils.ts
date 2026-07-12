import { fromModule, SchemaAnalyzer } from "@schema-pop/core";

function toSemver(v: string): string {
	const stripped = v.replace(/^v/, "");
	const parts = stripped.split(".");
	while (parts.length < 3) parts.push("0");
	return parts.slice(0, 3).map((p) => p || "0").join(".");
}

export function analyze(s: any, version: string, layout: any = "aligned") {
	return new SchemaAnalyzer().analyze(fromModule(s.export ? s.export() : s), {
		wordSize: "64",
		layout,
		mode: "binary",
		version: toSemver(version),
		endian: "le",
	}).plan;
}
