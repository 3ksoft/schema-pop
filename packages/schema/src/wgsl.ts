import { scope } from "arktype";
import { binary } from "./binary";

/**
 * WGSL predeclared vector and matrix aliases, layered on top of `binary`.
 *
 * Vectors stay modelled as fixed-length arrays, but their WGSL ABI is declared
 * explicitly through size/alignment metadata instead of being inferred by the
 * analyzer from an array length:
 *   - vec2<f32/i32/u32>: size 8, align 8
 *   - vec3<f32/i32/u32>: size 12, align 16 (padded to 16)
 *   - vec4<f32/i32/u32>: size 16, align 16
 *   - matCxR<f32>: C columns of vecR (column-major)
 *
 * All entries below are predeclared in the WGSL spec, so the WGSL
 * exporter skips emitting `alias` lines for them.
 */

const ai32 = binary.type("i32").configure({
	wgslType: "atomic<i32>",
	atomic: true,
});

const au32 = binary.type("u32").configure({
	wgslType: "atomic<u32>",
	atomic: true,
});

const vec2f = binary.type("f32[] == 2").configure({ wgslType: "vec2f", size: 8, bitSize: 8 * 8, align: 8 });
const vec4f = binary.type("f32[] == 4").configure({ wgslType: "vec4f", size: 16, bitSize: 8 * 12, align: 16 });
const vec3f = binary.type("f32[] == 3").configure({ wgslType: "vec3f", size: 12, bitSize: 8 * 16, align: 16 });

const vec2i = binary.type("i32[] == 2").configure({ wgslType: "vec2i", size: 8, bitSize: 8 * 8, align: 8 });
const vec3i = binary.type("i32[] == 3").configure({ wgslType: "vec3i", size: 12, bitSize: 8 * 12, align: 16 });
const vec4i = binary.type("i32[] == 4").configure({ wgslType: "vec4i", size: 16, bitSize: 8 * 16, align: 16 });

const vec2u = binary.type("u32[] == 2").configure({ wgslType: "vec2u", size: 8, bitSize: 8 * 8, align: 8 });
const vec3u = binary.type("u32[] == 3").configure({ wgslType: "vec3u", size: 12, bitSize: 8 * 12, align: 16 });
const vec4u = binary.type("u32[] == 4").configure({ wgslType: "vec4u", size: 16, bitSize: 8 * 16, align: 16 });

const local_invocation_id = binary.type("u32[] == 3").configure({
	wgslBuiltin: "local_invocation_id",
	wgslType: "vec3u",
	size: 12,
	align: 16,
});
const global_invocation_id = binary.type("u32[] == 3").configure({
	wgslBuiltin: "global_invocation_id",
	wgslType: "vec3u",
	size: 12,
	align: 16,
});
const local_invocation_index = binary.type("u32").configure({ wgslBuiltin: "local_invocation_index" });
const workgroup_id = binary.type("u32[] == 3").configure({
	wgslBuiltin: "workgroup_id",
	wgslType: "vec3u",
	size: 12,
	align: 16,
});
const num_workgroups = binary.type("u32[] == 3").configure({
	wgslBuiltin: "num_workgroups",
	wgslType: "vec3u",
	size: 12,
	align: 16,
});
const vertex_index = binary.type("u32").configure({ wgslBuiltin: "vertex_index" });
const instance_index = binary.type("u32").configure({ wgslBuiltin: "instance_index" });
const builtin_position = binary.type("f32[] == 4").configure({
	wgslBuiltin: "builtin_position",
	wgslType: "vec4f",
	size: 16,
	align: 16,
});
const front_facing = binary.type("boolean").configure({ wgslBuiltin: "front_facing" });
const frag_depth = binary.type("f32").configure({ wgslBuiltin: "frag_depth" });
const sample_index = binary.type("u32").configure({ wgslBuiltin: "sample_index" });
const sample_mask = binary.type("u32").configure({ wgslBuiltin: "sample_mask" });
const primitive_index = binary.type("u32").configure({ wgslBuiltin: "primitive_index" });
const global_invocation_index = binary.type("u32").configure({ wgslBuiltin: "global_invocation_index" });
const workgroup_index = binary.type("u32").configure({ wgslBuiltin: "workgroup_index" });
const subgroup_invocation_id = binary.type("u32").configure({ wgslBuiltin: "subgroup_invocation_id" });
const subgroup_size = binary.type("u32").configure({ wgslBuiltin: "subgroup_size" });
const subgroup_id = binary.type("u32").configure({ wgslBuiltin: "subgroup_id" });
const num_subgroups = binary.type("u32").configure({ wgslBuiltin: "num_subgroups" });

export const wgsl = scope({
	...binary.export(),

	// Atomics
	ai32,
	au32,

	// Vectors
	vec2f,
	vec3f,
	vec4f,

	vec2i,
	vec3i,
	vec4i,

	vec2u,
	vec3u,
	vec4u,

	// Matrices: matCxR<f32> = C columns of vec<R, f32>, column-major
	mat2x2f: "vec2f[] == 2",
	mat2x3f: "vec3f[] == 2",
	mat2x4f: "vec4f[] == 2",
	mat3x2f: "vec2f[] == 3",
	mat3x3f: "vec3f[] == 3",
	mat3x4f: "vec4f[] == 3",
	mat4x2f: "vec2f[] == 4",
	mat4x3f: "vec3f[] == 4",
	mat4x4f: "vec4f[] == 4",

	// Builtins
	local_invocation_id,
	global_invocation_id,
	local_invocation_index,
	workgroup_id,
	num_workgroups,
	vertex_index,
	instance_index,
	builtin_position,
	front_facing,
	frag_depth,
	sample_index,
	sample_mask,
	primitive_index,
	global_invocation_index,
	workgroup_index,
	subgroup_invocation_id,
	subgroup_size,
	subgroup_id,
	num_subgroups,
});

export const WGSL_PREDECLARED_ALIASES = new Set(wgsl.exportedNames);
