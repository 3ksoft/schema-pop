# Constraint-Based Type Inference

Schema-Pop introduces a powerful mechanism for type resolution: **Structural Binary Matching**. 

Instead of strictly requiring the user to explicitly import and use nominal binary types (like `binary.u8` or `binary.i32`), the analyzer can automatically infer the optimal binary representation by examining the mathematical bounds of a standard schema definition.

## How It Works

When the analyzer encounters a generic type (e.g., a simple `number`), it checks the constraints (rules) applied to that type by the schema.

### Automatic Primitive Mapping

If a user defines a schema:

arktype
```typescript
const MySchema = type({
    age: "0 <= number <= 120",
    score: "number <= 65000"
});
```

zod
```typescript
const MySchema = z.object({
    age: z.number().min(0).max(120),
    score: z.number().max(65000)
});
```


The Schema-Pop analyzer observes the bounds and maps them without any extra configuration:
*   `age` has a maximum of 120 and minimum of 0. This perfectly fits inside an unsigned 8-bit integer. Schema-Pop automatically maps it to `u8`.
*   `score` fits within `u16`.

### Automatic Bitwise Mapping

This structural inference extends to bit-packed fields as well. 

arktype
```typescript
const Settings = type({
    powerLevel: "0 <= number < 4",  // Maps to u2 (2 bits)
    mode: "0 <= number < 8"         // Maps to u3 (3 bits)
});
```

zod
```typescript
const Settings = z.object({
    powerLevel: z.number().min(0).max(3),  // Maps to u2 (2 bits)
    mode: z.number().min(0).max(7)         // Maps to u3 (3 bits)
});
```

When the `LayoutConfig` is set to utilize bit-packing, the analyzer will aggregate these fields into a single byte payload, automatically managing the bit offsets.

## Why is this revolutionary?

1. **Zero-Config Integrations:** You can feed ANY valid ArkType schema into Schema-Pop, and it will generate the most optimal binary representation possible, even if the original schema had no knowledge of Schema-Pop or binary buffers.
2. **OpenAPI / JSON Schema Compatibility:** OpenAPI schemas heavily rely on `minimum`, `maximum`, and `format` fields. By importing an OpenAPI definition into ArkType, Schema-Pop instantly translates those REST API models into highly-efficient binary structs for native languages.
3. **Custom Aliases:** Users can define their own application-specific boundaries without needing to write custom Pop Exporters. As long as the constraints are understood by ArkType, Schema-Pop understands how to serialize it.

## Evaluation Order

The analyzer attempts to resolve constraints in the following priority (smallest to largest):

1. **Bitwise:** `u1` ... `u7` (if bit-packing is enabled)
2. **Unsigned Primitives:** `u8` -> `u16` -> `u32` -> `u64`
3. **Signed Primitives:** `i8` -> `i16` -> `i32` -> `i64`
4. **Floats:** `f32` -> `f64` (Fallback for generic numbers without strict integer bounds)