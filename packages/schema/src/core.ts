import { generic, Hkt, type Type, type } from "arktype";
import { gui } from "./gui";

export const ArkMeta = type({
	"popKind?": "'rich' | 'bitwise' | 'binary' | 'reserved' | 'gpu-binding' | 'gpu-shader'",
	"description?": "string",
	"category?": "string",
	"min?": "number",
	"max?": "number",
	"step?": "number",
	"required?": "boolean",
	"default?": "unknown.any",

	"size?": "number",
	"align?": "number",
	"binaryType?": "string",
	"scale?": "number",
	"isBinary?": "boolean",
	"bitSize?": "number",
	"unsigned?": "boolean",
	"isFloat?": "boolean",

	"obsolete?": "boolean",
	"obsoleteReason?": "string",
	"renamedFrom?": "string",
	"originalType?": "string",

	"gpuGroup?": "number",
	"gpuBinding?": "number",
	"gpuUsage?": "string",
	"atomic?": "boolean",
	"entryPoint?": "string",
	"bindGroups?": "number[]",
	"workGroupSize?": "number",
}).and(gui.export().BaseGuiMeta);

export type ArkMeta = typeof ArkMeta.infer;

declare global {
	interface ArkEnv {
		meta(): ArkMeta
	}
}

/**
 * Attaches a text description to the field metadata.
 */
export const Describe = generic(["t", "unknown"], ["d", "string"])(
	(args) =>
		(args.t as Type).configure({
			description: String((args.d as any).unit),
		}),
	class extends Hkt<[t: unknown, d: string]> {
		declare body: this[0];
	},
);

function explainType(t: string) {
	// match u1 u2, i1, i2, i3, f1, f2 pattern and explain as "unsigned 1-bit integer", etc.
	if (/^[uif](\d+)$/.test(t)) {
		var typeDesc = [];
		if (t[0] === "u") {
			typeDesc.push("unsigned");
		}
		if (t[0] === "i") {
			typeDesc.push("signed");
		}
		const bits = t.match(/^.[uif](\d+)$/)?.[1];

		typeDesc.push(`${bits}-bit`);
		if (t[0] === "f") {
			typeDesc.push("float");
		} else {
			typeDesc.push("integer");
		}
		return typeDesc.join(" ");
	}
	return t;
}

/**
 * Binary metadata wrapper
 */
export const Binary = generic(
	["t", "unknown"],
	["size", "number"],
	["align", "number"],
	["type", "string"],
)(
	(args) => {
		return (args.t as Type).configure({
			size: (args.size as any).unit,
			align: (args.align as any).unit,
			binaryType: (args.type as any).unit,
			description: explainType((args.type as any).unit),
			popKind: "binary",
		});
	},
	class extends Hkt<[t: unknown, size: number, align: number, type: string]> {
		declare body: this[0];
	},
);

/**
 * Wrapper for bit-packed fields
 */
export const Bit = generic(["t", "unknown"], ["size", "number"])(
	(args) => {
		return (args.t as Type).configure({
			size: (args.size as any).unit,
			description: explainType((args.size as any).unit),
			popKind: "bitwise",
		});
	},
	class extends Hkt<[t: unknown, size: number]> {
		declare body: this[0];
	},
);

/**
 * Defines a reserved block of memory that is not exposed to the user API.
 */
export const Reserved = generic(["t", "unknown"], ["size", "number"])(
	(args) => {
		return (args.t as Type).configure({
			size: (args.size as any).unit,
			popKind: "reserved",
		});
	},
	class extends Hkt<[]> {
		declare body: this[0];
	},
);

/**
 * Defines a physical scaling factor for values (e.g., raw integer to float representation).
 */
export const Scale = generic(["t", "unknown"], ["s", "number"])(
	(args) => (args.t as Type).configure({ scale: (args.s as any).unit }),
	class extends Hkt<[t: unknown, s: number]> {
		declare body: this[0];
	},
);

/**
 * Marks the field or type as obsolete. Pass an optional reason string —
 * exporters render this as language-native deprecation (Rust #[deprecated],
 * C++ [[deprecated]], TS JSDoc deprecated  OpenAPI deprecated: true) and
 * docs surface it as a strikethrough/pill.
 */
export const Obsolete = generic(["t", "unknown"], ["reason", "string"])(
	(args) =>
		(args.t as Type).configure({
			obsolete: true,
			obsoleteReason: String((args.reason as any).unit),
		}),
	class extends Hkt<[t: unknown, reason: string]> {
		declare body: this[0];
	},
);

/**
 * Marks a field/type as renamed in this schema version: in the previous
 * version it was called `oldName`. Migration emit uses this to map values
 * across the rename instead of treating the change as (removed, added).
 *
 * The marker affects migration metadata only — the v2 layout/output is
 * identical to the un-marked version. The marker resets per migration step;
 * v3 doesn't need to know what v1 called the field, only what v2 called it.
 */
export const Renamed = generic(["t", "unknown"], ["oldName", "string"])(
	(args) =>
		(args.t as Type).configure({
			renamedFrom: String((args.oldName as any).unit),
		}),
	class extends Hkt<[t: unknown, oldName: string]> {
		declare body: this[0];
	},
);

