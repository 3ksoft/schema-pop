# GPU  std430 Layouts

Schema-Pop natively supports WebGPU / Vulkan memory layouts (`std430`).

## Packing and unpacking in wgsl

## Discriminated unions




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
