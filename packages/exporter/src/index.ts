import { type LayoutPlan, type ExporterPlugin } from "@schema-pop/schema";

import { c, type CConfig } from "./exporters/c";
import { cpp, type CppConfig } from "./exporters/cpp";
import { go, type GoConfig } from "./exporters/go";
import { md, type MdConfig } from "./exporters/md";
import { random, type RandomConfig } from "./exporters/random";
import { rust, type RustConfig } from "./exporters/rust";
import { ts, type TsConfig } from "./exporters/ts";
import { tsCodec, type TsCodecConfig } from "./exporters/tsCodec";
import { tsExports, type TsExportsConfig } from "./exporters/tsExports";
import { zig, type ZigConfig } from "./exporters/zig";
import { brainfuck, type BrainfuckConfig } from "./exporters/bf";
import { glsl, type GlslConfig } from "./exporters/glsl";
import { html, type HtmlConfig } from "./exporters/html";
import { jsonSchema, type JsonSchemaConfig } from "./exporters/jsonSchema";
import { mermaid, type MermaidConfig } from "./exporters/mermaid";
import { nuxtUi, type NuxtUiConfig } from "./exporters/vueNuxtUi";
import { openapi, type OpenApiConfig } from "./exporters/openapi";
import { svg, type SvgConfig } from "./exporters/svg";
import { wgsl, type WgslConfig } from "./exporters/wgsl";
import { zigMatcher, type ZigMatcherConfig } from "./exporters/zigMatcher";
import { cppHarness } from "./exporters/cppHarness";
import { goHarness } from "./exporters/goHarness";
import { rustHarness } from "./exporters/rustHarness";
import { zigHarness } from "./exporters/zigHarness";
import { brainfuckHarness } from "./exporters/bfHarness";
import { rustSerde, type RustSerdeConfig } from "./exporters";

export { c, type CConfig };
export { cpp, type CppConfig };
export { go, type GoConfig };
export { md, type MdConfig };
export { random, type RandomConfig };
export { rust, type RustConfig };
export { rustSerde, type RustSerdeConfig };
export { ts, type TsConfig };
export { tsCodec, type TsCodecConfig };
export { tsExports, type TsExportsConfig };
export { zig, type ZigConfig };
export { zigMatcher, type ZigMatcherConfig };
export { brainfuck, type BrainfuckConfig };
export { glsl, type GlslConfig };
export { html, type HtmlConfig };
export { jsonSchema, type JsonSchemaConfig };
export { mermaid, type MermaidConfig };
export { nuxtUi, type NuxtUiConfig };
export { openapi, type OpenApiConfig };
export { svg, type SvgConfig };
export { wgsl, type WgslConfig };

// ── Harness wrappers ──────────────────────────────────────────────────────────
// Harness exporters take `LayoutPlan[]` (cross-version) and emit a multi-file
// project. To plug into the single-plan ExporterPlugin pipeline, wrap them so
// that a single plan is passed as `[plan]`.

export interface HarnessConfig {
	pkg?: string;
	versionPrefixed?: boolean;
}

function harnessPlugin(
	name: string,
	build: (plans: LayoutPlan[], cfg: HarnessConfig) => Record<string, string>,
): (cfg?: HarnessConfig) => ExporterPlugin<any> {
	return (cfg: HarnessConfig = {}) => ({
		name,
		config: cfg as any,
		generate: (plan: LayoutPlan) => build([plan], cfg),
		wrapVersion: (_v, code) => code,
	});
}

export const cppHarnessExporter = harnessPlugin("cpp:harness", (plans) =>
	cppHarness(plans),
);
export const goHarnessExporter = harnessPlugin("go:harness", (plans, cfg) =>
	goHarness(plans, cfg.pkg ?? "harness", cfg.versionPrefixed ?? false),
);
export const rustHarnessExporter = harnessPlugin("rust:harness", (plans) =>
	rustHarness(plans),
);
export const zigHarnessExporter = harnessPlugin("zig:harness", (plans) =>
	zigHarness(plans),
);
export const bfHarnessExporter = harnessPlugin("bf:harness", () =>
	brainfuckHarness(),
);

