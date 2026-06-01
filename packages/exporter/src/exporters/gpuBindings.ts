import type {
	BaseConfig,
	ExporterPlugin,
	GpuBinding,
	GpuBindingPlan,
	LayoutPlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface GpuBindingsTsConfig extends Omit<BaseConfig, "commentStyle"> { }
export interface GpuBindingsWgslConfig extends BaseConfig { }

function isGpuBindingPlan(t: any): t is GpuBindingPlan {
	return t.kind === "gpu-binding-layout";
}

function toSnakeCase(s: string): string {
	return s.replace(/([A-Z])/g, (_, c, i) =>
		i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`,
	);
}

function wgslVarDecl(b: GpuBinding, fieldName: (n: string) => string, bitfieldStructNames?: Set<string>): string {
	const name = fieldName(b.name);
	let dataTypeName = b.dataTypeName;
	if (bitfieldStructNames?.has(dataTypeName)) {
		dataTypeName = `${dataTypeName}Packed`;
	}
	const typePart = b.isArray ? `array<${dataTypeName}>` : dataTypeName;
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
				? `array<atomic<${dataTypeName}>>`
				: `atomic<${dataTypeName}>`;
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
// 1. Generowanie zbiorczego kreatora układów (BGL)
function generateBindGroupLayoutsCreator(t: GpuBindingPlan): string {
	const declaredGroups = new Set<number>();
	for (const b of t.bindings) {
		declaredGroups.add(b.group);
	}
	const sortedGroups = [...declaredGroups].sort((a, b) => a - b);

	let code = `export function create${t.name}BindGroupLayouts(device: GPUDevice) {\n`;
	code += `\treturn {\n`;
	for (const g of sortedGroups) {
		code += `\t\tbg${g}: device.createBindGroupLayout({\n`;
		code += `\t\t\tlabel: "${t.name}_bg${g}Layout",\n`;
		code += `\t\t\tentries: ${t.name.toUpperCase()}_BINDINGS.group${g},\n`;
		code += `\t\t}),\n`;
	}
	code += `\t};\n`;
	code += `}\n\n`;
	return code;
}

// 2. Zmodyfikowany kompilator potoków (przyjmuje JEDEN GPUShaderModule)
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

	// Zmiana: shaderModule jako pojedynczy obiekt GPUShaderModule
	code += `export async function create${t.name}Pipelines(\n`;
	code += `\tdevice: GPUDevice,\n`;
	code += `\tlayouts: ${layoutsType},\n`;
	code += `\tshaderModule: GPUShaderModule\n`; // <-- Tutaj pojedynczy moduł
	code += `): Promise<${t.name}Pipelines> {\n`;

	const layoutsCode: string[] = [];
	const shaderToLayoutName = new Map<string, string>();
	const layoutSet = new Set<string>();

	for (const s of t.shaders) {
		const sorted = [...s.bindGroups].sort((a, b) => a - b);
		const key = sorted.join("_");
		const layoutVarName = `layout_${key}`;
		if (!layoutSet.has(key)) {
			layoutSet.add(key);
			const bgls = sorted.map(g => `layouts.bg${g}`).join(", ");
			layoutsCode.push(`\tconst ${layoutVarName} = device.createPipelineLayout({ bindGroupLayouts: [${bgls}] });`);
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
		code += `\t\t\tcompute: { module: shaderModule, entryPoint: "${s.entryPoint}" }\n`; // <-- Użycie wspólnego modułu
		code += `\t\t}),\n`;
	}
	code += `\t};\n`;
	code += `}\n\n`;

	return code;
}

// 3. Generowanie metadanych o powiązaniach grup bindowania
function generatePipelineMetadata(t: GpuBindingPlan): string {
	if (!t.shaders || t.shaders.length === 0) return "";

	let code = `export const ${t.name.toUpperCase()}_PIPELINE_BIND_GROUPS: Record<keyof ${t.name}Pipelines, number[]> = {\n`;
	for (const s of t.shaders) {
		const sortedGroups = [...s.bindGroups].sort((a, b) => a - b);
		code += `\t"${s.entryPoint}": [${sortedGroups.join(", ")}],\n`;
	}
	code += `};\n\n`;
	return code;
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

				// Generowanie kompilatora potoków oraz funkcji dispatchujących bezpośrednio w pliku TypeScript
				code += generatePipelineCompiler(t);
				code += generatePipelineMetadata(t);
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
			const bitfieldStructNames = new Set<string>();
			for (const t of plan.types) {
				if (t.kind === "struct" && t.fields.some(f => (f.type as any).popKind === "bitwise")) {
					bitfieldStructNames.add(t.name);
				}
			}

			let code = "";
			for (const t of plan.types) {
				if (!isGpuBindingPlan(t)) continue;
				const sorted = [...t.bindings].sort((a, b) =>
					a.group !== b.group ? a.group - b.group : a.binding - b.binding,
				);
				for (const b of sorted) {
					code += `@group(${b.group}) @binding(${b.binding}) ${wgslVarDecl(b, fieldName, bitfieldStructNames)};\n`;
				}
				code += "\n";
			}
			return code;
		},
	};
}