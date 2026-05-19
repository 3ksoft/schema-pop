import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
	TypePlan,
} from "@schema-pop/schema";

export interface RandomConfig extends BaseConfig {
	count?: number;
	seed?: number;
	injectErrors?: boolean;
	errorRate?: number; // 0 to 1
}

export function random(config: RandomConfig): ExporterPlugin<RandomConfig> {
	const cfg = {
		count: 10,
		injectErrors: false,
		errorRate: 0.1,
		commentStyle: "none",
		...config,
	} as RandomConfig;

	// Simple deterministic PRNG
	let seed = cfg.seed || 12345;
	const nextRand = () => {
		seed = (seed * 16807) % 2147483647;
		return (seed - 1) / 2147483646;
	};

	const pickInt = (n: number) => Math.floor(nextRand() * n);

	return {
		name: "random",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const findType = (name: string): TypePlan | undefined =>
				plan.types.find((t) => t.name === name);

			const generateForType = (tp: TypePlan, forceError: boolean): any => {
				if (tp.kind === "struct") {
					const obj: any = {};
					for (const f of tp.fields)
						obj[f.name] = generateValue(f.type, forceError);
					return obj;
				}
				if (tp.kind === "enum") {
					const v = tp.variants[pickInt(tp.variants.length)];
					return v?.name;
				}
				if (tp.kind === "union") {
					const v = tp.variants[pickInt(tp.variants.length)];
					if (!v) return undefined;
					if (v.type.kind === "unit") return v.name;
					const payload = generateValue(v.type, forceError);
					return typeof payload === "object" && payload !== null
						? { kind: v.name, ...payload }
						: { kind: v.name, value: payload };
				}
				if (tp.kind === "alias") return generateValue(tp.type, forceError);
				return undefined;
			};

			const generateValue = (f: Field, forceError: boolean): any => {
				if (forceError && nextRand() < 0.5) return null;

				if (f.kind === "primitive") {
					if (f.name === "bool" || f.name === "boolean")
						return nextRand() > 0.5;
					if (f.name.startsWith("f")) return nextRand() * 1000 - 500;
					const max = Math.pow(2, f.bitSize || 8) - 1;
					const val = Math.floor(nextRand() * max);
					return f.name.startsWith("i") ? val - Math.floor(max / 2) : val;
				}

				if (f.kind === "string") {
					const chars =
						"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
					const len = Math.floor(nextRand() * (f.maxLength || 10));
					return Array.from(
						{ length: len },
						() => chars[Math.floor(nextRand() * chars.length)],
					).join("");
				}

				if (f.kind === "array") {
					const len =
						f.exactLength ?? Math.floor(nextRand() * (f.maxLength || 5));
					return Array.from({ length: len }, () =>
						generateValue(f.item, forceError),
					);
				}

				if (f.kind === "optional") {
					return nextRand() > 0.3
						? generateValue(f.inner, forceError)
						: undefined;
				}

				if (f.kind === "reference") {
					const tp = findType(f.name);
					if (tp) return generateForType(tp, forceError);
					return undefined;
				}

				if (f.kind === "inlineStruct") {
					const obj: any = {};
					for (const ff of f.fields)
						obj[ff.name] = generateValue(ff.type, forceError);
					return obj;
				}

				return 0;
			};

			const dataset: Record<string, any[]> = {};

			for (const t of plan.types) {
				if (t.kind !== "struct") continue;

				const items: any[] = [];
				for (let i = 0; i < cfg.count!; i++) {
					const forceError = cfg.injectErrors && nextRand() < cfg.errorRate!;
					items.push(generateForType(t, forceError || false));
				}
				dataset[t.name] = items;
			}

			return JSON.stringify(dataset, null, 2);
		},
	};
}