export type ExporterTarget =
	| "c"
	| "cpp"
	| "go"
	| "md"
	| "random"
	| "rust"
	| "rust:serde"
	| "ts"
	| "ts:codec"
	| "ts:exports"
	| "zig"
	| "zig:matcher"
	| "bf"
	| "brainfuck"
	| "glsl"
	| "html"
	| "json:schema"
	| "mermaid"
	| "nuxt:ui"
	| "openapi"
	| "svg"
	| "wgsl"
	| "cpp:harness"
	| "go:harness"
	| "rust:harness"
	| "zig:harness"
	| "bf:harness";

export type ExporterConfigMap = {
	c: CConfig;
	cpp: CppConfig;
	go: GoConfig;
	md: MdConfig;
	random: RandomConfig;
	rust: RustConfig;
	"rust:serde": RustSerdeConfig;
	ts: TsConfig;
	"ts:codec": TsCodecConfig;
	"ts:exports": TsExportsConfig;
	zig: ZigConfig;
	"zig:matcher": ZigMatcherConfig;
	bf: BrainfuckConfig;
	brainfuck: BrainfuckConfig;
	glsl: GlslConfig;
	html: HtmlConfig;
	"json:schema": JsonSchemaConfig;
	mermaid: MermaidConfig;
	"nuxt:ui": NuxtUiConfig;
	openapi: OpenApiConfig;
	svg: SvgConfig;
	wgsl: WgslConfig;
	"cpp:harness": HarnessConfig;
	"go:harness": HarnessConfig;
	"rust:harness": HarnessConfig;
	"zig:harness": HarnessConfig;
	"bf:harness": HarnessConfig;
};

export function getExporter<T extends ExporterTarget>(
	target: T,
	config?: ExporterConfigMap[T],
): ExporterPlugin<any> {
	const cfg: any = config || {};
	switch (target) {
		case "c":
			return c(cfg);
		case "cpp":
			return cpp(cfg);
		case "go":
			return go(cfg);
		case "md":
			return md(cfg);
		case "random":
			return random(cfg);
		case "rust":
			return rust(cfg);
		case "rust:serde":
			return rustSerde(cfg);
		case "ts":
			return ts(cfg);
		case "ts:codec":
			return tsCodec(cfg);
		case "ts:exports":
			return tsExports(cfg);
		case "zig":
			return zig(cfg);
		case "zig:matcher":
			return zigMatcher(cfg);
		case "bf":
		case "brainfuck":
			return brainfuck(cfg);
		case "glsl":
			return glsl(cfg);
		case "html":
			return html(cfg);
		case "json:schema":
			return jsonSchema(cfg);
		case "mermaid":
			return mermaid(cfg);
		case "nuxt:ui":
			return nuxtUi(cfg);
		case "openapi":
			return openapi(cfg);
		case "svg":
			return svg(cfg);
		case "wgsl":
			return wgsl(cfg);
		case "cpp:harness":
			return cppHarnessExporter(cfg);
		case "go:harness":
			return goHarnessExporter(cfg);
		case "rust:harness":
			return rustHarnessExporter(cfg);
		case "zig:harness":
			return zigHarnessExporter(cfg);
		case "bf:harness":
			return bfHarnessExporter(cfg);
		default:
			throw new Error(`Unknown exporter target: ${target}`);
	}
}

export interface ExportOptions<T extends ExporterTarget> {
	target: T;
	config?: ExporterConfigMap[T];
	version?: string;
	endian?: "le" | "be";
	wordSize?: 32 | 64;
	layoutType?: "aligned" | "packed" | "std140" | "std430";
	mode?: "binary" | "rich";
}

export function exportPlan<T extends ExporterTarget>(
	plan: LayoutPlan,
	target: T,
	config?: ExporterConfigMap[T],
): string | Record<string, string> {
	const plugin = getExporter(target, config);
	const generated = plugin.generate(plan);

	if (typeof generated === "string") {
		const header = plugin.getFileHeader?.() ?? "";
		const footer = plugin.getFileFooter?.() ?? "";
		const wrapped = plugin.wrapVersion
			? plugin.wrapVersion(plan.version, generated)
			: generated;
		return header + wrapped + footer;
	}

	return generated;
}
