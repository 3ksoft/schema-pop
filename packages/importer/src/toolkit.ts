import { type } from "arktype";
import { PopType, PopFunction, BINARY_METADATA } from "@schema-pop/schema";

const WalkItem = PopType.or(PopFunction);
export const WalkResult = type({
	source: "string",
	items: type.Record("string", WalkItem),
	skipped: [{ name: "string", reason: "string" }, "[]"],
	errors: "string[]",
	warnings: "string[]",
});

export type WalkResult = typeof WalkResult.infer;

export class DocTracker {
	private lines: string[] = [];

	addCommentNode(text: string) {
		if (text.startsWith("/**") || text.startsWith("/*")) {
			const match = text.match(/^\/\*+([\s\S]*?)\*+\/$/);
			if (match && match[1]) {
				const cleaned = match[1]
					.split("\n")
					.map((l) => l.replace(/^\s*\*\s?/, "").trim())
					.filter(Boolean);
				this.lines.push(...cleaned);
			}
		} else if (text.startsWith("///")) {
			this.lines.push(text.replace(/^\/\/\/\s?/, "").trim());
		} else if (text.startsWith("//")) {
			this.lines.push(text.replace(/^\/\/\s?/, "").trim());
		}
	}

	consume(): string | undefined {
		if (this.lines.length === 0) return undefined;
		const doc = this.lines.join("\n");
		this.lines = [];
		return doc;
	}

	clear() {
		this.lines = [];
	}
}

const ImporterMetadata = type({
	name: "string",
	supportedExtensions: "string[] > 0",
	"description?": "string",
});
export type ImporterMetadata = typeof ImporterMetadata.infer;

export abstract class BaseImporter {
	protected sourcePath: string;
	protected items: Record<string, PopType | PopFunction> = {};
	protected skipped: { name: string; reason: string }[] = [];
	protected errors: string[] = [];
	protected warnings: string[] = [];
	protected extraKnownNames: Set<string>;
	protected docs = new DocTracker();

	constructor(
		sourcePath: string,
		opts: { extraKnownNames?: readonly string[] } = {},
	) {
		this.sourcePath = sourcePath;
		this.extraKnownNames = new Set(opts.extraKnownNames ?? []);
	}

	protected error(msg: string): void {
		this.errors.push(msg);
	}

	protected warning(msg: string): void {
		this.warnings.push(msg);
	}

	public getErrors(): string[] {
		return this.errors;
	}

	public getWarnings(): string[] {
		return this.warnings;
	}

	protected skip(name: string, reason: string): void {
		this.skipped.push({ name, reason });
	}

	protected ensureLabels(typeDef: unknown, fallbackLabel: string): void {
		if (typeof typeDef !== "object" || typeDef === null) return;
		const node = typeDef as Record<string, unknown>;
		if (!node["label"]) node["label"] = fallbackLabel;
		if (node["type"] === "array" && node["item"]) {
			this.ensureLabels(node["item"], `${fallbackLabel}Item`);
		}
		if (
			node["type"] === "object" &&
			typeof node["fields"] === "object" &&
			node["fields"] !== null
		) {
			for (const [k, v] of Object.entries(
				node["fields"] as Record<string, unknown>,
			)) {
				this.ensureLabels(v, k);
			}
		}
		if (node["type"] === "union" && Array.isArray(node["variants"])) {
			(node["variants"] as unknown[]).forEach((v, i) => {
				const label = (v as Record<string, unknown>)["label"];
				this.ensureLabels(
					v,
					typeof label === "string" ? label : `${fallbackLabel}Variant${i + 1}`,
				);
			});
		}
		if (node["type"] === "function" && Array.isArray(node["args"])) {
			(node["args"] as unknown[]).forEach((a, i) => {
				const arg = a as Record<string, unknown>;
				const argName =
					typeof arg["name"] === "string"
						? arg["name"]
						: `${fallbackLabel}Arg${i + 1}`;
				this.ensureLabels(arg["type"], argName);
			});
			if (node["returns"]) {
				this.ensureLabels(node["returns"], `${fallbackLabel}Return`);
			}
		}
	}

