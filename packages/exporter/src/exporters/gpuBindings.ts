import type {
	BaseConfig,
	ExporterPlugin,
	GpuBinding,
	GpuBindingPlan,
	LayoutPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface GpuBindingsTsConfig extends Omit<BaseConfig, "commentStyle"> {}
export interface GpuBindingsWgslConfig extends BaseConfig {}

function isGpuBindingPlan(t: any): t is GpuBindingPlan {
	return t.kind === "gpu-binding-layout";
}

function toSnakeCase(s: string): string {
	return s.replace(/([A-Z])/g, (_, c, i) =>
		i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`,
	);
}

function wgslVarDecl(b: GpuBinding, fieldName: (n: string) => string): string {
	const name = fieldName(b.name);
	const typePart = b.isArray ? `array<${b.dataTypeName}>` : b.dataTypeName;
	switch (b.usage) {
		case "storage-write":
			return `var<storage, read_write> ${name}: ${typePart}`;
		case "storage-read":
			return `var<storage, read> ${name}: ${typePart}`;
		case "storage-atomic": {
			// WGSL's atomic ops (atomicStore/atomicLoad/atomicAdd/...) require
			// the underlying storage location to be `atomic<T>`. For an array
			// binding that means `array<atomic<T>>`; for a scalar binding it
			// means `atomic<T>`. Access stays `read_write` — atomicity is a
			// property of the location, orthogonal to the access mode.
			const atomicType = b.isArray
				? `array<atomic<${b.dataTypeName}>>`
				: `atomic<${b.dataTypeName}>`;
			return `var<storage, read_write> ${name}: ${atomicType}`;
		}
		case "uniform":
			return `var<uniform> ${name}: ${typePart}`;
		case "texture-2d": {
			const texType = textureWgslType(b.dataTypeName);
			return `var ${name}: ${texType}`;
		}
		default:
			return `var<storage, read_write> ${name}: ${typePart}`;
	}
}

function textureWgslType(format: string): string {
	if (format.includes("sint")) return "texture_2d<i32>";
	if (format.includes("uint")) return "texture_2d<u32>";
	return "texture_2d<f32>";
}

function webgpuResource(b: GpuBinding): string {
	// `as const` on the string literal keeps it narrowed to the
	// GPUBufferBindingType / GPUTextureSampleType union so consumers don't
	// have to `as any` the descriptor when calling `createBindGroupLayout`.
	switch (b.usage) {
		case "storage-write":
		case "storage-atomic":
			// 'storage-atomic' is a WGSL-shader concern (forces the element
			// type to `atomic<T>` in the generated WGSL). At the WebGPU
			// pipeline-layout level it's an ordinary writable storage buffer.
			return `buffer: { type: "storage" as const }`;
		case "storage-read":
			return `buffer: { type: "read-only-storage" as const }`;
		case "uniform":
			return `buffer: { type: "uniform" as const }`;
		case "texture-2d":
			return `texture: { sampleType: "${b.dataTypeName}" as GPUTextureSampleType }`;
		default:
			return `buffer: { type: "storage" as const }`;
	}
}

export function gpuBindingsTs(
	config: GpuBindingsTsConfig,
): ExporterPlugin<GpuBindingsTsConfig> {
	const cfg = { fieldNaming: "original", typeNaming: "original", ...config };
	const { typeName } = ExporterTools(cfg as any);

	return {
		name: "gpu-bindings-ts",
		config: cfg as any,
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) {
				if (!isGpuBindingPlan(t)) continue;
				const constName = `${typeName(t.name)
					.replace(/([a-z])([A-Z])/g, "$1_$2")
					.toUpperCase()}_BINDINGS`;

				// Group bindings by group index
				const byGroup = new Map<number, GpuBinding[]>();
				for (const b of t.bindings) {
					if (!byGroup.has(b.group)) byGroup.set(b.group, []);
					byGroup.get(b.group)!.push(b);
				}

				// `satisfies` (rather than `: Record<...>` annotation) keeps the
				// inferred narrow literal types for `buffer.type` / `texture.sampleType`,
				// so the exported value is still typed as a precise GPU descriptor
				// while also being statically verified against the WebGPU shape.
				code += `export const ${constName} = {\n`;
				for (const [group, bindings] of [...byGroup.entries()].sort(
					(a, b) => a[0] - b[0],
				)) {
					code += `\tgroup${group}: [\n`;
					for (const b of bindings.sort((a, bb) => a.binding - bb.binding)) {
						code += `\t\t{ binding: ${b.binding}, visibility: GPUShaderStage.COMPUTE, ${webgpuResource(b)} },\n`;
					}
					code += `\t],\n`;
				}
				code += `} satisfies Record<string, GPUBindGroupLayoutEntry[]>;\n\n`;
			}
			return code;
		},
	};
}

export function gpuBindingsWgsl(
	config: GpuBindingsWgslConfig,
): ExporterPlugin<GpuBindingsWgslConfig> {
	const cfg = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		...config,
	};
	const { fieldName } = ExporterTools(cfg as any);

	return {
		name: "gpu-bindings-wgsl",
		extension: "wgsl",
		config: cfg as any,
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) {
				if (!isGpuBindingPlan(t)) continue;
				const sorted = [...t.bindings].sort((a, b) =>
					a.group !== b.group ? a.group - b.group : a.binding - b.binding,
				);
				for (const b of sorted) {
					code += `@group(${b.group}) @binding(${b.binding}) ${wgslVarDecl(b, fieldName)};\n`;
				}
				code += "\n";
			}
			return code;
		},
	};
}