/**
 * Records the source-language spelling for a type the schema-pop pipeline
 * couldn't resolve into a native shape — typically set by importers
 * (clang_importer / treesitter_importer) when they hit a system typedef
 * outside the bundled scopes (`size_t`, `const char *`, project-local
 * templates, etc.).
 *
 * Round-trips as arktype meta `originalType: 'X'`. Binary-language
 * exporters (c, cpp, rust) with `useOriginalType: true` use it as the
 * "splat the original spelling verbatim" cheat path so the output
 * compiles against the original headers, even though schema-pop has
 * no honest layout for the field.
 *
 * Usage:
 * ```ts
 * Buf: { handle: "OriginalType<unknown, 'void *'>" }
 * ```
 */
export const OriginalType = generic(["t", "unknown"], ["name", "string"])(
	(args) =>
		(args.t as Type).configure({
			originalType: String((args.name as any).unit),
		} as any),
	class extends Hkt<[t: unknown, name: string]> {
		declare body: this[0];
	},
);

/**
 * Declares a GPU resource binding for WebGPU pipeline layout generation.
 * Generates both TypeScript `GPUBindGroupLayoutDescriptor` entries and
 * WGSL `@group(G) @binding(B) var<...>` declarations.
 *
 * Usage: `"Binding<group, binding, usage, Type>"`
 * - `usage`: `'storage-write'` | `'storage-read'` | `'uniform'` | `'texture-2d'`
 * - `Type`: data type for buffers (e.g. `Particle[]`), or format string for textures
 */
export const Binding = generic(
	["group", "number"],
	["index", "number"],
	["usage", "string"],
	["t", "unknown"],
)(
	(args) => {
		return (args.t as Type).configure({
			gpuGroup: (args.group as any).unit,
			gpuBinding: (args.index as any).unit,
			gpuUsage: String((args.usage as any).unit),
			popKind: "gpu-binding",
		});
	},
	class extends Hkt<[group: number, index: number, usage: string, t: unknown]> {
		declare body: this[3];
	},
);


/**
 * Declares a GPU compute shader for WebGPU pipeline layout generation.
 *
 * Usage: `"Shader<entryPoint, bindGroups, workGroupSize>"`
 * Example: `"Shader<string, 'mpm', [0,1,2,3], 512>"`
 */
export const Shader = generic(
	["t", "unknown"],
	["entryPoint", "string"],
	["bindGroups", "string"],
	["workGroupSize", "number"],
)(
	(args) => {
		const bindGroupsRaw = (args.bindGroups as any).unit as string;

		// Mapujemy string na rzeczywistą tablicę liczb w runtime
		const bindGroups = bindGroupsRaw
			? bindGroupsRaw.split(",").map(s => s.trim()).filter(Boolean).map(Number)
			: [];
		return (args.t as Type).configure({
			entryPoint: (args.entryPoint as any).unit,
			bindGroups: bindGroups,
			workGroupSize: (args.workGroupSize as any).unit,
			popKind: "gpu-shader",
		});
	},
	class extends Hkt<[t: unknown, entryPoint: string, bindGroups: string, workGroupSize: number]> {
		declare body: this[0];
	},
);

/**
 * Tags a field with a UI category and an optional description in one step.
 *
 * Usage: `"Category<f32, 'physics', 'Time step'>"`
 * - `category`: group label shown in editors / config UIs
 * - `description`: human-readable tooltip / label (optional — defaults to "")
 */
export const Category = generic(
	["t", "unknown"],
	["cat", "string"],
	["desc", "string"],
)(
	(args) => {
		return (args.t as Type).configure({
			category: String((args.cat as any).unit),
			description: String((args.desc as any).unit),
		});
	},
	class extends Hkt<[t: unknown, cat: string, desc: string]> {
		declare body: this[0];
	},
);

/**
 * Attaches min/max range metadata to a type for config UI rendering.
 * Does not add runtime validation — use the base type constraints for that.
 *
 * Usage: `"Constrained<f32, 0, 1>"`
 */
export const Constrained = generic(
	["t", "unknown"],
	["min", "number"],
	["max", "number"],
)(
	(args) => {
		return (args.t as Type).configure({
			min: (args.min as any).unit,
			max: (args.max as any).unit,
		});
	},
	class extends Hkt<[t: unknown, min: number, max: number]> {
		declare body: this[0];
	},
);

/**
 * Attaches min/max/step range metadata to a type for config UI rendering.
 *
 * Usage: `"ConstrainedStep<f32, 0, 1, 0.01>"`
 */
export const ConstrainedStep = generic(
	["t", "unknown"],
	["min", "number"],
	["max", "number"],
	["step", "number"],
)(
	(args) => {
		return (args.t as Type).configure({
			min: (args.min as any).unit,
			max: (args.max as any).unit,
			step: (args.step as any).unit,
		});
	},
	class extends Hkt<[t: unknown, min: number, max: number, step: number]> {
		declare body: this[0];
	},
);
