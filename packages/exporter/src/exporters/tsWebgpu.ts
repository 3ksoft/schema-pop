import type {
	BaseConfig,
	ExporterPlugin,
	GpuBinding,
	GpuBindingPlan,
	LayoutPlan,
} from "@schema-pop/schema";
import { ExporterTools, toCamelCase, toPascalCase } from "../exporterTools";

export interface TsWebgpuConfig extends BaseConfig {
	limits?: Record<string, string>;
	codecImportPath?: string;
	bindingsImportPath?: string;
}

const STATIC_SIZES: Record<string, number> = {
	bool: 4,
	u8: 1, i8: 1,
	u16: 2, i16: 2,
	u32: 4, i32: 4, f32: 4,
	u64: 8, i64: 8, f64: 8,
	vec2f: 8, vec2i: 8, vec2u: 8, "vec2<f32>": 8, "vec2<i32>": 8, "vec2<u32>": 8,
	vec3f: 16, vec3i: 16, vec3u: 16, "vec3<f32>": 16, "vec3<i32>": 16, "vec3<u32>": 16,
	vec4f: 16, vec4i: 16, vec4u: 16, "vec4<f32>": 16, "vec4<i32>": 16, "vec4<u32>": 16,
};

function isGpuBindingPlan(t: any): t is GpuBindingPlan {
	return t.kind === "gpu-binding-layout";
}

