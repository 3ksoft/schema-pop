# Schema-Pop Exporter Issue: WGSL Atomic Type Generation

## Summary
The schema-pop exporter generates WGSL code with incorrect atomic type usage. When a buffer is defined as `ai32[]` (atomic i32 array) in the schema, the generated WGSL types are correct, but the shader code uses `atomicStore()` with plain `i32` values instead of atomic values.

## Problem

### Schema Definition (Correct)
```typescript
// packages/schema/src/schema.ts
Spatials: {
  collision_grid: `ai32[] == ${ENGINE.COLLISION_GRID_SIZE}`,
  collision_next: `ai32[] == ${ENGINE.MAX_PARTICLES}`,
  constraint_grid: `ai32[] == ${ENGINE.COLLISION_GRID_SIZE}`,
  constraint_next: `ai32[] == ${ENGINE.MAX_CONSTRAINTS}`,
}
```

### Generated WGSL Types (Correct)
```wgsl
// packages/engine/src/shaders/includes/schema.wgsl
alias Spatials = struct {
  collision_grid: array<atomic<i32>, 4096>,
  collision_next: array<atomic<i32>, 16384>,
  constraint_grid: array<atomic<i32>, 4096>,
  constraint_next: array<atomic<i32>, 16384>,
};
```

### Generated Shader Code (INCORRECT)
```wgsl
// packages/engine/src/shaders/xpbd.wgsl:3
@compute @workgroup_size(64)
fn clearGrid(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < 4096u) { atomicStore(&spatials.collision_grid[id.x], -1); }
}
```

**Error**: `atomicStore(ptr<storage, i32, read_write>, abstract-int)`
- Expected: `atomicStore(ptr<storage, atomic<i32>, read_write>, atomic<i32>)`
- Actual: `atomicStore(ptr<storage, i32, read_write>, i32)`

## Root Cause

The schema-pop exporter generates the correct type declarations (`array<atomic<i32>, N>`), but when generating shader code that uses these types, it doesn't properly handle the atomic type requirements. The `atomicStore()` function requires:
1. A pointer to `atomic<T>` type (not `T`)
2. An argument of type `atomic<T>` (not `T`)

## Reproduction Steps

1. Define a buffer with atomic type in schema:
   ```typescript
   MyBuffer: {
     counter: `ai32[] == 100`,
   }
   ```

2. Run `bun run build:schema`

3. Check generated shader code - it will use `atomicStore()` with plain integers

4. Try to compile/run - WGSL validation will fail

## Expected Behavior

When the exporter generates shader code that writes to `ai32[]` buffers, it should:
1. Use `atomicStore(&buffer[i], atomic<i32>(value))` 
2. Or wrap values with appropriate atomic constructors
3. Or generate code that doesn't require atomic operations when not needed

## Suggested Fix Options

### Option 1: Add Atomic Type Wrapping
When generating code that writes to atomic buffers, wrap scalar values:
```wgsl
atomicStore(&spatials.collision_grid[id.x], atomic<i32>(-1));
```

### Option 2: Add Configuration Flag
Allow users to specify whether to generate atomic-safe code:
```typescript
const cfg = {
  schemaName: "gpu",
  layout: "std430",
  autoLayout: true,
  autoSort: true,
  atomicSafe: true,  // New option
} as const;
```

### Option 3: Document Manual Fixes
Add comments in generated code indicating where atomic types need manual wrapping.

## Environment
- **schema-pop version**: 0.0.1
- **Command**: `bun run build:schema`
- **Error Location**: `packages/engine/src/shaders/xpbd.wgsl:3`

## Additional Context

This issue affects all atomic buffer operations in generated shaders:
- `atomicStore()` - needs atomic value argument ❌
- `atomicExchange()` - appears to work correctly (uses `i32(i)`)
- `atomicLoad()` - appears to work correctly (reads atomic type)

The inconsistency suggests the issue is specifically with how `atomicStore` is called.

## Files Involved
- `packages/schema/src/schema.ts` - Schema definition (correct)
- `packages/schema/src/cli.ts` - Exporter configuration
- `packages/engine/src/shaders/xpbd.wgsl` - Generated shader (incorrect)
- `packages/engine/src/shaders/includes/schema.wgsl` - Generated types (correct)
