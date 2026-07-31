import {
	type LayoutPlan,
	type ExporterPlugin,
	EXPORTER_REGISTRY,
} from "@schema-pop/schema";

import { c, type CConfig } from "./exporters/c";
import { cpp, type CppConfig } from "./exporters/cpp";
import { md, type MdConfig } from "./exporters/md";
import { random, type RandomConfig } from "./exporters/random";
import { rust, type RustConfig } from "./exporters/rust";
import { ts, type TsConfig } from "./exporters/ts";
import { tsCodec, type TsCodecConfig } from "./exporters/tsCodec";
import { tsExports, type TsExportsConfig } from "./exporters/tsExports";
import { zig, type ZigConfig } from "./exporters/zig";
import { brainfuck, type BrainfuckConfig } from "./exporters/bf";
import { html, type HtmlConfig } from "./exporters/html";
import { mermaid, type MermaidConfig } from "./exporters/mermaid";
import { svg, type SvgConfig } from "./exporters/svg";
import { wgsl, type WgslConfig } from "./exporters/wgsl";
import { cppHarness } from "./exporters/cppHarness";
import { rustHarness } from "./exporters/rustHarness";
import { zigHarness } from "./exporters/zigHarness";
import { brainfuckHarness } from "./exporters/bfHarness";
import { rustSerde, type RustSerdeConfig } from "./exporters";

export { c, type CConfig };
export { cpp, type CppConfig };
export { md, type MdConfig };
export { random, type RandomConfig };
export { rust, type RustConfig };
export { rustSerde, type RustSerdeConfig };
export { ts, type TsConfig };
export { tsCodec, type TsCodecConfig };
export { tsExports, type TsExportsConfig };
export { zig, type ZigConfig };
export { brainfuck, type BrainfuckConfig };
export { html, type HtmlConfig };
export { mermaid, type MermaidConfig };
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
): (cfg?: HarnessConfig) => ExporterPlugin<any, Record<string, string>> {
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
export const rustHarnessExporter = harnessPlugin("rust:harness", (plans) =>
	rustHarness(plans),
);
export const zigHarnessExporter = harnessPlugin("zig:harness", (plans) =>
	zigHarness(plans),
);
export const bfHarnessExporter = harnessPlugin("bf:harness", () =>
	brainfuckHarness(),
);

/**
 * The set of CLI-dispatchable exporter targets. Derived from
 * `EXPORTER_REGISTRY` (the single source of truth in `@schema-pop/schema`) so
 * the target list, config map, and factory table below can never silently
 * drift — the compiler forces them to match.
 *
 */
export type ExporterTarget = keyof typeof EXPORTER_REGISTRY;

export type ExporterConfigMap = {
	c: CConfig;
	cpp: CppConfig;
	rust: RustConfig;
	"rust:serde": RustSerdeConfig;
	ts: TsConfig;
	"ts:codec": TsCodecConfig;
	"ts:exports": TsExportsConfig;
	zig: ZigConfig;
	md: MdConfig;
	random: RandomConfig;
	bf: BrainfuckConfig;
	html: HtmlConfig;
	svg: SvgConfig;
	mermaid: MermaidConfig;
	wgsl: WgslConfig;
	"cpp:harness": HarnessConfig;
	"rust:harness": HarnessConfig;
	"zig:harness": HarnessConfig;
	"bf:harness": HarnessConfig;
};

// Compile-time guard: ExporterConfigMap must cover exactly ExporterTarget.
// If a target is added to EXPORTER_REGISTRY without a config entry (or vice
// versa) the assignment below stops type-checking.
type _MissingConfig = Exclude<ExporterTarget, keyof ExporterConfigMap>;
type _ExtraConfig = Exclude<keyof ExporterConfigMap, ExporterTarget>;
const _configMapExhaustive: [_MissingConfig, _ExtraConfig] extends [never, never]
	? true
	: { missing: _MissingConfig; extra: _ExtraConfig } = true;

// Factory table. The mapped type forces an entry for every ExporterTarget, so
// a target added to EXPORTER_REGISTRY won't compile until it's wired here.
const FACTORIES: {
	[K in ExporterTarget]: (cfg: any) => ExporterPlugin<any>;
} = {
	c,
	cpp,
	rust,
	"rust:serde": rustSerde,
	ts,
	"ts:codec": tsCodec,
	"ts:exports": tsExports,
	zig,
	md,
	random,
	bf: brainfuck,
	html,
	svg,
	mermaid,
	wgsl,
	"cpp:harness": cppHarnessExporter,
	"rust:harness": rustHarnessExporter,
	"zig:harness": zigHarnessExporter,
	"bf:harness": bfHarnessExporter,
};

export function getExporter<T extends ExporterTarget>(
	target: T,
	config?: ExporterConfigMap[T],
): ExporterPlugin<any> {
	const factory = FACTORIES[target];
	if (!factory) throw new Error(`Unknown exporter target: ${target}`);
	return factory(config ?? {});
}

// Multi-file targets (`svg` = one file per type, `*:harness` = a whole
// project) return `Record<filename, contents>`; every other target returns a
// single assembled string. Encoding that here lets `exportPlan(plan, "html")`
// type as `string` so callers can `save(path, exportPlan(...))` without a cast.
type ExportTargetOut<T extends ExporterTarget> = T extends
	| "svg"
	| `${string}:harness`
	? Record<string, string>
	: string;

export function exportPlan<T extends ExporterTarget>(
	plan: LayoutPlan,
	target: T,
	config?: ExporterConfigMap[T],
): ExportTargetOut<T> {
	const plugin = getExporter(target, config);
	const generated = plugin.generate(plan);

	if (typeof generated === "string") {
		const header = plugin.getFileHeader?.() ?? "";
		const footer = plugin.getFileFooter?.() ?? "";
		const wrapped = plugin.wrapVersion
			? plugin.wrapVersion(plan.version, generated)
			: generated;
		return (header + wrapped + footer) as ExportTargetOut<T>;
	}

	return generated as ExportTargetOut<T>;
}
