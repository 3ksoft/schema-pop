/// <reference types="@types/bun" />
import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import { binary, Binding } from "@schema-pop/schema";
import { gpuBindingsTs, gpuBindingsWgsl } from "@schema-pop/exporter";
import { analyze } from "./utils";

function mkPlan(schema: any) {
	return analyze(
		type.module({ ...binary.import(), Binding, ...schema }),
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
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		expect(out).toContain("group0:");
		expect(out).toContain("group1:");
	});

	test("storage-write maps to buffer type storage", () => {
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		expect(out).toContain('buffer: { type: "storage" as const }');
	});

	test("storage-read maps to buffer type read-only-storage", () => {
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		expect(out).toContain('buffer: { type: "read-only-storage" as const }');
	});

	test("uniform maps to buffer type uniform", () => {
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		expect(out).toContain('buffer: { type: "uniform" as const }');
	});

	test("texture-2d maps to texture sampleType", () => {
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		expect(out).toContain(
			'texture: { sampleType: "unfilterable-float" as GPUTextureSampleType }',
		);
	});

	test("export uses satisfies (not annotation) to preserve literal types", () => {
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		expect(out).not.toContain(": Record<string, GPUBindGroupLayoutEntry[]> =");
		expect(out).toContain("satisfies Record<string, GPUBindGroupLayoutEntry[]>");
	});

	test("storage-atomic emits buffer.type 'storage' (atomic is shader-side, not descriptor-level)", () => {
		const plan = mkPlan({
			Atomics: { grid: "Binding<0, 0, 'storage-atomic', i32[] == 64>" },
		});
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(plan);
		expect(out).toContain('buffer: { type: "storage" as const }');
	});

	test("bindings are sorted by binding index within each group", () => {
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(physicsPlan);
		const g0 = out.slice(out.indexOf("group0:"), out.indexOf("group1:"));
		const idx0 = g0.indexOf("binding: 0");
		const idx1 = g0.indexOf("binding: 1");
		const idx2 = g0.indexOf("binding: 2");
		expect(idx0).toBeLessThan(idx1);
		expect(idx1).toBeLessThan(idx2);
	});

	test("non-binding structs produce no output", () => {
		const plan = mkPlan({ Particle: { x: "f32", y: "f32" } });
		const out = gpuBindingsTs({ dest: "out.ts" }).generate(plan);
		expect(out).toBe("");
	});
});

describe("gpuBindingsWgsl", () => {
	test("emits @group @binding decorators", () => {
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(physicsPlan);
		expect(out).toContain("@group(0) @binding(0)");
		expect(out).toContain("@group(1) @binding(0)");
	});

	test("storage-write emits var<storage, read_write>", () => {
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(physicsPlan);
		expect(out).toMatch(/@group\(0\) @binding\(0\) var<storage, read_write> particles: array<Particle>/);
	});

	test("storage-read emits var<storage, read>", () => {
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(physicsPlan);
		expect(out).toMatch(/var<storage, read> obstacles: array<Particle>/);
	});

	test("uniform emits var<uniform>", () => {
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(physicsPlan);
		expect(out).toMatch(/var<uniform> params: SimParams/);
	});

	test("texture-2d emits texture_2d<f32>", () => {
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(physicsPlan);
		expect(out).toMatch(/var terrainMask: texture_2d<f32>/);
	});

	test("link-typed binding (non-array struct) produces correct WGSL", () => {
		const plan = mkPlan({
			Cfg: { x: "f32" },
			P: { cfg: "Binding<0, 0, 'uniform', Cfg>" },
		});
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(plan);
		expect(out).toMatch(/var<uniform> cfg: Cfg/);
	});

	test("storage-atomic wraps array element in atomic<T> (for atomicStore/Exchange/etc.)", () => {
		const plan = mkPlan({
			Atomics: {
				grid: "Binding<0, 0, 'storage-atomic', i32[] == 64>",
				forces: "Binding<0, 1, 'storage-atomic', u32[] == 32>",
			},
		});
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(plan);
		expect(out).toMatch(
			/@group\(0\) @binding\(0\) var<storage, read_write> grid: array<atomic<i32>>/,
		);
		expect(out).toMatch(
			/@group\(0\) @binding\(1\) var<storage, read_write> forces: array<atomic<u32>>/,
		);
	});

	test("storage-atomic on scalar binding emits atomic<T> (no array wrapper)", () => {
		const plan = mkPlan({
			Counters: {
				tick: "Binding<0, 0, 'storage-atomic', u32>",
			},
		});
		const out = gpuBindingsWgsl({ dest: "out.wgsl" }).generate(plan);
		expect(out).toMatch(
			/@group\(0\) @binding\(0\) var<storage, read_write> tick: atomic<u32>/,
		);
		expect(out).not.toMatch(/array</);
	});
});
