import { scope } from "arktype";
import { binary } from "./binary";

/**
 * WGSL predeclared vector and matrix aliases, layered on top of `binary`.
 *
 * Each entry is modelled as a fixed-length array so the analyzer's
 * std430/std140 layout calculator handles alignment naturally:
 *   - vec2<f32>: 8 bytes, align 8
 *   - vec3<f32>: 12 bytes, align 16 (padded to 16)
 *   - vec4<f32>: 16 bytes, align 16
 *   - matCxR<f32>: C columns of vecR (column-major)
 *
 * All entries below are predeclared in the WGSL spec, so the WGSL
 * exporter skips emitting `alias` lines for them.
 */

const ai32 = binary.type("i32").configure({
	description: "atomic<i32>",
	atomic: true
});
const au32 = binary.type("u32").configure({
	description: "atomic<u32>",
	atomic: true
});
const vec2f = binary.type("f32[] == 2").configure({
	description: "vec2<f32>",
});
const vec3f = binary.type("f32[] == 3").configure({
	description: "vec3<f32>",
});
const vec4f = binary.type("f32[] == 4").configure({
	description: "vec4<f32>",
});

const vec2i = binary.type("i32[] == 2").configure({
	description: "vec2<i32>",
});
const vec3i = binary.type("i32[] == 3").configure({
	description: "vec3<i32>",
});
const vec4i = binary.type("i32[] == 4").configure({
	description: "vec4<i32>",
});

const vec2u = binary.type("u32[] == 2").configure({
	description: "vec2<u32>",
});
const vec3u = binary.type("u32[] == 3").configure({
	description: "vec3<u32>",
});
const vec4u = binary.type("u32[] == 4").configure({
	description: "vec4<u32>",
});

export const wgsl = scope({
	...binary.export(),

	ai32,
	au32,
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
});

/**
 * Names predeclared by the WGSL spec — the exporter should NOT emit
 * `alias` lines for these because they already exist in every WGSL file.
 * Unsuffixed aliases (`vec2`, `mat3x3`) are NOT in this set; they are
 * project-level shorthands and need explicit alias emission.
 */
export const WGSL_PREDECLARED_ALIASES = new Set([
	"ai32",
	"au32",
	"vec2f",
	"vec3f",
	"vec4f",
	"vec2i",
	"vec3i",
	"vec4i",
	"vec2u",
	"vec3u",
	"vec4u",
	"vec2h",
	"vec3h",
	"vec4h",
	"mat2x2f",
	"mat2x3f",
	"mat2x4f",
	"mat3x2f",
	"mat3x3f",
	"mat3x4f",
	"mat4x2f",
	"mat4x3f",
	"mat4x4f",
	"mat2x2h",
	"mat2x3h",
	"mat2x4h",
	"mat3x2h",
	"mat3x3h",
	"mat3x4h",
	"mat4x2h",
	"mat4x3h",
	"mat4x4h",
]);
