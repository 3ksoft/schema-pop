# Memory Layout Strategies

Schema-Pop supports multiple memory layout strategies to ensure binary compatibility across a wide range of environments, from strict C/C++ ABIs to specialized GPU memory layouts.

To prevent the `SchemaAnalyzer` from becoming a monolithic mess, layout calculations are abstracted into distinct rule sets. The analyzer delegates the calculation of `align` and `size` to these strategies based on the `LayoutType` configuration.

## 1. `aligned` (Default C/Rust ABI)

The standard representation used by C (`#pragma pack(0)`), C++ (`alignas`), and Rust (`#[repr(C)]`). It balances fast memory access with reasonable memory footprint.

*   **Primitives:** Alignment is exactly equal to their physical size (up to the target's `wordSize`, typically 8 bytes). E.g., `u16` aligns to 2 bytes, `u64` aligns to 8 bytes.
*   **Structs:** The alignment of a struct is the maximum alignment of any of its members. The total size of the struct is padded at the end to be a multiple of this alignment.
*   **Arrays:** The alignment of an array is the alignment of its item type. The item size includes its own padding.
*   **Unions:** The alignment is `max(tag_align, max_payload_align)`. The total size is padded to this alignment.

## 2. `zero-padding` (Packed ABI)

Used when memory efficiency or exact byte-for-byte protocol matching is critical (e.g., network protocols, minimal IoT devices). Equivalent to `__attribute__((packed))` in GCC.

*   **Primitives:** Alignment is **always 1**.
*   **Structs/Arrays/Unions:** Alignment is **always 1**.
*   **Padding:** No padding bytes are ever inserted. Fields are strictly adjacent.

## 3. `std140` (GPU - Uniform Buffer Objects)

A strict OpenGL/Vulkan layout rule designed for safe cross-platform GPU memory mapping. It is notoriously inefficient with memory space due to aggressive padding requirements.

*   **Scalars (N):** Align to their size (e.g., `float` = 4, `double` = 8).
*   **2-Component Vectors (2N):** Align to 2 * base size (e.g., `vec2` = 8 bytes).
*   **3/4-Component Vectors (3N/4N):** Align to 4 * base size (e.g., `vec3` and `vec4` both align to 16 bytes).
*   **Arrays:** *Crucial rule* - The alignment of ANY array, even an array of `float`, is rounded up to the alignment of a `vec4` (16 bytes). The stride between elements is always a multiple of 16 bytes.
*   **Structs:** The alignment of a struct is equal to the alignment of a `vec4` (16 bytes), and its size is padded to a multiple of 16 bytes.

## 4. `std430` (GPU - Shader Storage Buffer Objects)

A newer, more memory-efficient layout for GPUs, used primarily for SSBOs.

*   **Scalars & Vectors:** Rules are identical to `std140`.
*   **Arrays:** The 16-byte rounding rule is dropped. An array of `float` has an alignment of 4 and a stride of 4.
*   **Structs:** The 16-byte rounding rule is dropped. Struct alignment is simply the largest alignment of its members (just like the `aligned` strategy).

## Implementation Note

Instead of nesting `if/else` statements inside the analyzer's core loop, the layout engine uses a Strategy Pattern:

```typescript
interface LayoutStrategy {
    getPrimitiveLayout(type: string): { size: number, align: number };
    getArrayLayout(itemLayout: Layout, length: number): { size: number, align: number };
    getStructLayout(fields: FieldPlan[]): { size: number, align: number };
}
```
This keeps the `SchemaAnalyzer` solely responsible for dependency resolution and structural traversal, leaving the math to the specific strategy.