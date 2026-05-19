// Test fixture for the WGSL exporter, modelled on a real GPU physics
// kernel (XPBD + MLS-MPM). Demonstrates the subset of GPU-shaped types
// schema-pop covers today: scalars, fixed-length vectors via `T[] == N`,
// fixed-length arrays, simple structs that nest other structs.
//
// Things this fixture deliberately does NOT cover (because the analyzer
// doesn't model them yet): `atomic<T>` qualifiers, runtime-sized storage
// arrays (`array<T>` without bound), native matrix types (`mat2x2<f32>`).
// The original kernel hand-flattens its 2x2 matrices into four `f32`
// fields — we mirror that here.

import { schemaPop, scope } from "schema-pop";
import { cpp } from "@schema-pop/exporter";
import { html, wgsl } from "@schema-pop/exporter";

export const $ = schemaPop(
	{
		layout: "std430",
		autoLayout: false,
		targets: [
			cpp({ dest: "./gpu-physics.wgsl" }),
			html({ dest: "./gpu-physics.html" }),
		],
	},
	scope({
	...schemaPop,

	// ---- shared vector aliases (vec2<f32>, vec4<f32>) -----------------
	// Fixed-length f32 arrays of size 2/3/4 lower to vec2/vec3/vec4 in
	// the WGSL exporter. Naming them is optional but makes call sites
	// read like the GPU code.
	Vec2: "f32[] == 2",
	Vec4: "f32[] == 4",
	IVec2: "i32[] == 2",

	// ---- core particle / constraint / obstacle ------------------------
	Particle: {
		pos: "Vec2",
		prev_pos: "Vec2",
		mass: "f32",
		friction: "f32",
		radius: "f32",
		object_data: "u32",
	},

	Constraint: {
		idx_a: "i32",
		idx_b: "i32",
		idx_c: "i32",
		c_type_color: "u32",
		rest_value: "f32",
		compliance: "f32",
		extra: "Vec2",
		lambda: "f32",
		// pad0/pad1/pad2 from the hand-written WGSL are intentionally
		// dropped — std430 alignment in the exporter inserts equivalent
		// trailing padding automatically.
	},

	Obstacle: {
		pos: "Vec2",
		rotation: "f32",
		object_data: "u32",
		params: "Vec4",
	},

	// ---- simulation parameters (uniform buffer) -----------------------
	// One struct of ~20 scalars; the std140 layout would pad each
	// scalar to 16 bytes, std430 packs them tighter. Kernel uses
	// std430-style packing.
	Params: {
		dt: "f32",
		substeps: "u32",
		gravity: "Vec2",
		world_bounds: "Vec4",
		collision_iterations: "u32",
		num_obstacles: "u32",
		is_paused: "u32",
		phase: "u32",
		num_commands: "u32",
		mpm_domain_offset_x: "f32",
		mpm_domain_offset_y: "f32",
		num_queries: "u32",
		mpm_dx: "f32",
		mpm_inv_dx: "f32",
		mpm_grid_res: "u32",
		mpm_num_particles: "u32",
		erase_active: "u32",
		erase_radius_sq: "f32",
		erase_pos: "Vec2",
		mpm_damping: "f32",
	},

	// ---- MLS-MPM particle (matrix flattened) --------------------------
	// C and F are 2x2 matrices flattened to four f32s each, mirroring
	// the original kernel which avoided `mat2x2<f32>` (probably for
	// alignment-control reasons or because the values aren't always
	// used as a unit).
	MpmParticle: {
		pos: "Vec2",
		vel: "Vec2",
		c00: "f32",
		c01: "f32",
		c10: "f32",
		c11: "f32",
		f00: "f32",
		f01: "f32",
		f10: "f32",
		f11: "f32",
		mass: "f32",
		volume: "f32",
		type_mat: "u32",
		j: "f32",
		color: "u32",
		bulk_modulus: "f32",
		gamma: "f32",
	},

	// ---- command queue + spatial query --------------------------------
	Command: {
		cmd_type: "u32",
		index: "u32",
		d0: "Vec4",
		d1: "Vec4",
	},

	Query: {
		q_type: "u32",
		mask: "u32",
		origin: "Vec2",
		dir_or_radius: "Vec2",
		max_dist: "f32",
	},

	QueryResult: {
		count: "u32",
		hit_type: "u32",
		hit_idx: "i32",
		distance: "f32",
		hit_pos: "Vec2",
		hit_normal: "Vec2",
		// fixed-length array; lowers to `array<i32, 16>` in WGSL.
		hits: "i32[] == 16",
	},
}),
);
