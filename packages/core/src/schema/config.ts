import type { ExporterPlugin } from "./exporter";

export interface VersionConfig {
	version: string;
	source: string;
	exportName?: string;
}

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