	protected assertType(
		field: unknown,
		fallbackLabel: string,
	): PopType | PopFunction {
		this.ensureLabels(field, fallbackLabel);
		const isFunction =
			field &&
			typeof field === "object" &&
			(field as any).type === "function";
		if (
			!isFunction &&
			field &&
			typeof field === "object" &&
			!(field as any)["popKind"]
		) {
			(field as any)["popKind"] = "rich";
		}

		const valid = WalkItem(field);
		if (valid instanceof type.errors) {
			for (const e of Object.values(valid.entries)) {
				this.error(`Invalid type for '${fallbackLabel}': ${e.message}`);
			}
			return {
				type: "any",
				label: fallbackLabel,
				originalType: "unknown",
				popKind: "rich",
			} as PopType;
		}
		return valid as PopType | PopFunction;
	}

	protected addItem(
		name: string,
		typeDef: unknown,
		description?: string,
	): void {
		if (description && typeof typeDef === "object" && typeDef !== null) {
			(typeDef as Record<string, unknown>)["description"] = description;
		}
		const valid = this.assertType(typeDef, name);
		this.items[name] = valid;
	}

	private processPopType(
		t: any,
		knownKeys: Set<string>,
		visited: Map<any, any>,
	): any {
		if (!t || typeof t !== "object") return t;
		if (visited.has(t)) return visited.get(t);

		const cloned = { ...t };
		visited.set(t, cloned);

		if (cloned.type === "link") {
			if (!knownKeys.has(cloned.target)) {
				const orig = cloned.target;
				const label = cloned.label || orig;
				for (const k of Object.keys(cloned)) delete cloned[k];
				cloned.type = "any";
				cloned.originalType = orig;
				cloned.label = label;
			}
		}

		if (
			(cloned.type === "number" || cloned.type === "boolean") &&
			typeof cloned.binaryType === "string" &&
			BINARY_METADATA[cloned.binaryType]
		) {
			const meta = BINARY_METADATA[cloned.binaryType]!;
			for (const [k, v] of Object.entries(meta)) {
				if (cloned[k] === undefined || cloned[k] === null) {
					cloned[k] = v;
				}
			}
		}

		if (cloned.type === "array" && cloned.item) {
			cloned.item = this.processPopType(cloned.item, knownKeys, visited);
		} else if (cloned.type === "object" && cloned.fields) {
			const newFields: Record<string, any> = {};
			for (const [k, v] of Object.entries(cloned.fields)) {
				newFields[k] = this.processPopType(v, knownKeys, visited);
			}
			cloned.fields = newFields;
		} else if (cloned.type === "union" && Array.isArray(cloned.variants)) {
			cloned.variants = cloned.variants.map((v: any) =>
				this.processPopType(v, knownKeys, visited),
			);
		} else if (cloned.type === "function") {
			if (Array.isArray(cloned.args)) {
				cloned.args = cloned.args.map((a: any) => {
					if (a && typeof a === "object" && a.type) {
						return {
							...a,
							type: this.processPopType(a.type, knownKeys, visited),
						};
					}
					return a;
				});
			}
			if (cloned.returns) {
				cloned.returns = this.processPopType(
					cloned.returns,
					knownKeys,
					visited,
				);
			}
		}

		return cloned;
	}

	public finalize(): WalkResult {
		const definedKeys = new Set([
			...Object.keys(this.items),
			...this.extraKnownNames,
		]);

		const processedItems: Record<string, PopType | PopFunction> = {};
		const visited = new Map<any, any>();

		for (const [k, item] of Object.entries(this.items)) {
			const processed = this.processPopType(item, definedKeys, visited);
			const valid = WalkItem(processed);
			if (valid instanceof type.errors) {
				this.error(
					`Invalid type for '${k}' after finalization: ${valid.summary}`,
				);
				processedItems[k] = {
					type: "any",
					originalType: "unknown",
					label: k,
				} as PopType;
			} else {
				processedItems[k] = valid as PopType | PopFunction;
			}
		}

		return {
			source: this.sourcePath,
			items: processedItems,
			skipped: this.skipped,
			errors: this.errors,
			warnings: this.warnings,
		};
	}
}

export function resolveScalarType(
	text: string,
	primitiveMap: Record<string, string>,
): PopType {
	const binType = primitiveMap[text];
	if (binType) {
		if (binType === "bool")
			return { type: "boolean", binaryType: "bool" } as PopType;
		return { type: "number", binaryType: binType } as PopType;
	}
	return { type: "link", target: text } as PopType;
}
