import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
	TypePlan,
} from "schema-pop";
import { ExporterTools } from "schema-pop";

export interface MermaidConfig extends BaseConfig {
	/**
	 * Wrap output in a fenced markdown block (` ```mermaid `). Defaults to
	 * true so the file renders directly on GitHub / GitLab. Set false if
	 * you want a bare `.mmd` file for the Mermaid CLI.
	 */
	markdownFence?: boolean;
	/**
	 * Mermaid orientation. `LR` (default) lays out left-to-right; `TB`
	 * (top-to-bottom) is more compact for tall, narrow graphs.
	 */
	direction?: "LR" | "TB" | "RL" | "BT";
	title?: string;
}

const KIND_GLYPH: Record<string, string> = {
	struct: "⬚",
	union: "⊞",
	enum: "≡",
	alias: "↪",
};

function collectRefs(field: Field, into: Set<string>): void {
	switch (field.kind) {
		case "reference":
			into.add(field.name);
			return;
		case "array":
			collectRefs(field.item, into);
			return;
		case "optional":
			collectRefs(field.inner, into);
			return;
		case "map":
			collectRefs(field.value, into);
			return;
		case "inlineStruct":
			for (const fp of field.fields) collectRefs(fp.type, into);
			return;
	}
}

function dependencies(t: TypePlan): Set<string> {
	const deps = new Set<string>();
	if (t.kind === "struct") {
		for (const f of t.fields) collectRefs(f.type, deps);
	} else if (t.kind === "union") {
		for (const v of t.variants) collectRefs(v.type as Field, deps);
	} else if (t.kind === "alias") {
		collectRefs(t.type, deps);
	}
	return deps;
}

export function mermaid(
	config: MermaidConfig = {},
): ExporterPlugin<MermaidConfig> {
	const cfg: MermaidConfig = {
		typeNaming: "original",
		fieldNaming: "original",
		commentStyle: "slash",
		markdownFence: true,
		direction: "LR",
		...config,
	};
	const { typeName } = ExporterTools(cfg);

	return {
		name: "mermaid",
		extension: "mmd",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const known = new Set(plan.types.map((t) => t.name));
			const lines: string[] = [];
			lines.push(`flowchart ${cfg.direction}`);
			if (cfg.title) lines.push(`  %% ${cfg.title}`);

			// Node declarations carry the kind glyph + size hint so the
			// graph reads at a glance even before any edges are followed.
			for (const t of plan.types) {
				const id = typeName(t.name);
				const glyph = KIND_GLYPH[t.kind] ?? "•";
				const sizeHint = t.size > 0 ? ` · ${t.size}b` : "";
				lines.push(`  ${id}["${glyph} ${t.name}${sizeHint}"]`);
			}

			// Edges: A --> B means A references B. Self-edges are kept
			// (recursive types are interesting to surface). Edges to
			// non-scope names (e.g. orphan refs) are dropped.
			for (const t of plan.types) {
				const from = typeName(t.name);
				const deps = dependencies(t);
				for (const dep of deps) {
					if (!known.has(dep)) continue;
					lines.push(`  ${from} --> ${typeName(dep)}`);
				}
			}

			// Class hints so renderers can color by kind without us
			// hardcoding a palette.
			lines.push(
				"  classDef struct fill:#fffae3,stroke:#404e7c,color:#00241b;",
			);
			lines.push(
				"  classDef union  fill:#f7567c20,stroke:#f7567c,color:#00241b;",
			);
			lines.push(
				"  classDef enum   fill:#1f8a5a20,stroke:#1f8a5a,color:#00241b;",
			);
			lines.push(
				"  classDef alias  fill:#404e7c20,stroke:#404e7c,color:#00241b;",
			);
			for (const t of plan.types) {
				lines.push(`  class ${typeName(t.name)} ${t.kind};`);
			}

			const body = lines.join("\n") + "\n";
			return cfg.markdownFence
				? `# ${cfg.title ?? `${plan.version} type graph`}\n\n\`\`\`mermaid\n${body}\`\`\`\n`
				: body;
		},
	};
}
