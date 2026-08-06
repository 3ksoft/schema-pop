import type { LayoutPlan } from "@schema-pop/schema";

import {
	EXPORTER_REGISTRY,
	type ExporterTarget,
	type ExporterPlugin,
} from "./api";

// Eksportujemy całe API publiczne
export * from "./api";
export * from "./exporterTools";

// Eksport pojedynczych funkcji generujących z podkatalogów
import { c, type CConfig } from "./exporters/c";
import { cpp, type CppConfig } from "./exporters/cpp";
import { rust, type RustConfig } from "./exporters/rust";
import { ts, type TsConfig } from "./exporters/ts";
import { tsCodec, type TsCodecConfig } from "./exporters/tsCodec";
import { tsExports, type TsExportsConfig } from "./exporters/tsExports";
import { zig, type ZigConfig } from "./exporters/zig";
import { wgsl, type WgslConfig } from "./exporters/wgsl";
import { cppHarness } from "./exporters/cppHarness";
import { rustHarness } from "./exporters/rustHarness";
import { zigHarness } from "./exporters/zigHarness";
import { rustSerde, type RustSerdeConfig } from "./exporters";

export { c, type CConfig };
export { cpp, type CppConfig };
export { rust, type RustConfig };
export { rustSerde, type RustSerdeConfig };
export { ts, type TsConfig };
export { tsCodec, type TsCodecConfig };
export { tsExports, type TsExportsConfig };
export { zig, type ZigConfig };
export { wgsl, type WgslConfig };

// ── Harness wrappers ──────────────────────────────────────────────────────────

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

// ── Exporter Registry & Factories ─────────────────────────────────────────────

export type ExporterConfigMap = {
	c: CConfig;
	cpp: CppConfig;
	rust: RustConfig;
	"rust:serde": RustSerdeConfig;
	ts: TsConfig;
	"ts:codec": TsCodecConfig;
	"ts:exports": TsExportsConfig;
	zig: ZigConfig;
	wgsl: WgslConfig;
	"cpp:harness": HarnessConfig;
	"rust:harness": HarnessConfig;
	"zig:harness": HarnessConfig;
};

// Compile-time guard: ExporterConfigMap musi w 100% odpowiadać ExporterTarget
type _MissingConfig = Exclude<ExporterTarget, keyof ExporterConfigMap>;
type _ExtraConfig = Exclude<keyof ExporterConfigMap, ExporterTarget>;
const _configMapExhaustive: [_MissingConfig, _ExtraConfig] extends [never, never]
	? true
	: { missing: _MissingConfig; extra: _ExtraConfig } = true;

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
	wgsl,
	"cpp:harness": cppHarnessExporter,
	"rust:harness": rustHarnessExporter,
	"zig:harness": zigHarnessExporter,
};

export function getExporter<T extends ExporterTarget>(
	target: T,
	config?: ExporterConfigMap[T],
): ExporterPlugin<any> {
	const factory = FACTORIES[target];
	if (!factory) throw new Error(`Unknown exporter target: ${target}`);
	return factory(config ?? {});
}

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