export function tsWebgpu(
	config: TsWebgpuConfig,
): ExporterPlugin<TsWebgpuConfig> {
	const cfg = {
		fieldNaming: "original",
		typeNaming: "original",
		codecImportPath: "./codec",
		limits: {},
		...config,
	} as const;
	const { typeName, fieldName } = ExporterTools(cfg as any);

	return {
		name: "webgpu-harness",
		extension: "ts",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const bindingPlan = plan.types.find(isGpuBindingPlan);
			if (!bindingPlan) {
				return `// No gpu-binding-layout found in schema to generate harness.`;
			}

			const limitMap = cfg.limits || {};

			const usedDataTypes = new Set<string>();
			for (const b of bindingPlan.bindings) {
				if (b.usage !== "texture-2d" && !STATIC_SIZES[b.dataTypeName]) {
					usedDataTypes.add(b.dataTypeName);
				}
			}

			let code = ``;

			if (usedDataTypes.size > 0) {
				code += `import {\n`;
				for (const type of [...usedDataTypes].sort()) {
					code += `\tSIZEOF_${type},\n`;
				}
				code += `} from "${cfg.codecImportPath}";\n\n`;
			}

			// === GENEROWANIE STAŁYCH OPISUJĄCYCH BUFORY GPU ===
			for (const b of bindingPlan.bindings) {
				if (b.usage === "texture-2d") continue;

				const rawName = fieldName(b.name);
				const camelName = toCamelCase(rawName);

				const lengthVal = (b as any).exactLength !== undefined
					? (b as any).exactLength
					: ((b as any).maxLength !== undefined ? (b as any).maxLength : undefined);

				const limit = lengthVal !== undefined
					? `${lengthVal}`
					: (limitMap[b.dataTypeName] || "1");

				const sizeExpr = STATIC_SIZES[b.dataTypeName] !== undefined
					? `${limit} * ${STATIC_SIZES[b.dataTypeName]}`
					: `${limit} * SIZEOF_${b.dataTypeName}`;

				let usageStr = "GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC";
				if (b.usage === "storage-read") {
					usageStr = "GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST";
				} else if (b.usage === "uniform") {
					usageStr = "GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST";
				}

				code += `export const ${camelName}Buffer = {\n`;
				code += `\tlabel: "${rawName}",\n`;
				code += `\tsize: ${sizeExpr},\n`;
				code += `\tusage: ${usageStr},\n`;
				code += `\tmappedAtCreation: true,\n`;
				code += `};\n\n`;
			}

			// === GENEROWANIE INTERFEJSU I FUNKCJI INICJALIZACJI BUFORÓW NA GPU ===
			const bufferBindings = bindingPlan.bindings.filter(b => b.usage !== "texture-2d");
			if (bufferBindings.length > 0) {
				code += `export interface GpuResources {\n`;
				for (const b of bufferBindings) {
					const camelName = toCamelCase(fieldName(b.name));
					code += `\t${camelName}Buffer: GPUBuffer;\n`;
				}
				code += `}\n\n`;

				code += `export function createGpuBuffers(device: GPUDevice): GpuResources {\n`;
				code += `\tconst resources: GpuResources = {\n`;
				for (const b of bufferBindings) {
					const camelName = toCamelCase(fieldName(b.name));
					code += `\t\t${camelName}Buffer: device.createBuffer(${camelName}Buffer),\n`;
				}
				code += `\t};\n\n`;

				code += `\t// Zerowanie i unmapowanie początkowe\n`;
				for (const b of bufferBindings) {
					const camelName = toCamelCase(fieldName(b.name));
					code += `\tnew Uint8Array(resources.${camelName}Buffer.getMappedRange()).fill(0);\n`;
					code += `\tresources.${camelName}Buffer.unmap();\n`;
				}
				code += `\n\treturn resources;\n`;
				code += `}\n\n`;
			}

			// === GENEROWANIE FUNKCJI DLA GRUP POWIĄZAŃ (BIND GROUPS) ===
			const byGroup = new Map<number, GpuBinding[]>();
			for (const b of bindingPlan.bindings) {
				if (!byGroup.has(b.group)) byGroup.set(b.group, []);
				byGroup.get(b.group)!.push(b);
			}

			for (const [group, bindings] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
				const sortedBindings = bindings.sort((a, bb) => a.binding - bb.binding);

				// Funkcja tworząca layout grupy powiązań
				code += `export function createBg${group}Layout(device: GPUDevice): GPUBindGroupLayout {\n`;
				code += `\treturn device.createBindGroupLayout({\n`;
				code += `\t\tlabel: "bg${group}Layout",\n`;
				code += `\t\tentries: [\n`;
				for (const b of sortedBindings) {
					code += `\t\t\t{\n`;
					code += `\t\t\t\tbinding: ${b.binding},\n`;
					code += `\t\t\t\tvisibility: GPUShaderStage.COMPUTE,\n`;
					if (b.usage === "texture-2d") {
						code += `\t\t\t\ttexture: {},\n`;
					} else {
						let typeVal = "storage";
						if (b.usage === "storage-read") {
							typeVal = "read-only-storage";
						} else if (b.usage === "uniform") {
							typeVal = "uniform";
						}
						code += `\t\t\t\tbuffer: { type: "${typeVal}" },\n`;
					}
					code += `\t\t\t},\n`;
				}
				code += `\t\t],\n`;
				code += `\t});\n`;
				code += `}\n\n`;

				// Interfejs wejściowy dla zasobów bind grupy
				code += `export interface Bg${group}Resources {\n`;
				for (const b of sortedBindings) {
					const rawName = fieldName(b.name);
					const camelName = toCamelCase(rawName);
					if (b.usage === "texture-2d") {
						code += `\t${camelName}View: GPUTextureView;\n`;
					} else {
						code += `\t${camelName}Buffer: GPUBuffer;\n`;
					}
				}
				code += `}\n\n`;

				// Funkcja tworząca GPUBindGroup
				code += `export function createBg${group}(\n`;
				code += `\tdevice: GPUDevice,\n`;
				code += `\tlayout: GPUBindGroupLayout,\n`;
				code += `\tresources: Bg${group}Resources\n`;
				code += `): GPUBindGroup {\n`;
				code += `\treturn device.createBindGroup({\n`;
				code += `\t\tlayout,\n`;
				code += `\t\tentries: [\n`;

				for (const b of sortedBindings) {
					const rawName = fieldName(b.name);
					const camelName = toCamelCase(rawName);
					if (b.usage === "texture-2d") {
						code += `\t\t\t{ binding: ${b.binding}, resource: resources.${camelName}View },\n`;
					} else {
						code += `\t\t\t{ binding: ${b.binding}, resource: { buffer: resources.${camelName}Buffer } },\n`;
					}
				}

				code += `\t\t],\n`;
				code += `\t});\n`;
				code += `}\n\n`;
			}

			return code;
		},
	};
}