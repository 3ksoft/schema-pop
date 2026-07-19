import type {
	BaseConfig,
	ExporterPlugin,
	GpuBinding,
	GpuBindingPlan,
	LayoutPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";
import { isGpuBindingPlan } from "./gpuShared";

export interface GpuBindingsTsConfig extends Omit<BaseConfig, "commentStyle"> { }

function webgpuResource(b: GpuBinding): string {
	const bindingUsage = b.usage.split("+")[0];
	switch (bindingUsage) {
		case "storage-write":
		case "storage-atomic":
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

function generatePipelineCompiler(t: GpuBindingPlan): string {
	if (!t.shaders || t.shaders.length === 0) return "";

	let code = `export interface ${t.name}Pipelines {\n`;
	for (const s of t.shaders) {
		code += `\t${s.entryPoint}: GPUComputePipeline;\n`;
	}
	code += `}\n\n`;

	code += `export async function create${t.name}Pipelines(\n`;
	code += `\tdevice: GPUDevice,\n`;
	code += `\tlayouts: Record<keyof ${t.name}Pipelines, GPUPipelineLayout>,\n`;
	code += `\tshaderModule: (entryPoint:keyof ${t.name}Pipelines) => GPUShaderModule\n`;
	code += `): Promise<${t.name}Pipelines> {\n`;

	code += `\treturn {\n`;
	for (const s of t.shaders) {
		code += `\t\t"${s.entryPoint}": await device.createComputePipelineAsync({\n`;
		code += `\t\t\tlabel: "pipeline_${s.entryPoint}",\n`;
		code += `\t\t\tlayout: layouts["${s.entryPoint}"],\n`;
		code += `\t\t\tcompute: { module: shaderModule("${s.entryPoint}"), entryPoint: "${s.entryPoint}" }\n`;
		code += `\t\t}),\n`;
	}
	code += `\t};\n`;
	code += `}\n\n`;

	return code;
}

function generatePipelineMetadata(t: GpuBindingPlan): string {
	if (!t.shaders || t.shaders.length === 0) return "";

	let code = `export const ${t.name.toUpperCase()}_PIPELINE_BINDINGS = {\n`;

	for (const s of t.shaders) {
		const sorted = [...s.bindings].sort((a, b) => a.group - b.group || a.binding - b.binding);
		code += `\t"${s.entryPoint}": [${sorted.map(b => `[${b.group}, ${b.binding}]`).join(", ")}],\n`;
	}
	code += `} as const satisfies Record<string, readonly (readonly [number, number])[]>;\n\n`;
	code += `export const ${t.name.toUpperCase()}_PIPELINE_BIND_GROUPS: Record<string, number[]> = Object.fromEntries(\n`;
	code += `\tObject.entries(${t.name.toUpperCase()}_PIPELINE_BINDINGS).map(([name, bindings]) => [name, [...new Set(bindings.map(([group]) => group))]])\n`;
	code += `);\n\n`;
	return code;
}

export function gpuBindingsTs(
	config: GpuBindingsTsConfig,
): ExporterPlugin<
	GpuBindingsTsConfig,
	{ bindings: string; pipelines: string; metadata: string }
> {
	const cfg = { fieldNaming: "original", typeNaming: "original", ...config };
	const { typeName } = ExporterTools(cfg as any);

	return {

		name: "gpu-bindings-ts",
		config: cfg as any,
		generate: (plan: LayoutPlan) => {
			let code = "";
			let pipelineCode = "";
			let metadataCode = "";
			for (const t of plan.types) {
				if (!isGpuBindingPlan(t)) continue;
				const constName = `${typeName(t.name)
					.replace(/([a-z])([A-Z])/g, "$1_$2")
					.toUpperCase()}_BINDINGS`;

				const byGroup = new Map<number, GpuBinding[]>();
				for (const b of t.bindings) {
					if (!byGroup.has(b.group)) byGroup.set(b.group, []);
					byGroup.get(b.group)!.push(b);
				}

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

				pipelineCode += generatePipelineCompiler(t);
				metadataCode += generatePipelineMetadata(t);

			}
			return {
				bindings: code,
				pipelines: pipelineCode,
				metadata: metadataCode
			};
		},
	};
}
