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
	switch (b.usage) {
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

	const declaredGroups = new Set<number>();
	for (const b of t.bindings) {
		declaredGroups.add(b.group);
	}
	const sortedDeclaredGroups = [...declaredGroups].sort((a, b) => a - b);
	const layoutsType = `{ ${sortedDeclaredGroups.map(g => `bg${g}: GPUBindGroupLayout`).join("; ")} }`;

	let code = `export interface ${t.name}Pipelines {\n`;
	for (const s of t.shaders) {
		code += `\t${s.entryPoint}: GPUComputePipeline;\n`;
	}
	code += `}\n\n`;

	code += `export async function create${t.name}Pipelines(\n`;
	code += `\tdevice: GPUDevice,\n`;
	code += `\tlayouts: ${layoutsType},\n`;
	code += `\tshaderModule: (entryPoint:keyof ${t.name}Pipelines) => GPUShaderModule\n`;
	code += `): Promise<${t.name}Pipelines> {\n`;

	// Build contiguous layouts by filling gaps with empty bind group layouts
	const layoutsCode: string[] = [];
	const shaderToLayoutName = new Map<string, string>();
	const layoutSet = new Set<string>();

	for (const s of t.shaders) {
		const sorted = [...s.bindGroups].sort((a, b) => a - b);

		// Build contiguous array: include BG layout where group is used, empty layout for gaps
		const maxGroup = sortedDeclaredGroups[sortedDeclaredGroups.length - 1];
		const entries = [];
		for (let g = 0; g <= maxGroup; g++) {
			if (sorted.includes(g)) {
				entries.push(`layouts.bg${g}`);
			} else {
				entries.push(`device.createBindGroupLayout({ entries: [] })`);
			}
		}
		const key = sorted.join("-");
		const layoutVarName = `l_${sorted.map((n: number) => `g${n}`).join("")}`;
		if (!layoutSet.has(key)) {
			layoutSet.add(key);
			layoutsCode.push(`\tconst ${layoutVarName} = device.createPipelineLayout({ bindGroupLayouts: [${entries.join(", ")}] });`);
		}
		shaderToLayoutName.set(s.entryPoint, layoutVarName);
	}

	for (const line of layoutsCode) {
		code += `${line}\n`;
	}
	code += `\n`;

	code += `\treturn {\n`;
	for (const s of t.shaders) {
		const layoutVar = shaderToLayoutName.get(s.entryPoint);
		code += `\t\t"${s.entryPoint}": await device.createComputePipelineAsync({\n`;
		code += `\t\t\tlabel: "pipeline_${s.entryPoint}",\n`;
		code += `\t\t\tlayout: ${layoutVar},\n`;
		code += `\t\t\tcompute: { module: shaderModule("${s.entryPoint}"), entryPoint: "${s.entryPoint}" }\n`;
		code += `\t\t}),\n`;
	}
	code += `\t};\n`;
	code += `}\n\n`;

	return code;
}

function generatePipelineMetadata(t: GpuBindingPlan): string {
	if (!t.shaders || t.shaders.length === 0) return "";

	let code = `export const ${t.name.toUpperCase()}_PIPELINE_BIND_GROUPS: Record<string, number[]> = {\n`;

	for (const s of t.shaders) {
		const sortedGroups = [...s.bindGroups].sort((a, b) => a - b);
		code += `\t"${s.entryPoint}": [${sortedGroups.join(", ")}],\n`;
	}
	code += `} as const;\n\n`;
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
