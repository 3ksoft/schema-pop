import {
	BaseConfig,
	type ExporterPlugin,
	LayoutPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";
import { brainfuckHarness } from "./bfHarness";

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

export const BrainfuckConfig = BaseConfig.and({
	"harness?": "boolean",
});
export type BrainfuckConfig = typeof BrainfuckConfig.infer;

export function brainfuck(
	config: BrainfuckConfig,
): ExporterPlugin<BrainfuckConfig, string> {
	const cfg = { commentStyle: "none", ...config } as BrainfuckConfig;
	return {
		name: "brainfuck",
		extension: "bf",
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
		...(cfg.harness
			? { getHarness: (_plans: LayoutPlan[]) => brainfuckHarness() }
			: {}),
	};
}
