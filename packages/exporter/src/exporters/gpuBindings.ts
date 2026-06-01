import type {
	BaseConfig,
	ExporterPlugin,
	GpuBinding,
	GpuBindingPlan,
	LayoutPlan,
	TypePlan,
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

// Pobiera surowy typ WGSL dla bindingu bazując na nowym modelu pamięci
function getRawWgslType(name: string, typeNameConverter: (s: string) => string, typesMap: Map<string, TypePlan>, usage: string): string {
	const t = typesMap.get(name);
	if (!t) return name; // np. typy wbudowane jak u32

	const cleanName = typeNameConverter(name);

	// 1. Zwracamy Czysty Typ dla uniformów. WebGPU wymaga tu wyrównania std140, a Twoje struktury 
	// jak `Simulation` nie mają bitfieldów na top-levelu, więc możemy używać ich natywnie w shaderze!
	if (usage === "uniform") {
		return cleanName;
	}

	// 2. Struktury z atomikami również są czystymi strukturami WGSL, używamy ich bezpośrednio
	if (t.kind === "struct" && t.fields.some(f => (f.type as any).atomic)) {
		return cleanName;
	}

	// 3. Unie dostały natywny alias w WGSL (np. alias GameObject = array<u32, 16>)
	if (t.kind === "union") {
		return cleanName;
	}

	if (t.kind === "enum") return "u32";

	// 4. Dla buforów Storage (read_write/read) używamy bezpiecznych, płaskich tablic słów u32
	const words = Math.max(1, Math.ceil((t.paddedSize ?? t.size ?? 4) / 4));
	return words === 1 ? "u32" : `array<u32, ${words}>`;
}

function wgslVarDecl(b: GpuBinding, fieldName: (n: string) => string, typeName: (n: string) => string, typesMap: Map<string, TypePlan>): string {
	const name = fieldName(b.name);
	const rawDataType = getRawWgslType(b.dataTypeName, typeName, typesMap, b.usage);

	// Tworzymy tablice wielowymiarowe jeśli b.isArray jest true (np. array<array<u32, 12>>)
	const typePart = b.isArray ? `array<${rawDataType}>` : rawDataType;

	switch (b.usage) {
		case "storage-write":
			return `var<storage, read_write> ${name}: ${typePart}`;
		case "storage-read":
			return `var<storage, read> ${name}: ${typePart}`;
		case "uniform":
			// PRZYWRÓCONO: poprawne deklarowanie uniformów w WGSL
			return `var<uniform> ${name}: ${typePart}`;
		case "storage-atomic": {
			const atomicType = b.isArray
				? `array<atomic<${rawDataType}>>`
				: `atomic<${rawDataType}>`;
			return `var<storage, read_write> ${name}: ${atomicType}`;
		}
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
	switch (b.usage) {
		case "storage-write":
		case "storage-atomic":
			return `buffer: { type: "storage" as const }`;
		case "storage-read":
			return `buffer: { type: "read-only-storage" as const }`;
		case "uniform":
			// PRZYWRÓCONO: poprawne deklarowanie powiązań TS dla JS
			return `buffer: { type: "uniform" as const }`;
		case "texture-2d":
			return `texture: { sampleType: "${b.dataTypeName}" as GPUTextureSampleType }`;
		default:
			return `buffer: { type: "storage" as const }`;
	}
}

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
	code += `\tshaderModule: GPUShaderModule\n`;
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
		code += `\t\t\tcompute: { module: shaderModule, entryPoint: "${s.entryPoint}" }\n`;
		code += `\t\t}),\n`;
	}
	code += `\t};\n`;
	code += `}\n\n`;

	return code;
}

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

	const { fieldName, typeName } = ExporterTools(cfg as any);

	return {
		name: "gpu-bindings-wgsl",
		extension: "wgsl",
		config: cfg as any,
		generate: (plan: LayoutPlan) => {
			const typesMap = new Map<string, TypePlan>(plan.types.map(t => [t.name, t]));

			let code = "";
			for (const t of plan.types) {
				if (!isGpuBindingPlan(t)) continue;
				const sorted = [...t.bindings].sort((a, b) =>
					a.group !== b.group ? a.group - b.group : a.binding - b.binding,
				);
				for (const b of sorted) {
					code += `@group(${b.group}) @binding(${b.binding}) ${wgslVarDecl(b, fieldName, typeName, typesMap)};\n`;
				}
				code += "\n";
			}
			return code;
		},
	};
}