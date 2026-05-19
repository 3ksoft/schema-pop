import * as coreExporters from "@schema-pop/exporter";
import * as extraExporters from "@schema-pop/exporter";
import { fromFileName } from "@schema-pop/importer";
import { AnalyzerConfig, SchemaAnalyzer } from "schema-pop";

const EMIT_PACKAGE_BY_TYPE: Record<string, "core" | "extra"> = {
	rust: "core",
	c: "core",
	cpp: "core",
	ts: "core",
	zig: "core",
	go: "core",
	random: "core",
	md: "core",
	tsCodec: "core",
	html: "extra",
	wgsl: "extra",
	glsl: "extra",
	svg: "extra",
	openapi: "extra",
	mermaid: "extra",
	nuxtUi: "extra",
	brainfuck: "extra",
	jsonSchema: "extra",
};

const wasmHook = async (name: string) => {
	const url = `${import.meta.env.BASE_URL}wasm/${name}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch ${url}`);
	return res.arrayBuffer();
};

export interface AnalyzerConfig {
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layoutType?:
		| "aligned"
		| "zero-padding"
		| "std140"
		| "std430"
		| "dynamic"
		| "dbus";
	mode?: "binary" | "rich";
}

export interface AnalyzeResult {
	schema: Awaited<ReturnType<typeof fromFileName>>;
	plan: ReturnType<SchemaAnalyzer["analyze"]> | null;
	typesCount: number;
	errors: string[];
	warnings: string[];
	error?: string;
}

export async function analyze(
	fileName: string,
	text: string,
	config: AnalyzerConfig = {},
): Promise<AnalyzeResult> {
	const schema = await fromFileName(fileName, text, {
		treeSitterWasmHook: wasmHook,
	});
	const typesCount = Object.keys(schema.items).length;
	const analyzer = new SchemaAnalyzer(
		schema.items,
		AnalyzerConfig.assert({
			mode: config.mode || "rich",
			...config,
		}),
	);
	try {
		const plan = analyzer.analyze("1.0.0");
		return {
			schema,
			plan,
			typesCount,
			errors: [],
			warnings: analyzer.getWarnings(),
		};
	} catch (err) {
		return {
			schema,
			plan: null,
			typesCount,
			errors: analyzer.getErrors(),
			warnings: analyzer.getWarnings(),
			error: String(err),
		};
	}
}

export async function convert(
	fileName: string,
	text: string,
	targetFormat: string,
	config: AnalyzerConfig = {},
): Promise<string> {
	// 1. Importer
	const schema = await fromFileName(fileName, text, {
		treeSitterWasmHook: wasmHook,
	});

	// 2. Analyzer
	const analyzer = new SchemaAnalyzer(schema.items, {
		mode: config.mode || "rich",
		...config,
	});
	const plan = analyzer.analyze("1.0.0");

	// 3. Exporter
	const pkg = EMIT_PACKAGE_BY_TYPE[targetFormat];
	if (!pkg) {
		throw new Error(`Unknown target format: ${targetFormat}`);
	}

	const mod = pkg === "core" ? coreExporters : extraExporters;
	const factory = (mod as any)[targetFormat];

	if (typeof factory !== "function") {
		throw new Error(
			`Exporter factory "${targetFormat}" not found in ${pkg}-exporters`,
		);
	}

	const exporterData = { name: targetFormat, instance: factory({}) };
	const generated = await exporterData.instance.generate(plan);

	return typeof generated === "string"
		? generated
		: JSON.stringify(generated, null, 2);
}
