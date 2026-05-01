import type { LayoutPlan, BaseConfig, ExporterPlugin } from "schema-pop";
import { ExporterTools } from "schema-pop";
import { brainfuckHarness } from "./bf-harness";

function stringToBF(str: string): string {
	let bf = "";
	let lastChar = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		const diff = char - lastChar;
		if (diff > 0) bf += "+".repeat(diff);
		else if (diff < 0) bf += "-".repeat(-diff);
		bf += ".";
		lastChar = char;
	}
	bf += "[-]\n";
	return bf;
}

export interface BrainfuckConfig extends BaseConfig {
	harness?: boolean;
}

export function brainfuck(config: BrainfuckConfig): ExporterPlugin<BrainfuckConfig> {
	const cfg = { commentStyle: "none", ...config } as BrainfuckConfig;
	return {
		name: "brainfuck",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const { toSafeVersionIdentifier } = ExporterTools({});
			const ver = toSafeVersionIdentifier(plan.version);
			let output = "";
			for (const t of plan.types) {
				output += `${ver},${t.name},${t.paddedSize || t.size},${t.align}\n`;
			}
			return stringToBF(output);
		},
		getHarness: cfg.harness ? () => brainfuckHarness() : undefined,
	};
}
