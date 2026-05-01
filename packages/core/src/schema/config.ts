import { scope } from "arktype";
import type { ExporterPlugin } from "./exporter";

export const $config = scope({
	BinaryVersion: {
		mode: "'binary' = 'binary'",
		version: "string",
		source: "string",
		"exportName?": "string",
	},

	RichVersion: {
		mode: "'rich'",
		version: "string",
		source: "string",
		"exportName?": "string",
	},

	VersionConfig: "BinaryVersion | RichVersion",
});

export const { BinaryVersion, RichVersion, VersionConfig } = $config.export();

export type BinaryVersion = typeof BinaryVersion.infer;
export type RichVersion = typeof RichVersion.infer;
export type VersionConfig = typeof VersionConfig.infer;

export interface SchemaConfig {
	name: string;
	versions: VersionConfig[];
	targets?: ExporterPlugin<any>[];
}

export interface PopConfig {
	endian?: "le" | "be";
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layout?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
	schemas: SchemaConfig[];
}

export function defineConfig(config: PopConfig): PopConfig {
	return config;
}
