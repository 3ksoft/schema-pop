/// <reference types="@types/bun" />
import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import { binary, Binding, Shader } from "@schema-pop/schema";
import { gpuBindingsTs, tsWebgpu } from "@schema-pop/exporter";
import { analyze } from "./utils";

function mkPlan(schema: any) {
	return analyze(
		type.module({ ...binary.import(), Binding, Shader, ...schema }),
		"v1",
	);
}

const physicsPlan = mkPlan({
	Particle: { x: "f32", y: "f32" },
	SimParams: { dt: "f32" },
	Physics: {
		particles:   "Binding<0, 0, 'storage-write', Particle[]>",
		obstacles:   "Binding<0, 1, 'storage-read', Particle[]>",
		params:      "Binding<0, 2, 'uniform', SimParams>",
		terrainMask: "Binding<1, 0, 'texture-2d', 'unfilterable-float'>",
	},
});

describe("gpuBindingsTs", () => {
	test("binding layout struct is detected as gpu-binding-layout kind", () => {
		const gpuType = physicsPlan.types.find((t: any) => t.kind === "gpu-binding-layout") as any;
		expect(gpuType).toBeDefined();
		expect(gpuType.name).toBe("Physics");
		expect(gpuType.bindings).toHaveLength(4);
	});

	test("emits correct group structure", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		expect(out).toContain("group0:");
		expect(out).toContain("group1:");
	});

	test("storage-write maps to buffer type storage", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		expect(out).toContain('buffer: { type: "storage" as const }');
	});

	test("storage-read maps to buffer type read-only-storage", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		expect(out).toContain('buffer: { type: "read-only-storage" as const }');
	});

	test("storage-write+indirect keeps storage binding and adds INDIRECT buffer usage", () => {
		const plan = mkPlan({
			Dispatch: { x: "u32", y: "u32", z: "u32" },
			Gpu: { args: "Binding<0, 0, 'storage-write+indirect', Dispatch>" },
		});
		const { bindings } = gpuBindingsTs({ dest: "out.ts" }).generate(plan) as { bindings: string };
		const { code } = tsWebgpu({ dest: "out.ts" }).generate(plan) as { code: string };
		expect(bindings).toContain('buffer: { type: "storage" as const }');
		expect(code).toContain("GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.INDIRECT");
	});

	test("uniform maps to buffer type uniform", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		expect(out).toContain('buffer: { type: "uniform" as const }');
	});

	test("texture-2d maps to texture sampleType", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		expect(out).toContain(
			'texture: { sampleType: "unfilterable-float" as GPUTextureSampleType }',
		);
	});

	test("export uses satisfies (not annotation) to preserve literal types", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		expect(out).not.toContain(": Record<string, GPUBindGroupLayoutEntry[]> =");
		expect(out).toContain("satisfies Record<string, GPUBindGroupLayoutEntry[]>");
	});

	test("storage-atomic emits buffer.type 'storage' (atomic is shader-side, not descriptor-level)", () => {
		const plan = mkPlan({
			Atomics: { grid: "Binding<0, 0, 'storage-atomic', i32[] == 64>" },
		});
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(plan) as { bindings: string };
		expect(out).toContain('buffer: { type: "storage" as const }');
	});

	test("bindings are sorted by binding index within each group", () => {
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan) as { bindings: string };
		const g0 = out.slice(out.indexOf("group0:"), out.indexOf("group1:"));
		const idx0 = g0.indexOf("binding: 0");
		const idx1 = g0.indexOf("binding: 1");
		const idx2 = g0.indexOf("binding: 2");
		expect(idx0).toBeLessThan(idx1);
		expect(idx1).toBeLessThan(idx2);
	});

	test("non-binding structs produce no output", () => {
		const plan = mkPlan({ Particle: { x: "f32", y: "f32" } });
		const { bindings: out } = gpuBindingsTs({ dest: "out.ts" }).generate(plan) as { bindings: string };
		expect(out).toBe("");
	});

	test("shader metadata preserves exact group:binding selections", () => {
		const plan = mkPlan({
			Particle: { x: "f32" },
			Gpu: {
				a: "Binding<0, 0, 'storage-write', Particle[]>",
				b: "Binding<0, 1, 'storage-write', Particle[]>",
				c: "Binding<2, 3, 'storage-write', Particle[]>",
				step: "Shader<string, 'step', '0:1;2:3', 64>",
			},
		});
		const generated = gpuBindingsTs({ dest: "out.ts" }).generate(plan) as { metadata: string };
		expect(generated.metadata).toContain('"step": [[0, 1], [2, 3]]');
		expect(generated.metadata).not.toContain("[0, 0]");
	});

	test("rejects shader references to undeclared bindings", () => {
		expect(() => mkPlan({
			Particle: { x: "f32" },
			Gpu: {
				a: "Binding<0, 0, 'storage-write', Particle[]>",
				step: "Shader<string, 'step', '0:1', 64>",
			},
		})).toThrow("undeclared binding 0:1");
	});
});
