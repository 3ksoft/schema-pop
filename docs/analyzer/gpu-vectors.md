# GPU Vectors and std140 / std430 Layouts

Schema-Pop natively supports WebGL / WebGPU / Vulkan memory layouts (`std140` and `std430`). One of the most complex parts of these layouts is how they handle mathematical vectors (`vec2`, `vec3`, `vec4`).

## How Vectors are Inferred

Instead of introducing new custom keywords like `vec3` into the schema syntax, Schema-Pop uses **Structural Inference** via standard ArkType array constraints.

Any fixed-size array of a primitive type with a length of `2`, `3`, or `4` is automatically classified as a mathematical Vector when using `std140` or `std430` layouts.

```typescript
import { scope } from "schema-pop";

const MyShaderData = scope({
    uv: "f32[] == 2",       // Inferred as vec2
    position: "f32[] == 3", // Inferred as vec3
    color: "f32[] == 4",    // Inferred as vec4
});
```

## The Layout Rules

When the analyzer detects a vector in `std140` or `std430` mode, it applies specific GPU alignment rules:

1.  **Alignment:**
    *   `vec2` (`T[] == 2`): Aligned to `2 * sizeof(T)`.
    *   `vec3` (`T[] == 3`): Aligned to `4 * sizeof(T)`.
    *   `vec4` (`T[] == 4`): Aligned to `4 * sizeof(T)`.
2.  **Stride / Internal Packing:**
    *   The elements inside the vector are tightly packed (stride = `sizeof(T)`).

### Example: The `vec3` Trap

In standard C/Rust (`aligned`), an array `f32[] == 3` takes 12 bytes and aligns to 4 bytes.
In `std140`, a `vec3` takes 12 bytes but **aligns to 16 bytes**.

```typescript
const Trap = scope({
    a: "f32",         // offset: 0,  size: 4
    b: "f32[] == 3",  // offset: 16, size: 12 (align 16 pushes it forward!)
});
```
If you tried to serialize this naively, `b` would start at offset 4, which would cause the GPU to read corrupted data. Schema-Pop correctly calculates the 12 bytes of padding after `a` and places `b` at offset 16.

## `std140` vs `std430` Arrays

The difference between `std140` and `std430` becomes obvious when you create an array of scalars or structs (not vectors).

```typescript
const Data = scope({
    values: "f32[] == 10" // Array of 10 floats
});
```

*   **`std140`:** The alignment of *any* array is rounded up to 16 bytes. `values` will have a stride of 16 bytes per float! (Total size: 160 bytes).
*   **`std430`:** The 16-byte rounding rule is dropped. `values` aligns to 4 bytes and has a stride of 4 bytes. (Total size: 40 bytes).

Schema-Pop handles all these padding and stride calculations completely automatically behind the scenes when you set your layout target.

```typescript
export default {
    layout: "std140", // or "std430", "aligned", "zero-padding"
    schemas: [...]
}
```

This makes Schema-Pop an incredible tool for defining Shader Storage Buffer Objects (SSBOs) and Uniform Buffer Objects (UBOs) in TypeScript and automatically generating the correct byte offsets for WebGL/WebGPU.