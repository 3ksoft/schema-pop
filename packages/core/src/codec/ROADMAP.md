# `PopCodec` Architecture Roadmap (v1.0)

The current implementation of `PopCodec` behaves as a **Runtime Schema Interpreter**. It loads the entire `LayoutPlan` (JSON representation of the schema) into memory and traverses it on every `.encode()` and `.decode()` call.

While this is highly flexible and perfectly adequate for the initial release, it limits peak performance in environments demanding high-throughput serialization (e.g., Gamedev, real-time IoT dashboards, WebSocket streams). Traversing the abstract syntax tree and constantly allocating small JavaScript objects puts unnecessary pressure on the V8 Engine and the Garbage Collector.

For `schema-pop` v1.0, we plan to shift to a more sophisticated architecture based on **code generation** and **lazy evaluation**.

---

## 1. AOT Compiled Codecs (JIT via Exporters)

Instead of interpreting the layout dynamically, the `typescript` exporter will be enhanced to generate **Ahead-Of-Time (AOT) compiled codecs**.

Instead of outputting `_codec.encode("User", data)`, the exporter will generate flat, heavily optimized JavaScript loops tailored to the specific schema layout:

```typescript
export const UserCodec = {
    decode: (view: DataView, offset: number) => ({
        id: view.getUint32(offset + 0, true),
        age: view.getUint8(offset + 4),
        roles: Array.from({ length: view.getUint32(offset + 5, true) }, (_, i) => 
            view.getUint8(offset + 9 + (i * 1))
        )
    })
};
```

### Benefits:
- **~10x-50x Performance Boost**: V8 can aggressively JIT-compile these flat functions into raw machine code.
- **Zero Overhead**: Eliminates all internal `switch` statements, `findType` loop lookups, and layout mathematical recalculations at runtime.
- **Smaller Bundle Size**: Clients using the generated schema won't necessarily need to bundle the `LayoutPlan` nor the `PopCodec` class.

---

## 2. Zero-Copy Decoding (Lazy Evaluation)

Creating raw JavaScript objects works well for web forms, but it is fatal for processing massive continuous streams of data (e.g., large arrays of IoT telemetry). 

We will introduce a `TypeScriptZeroCopy` exporter target. Instead of decoding data into standard objects, it will return a **Class/Proxy** that holds only a reference to the `DataView` and an `offset`.

```typescript
class UserView {
    constructor(private view: DataView, private offset: number) {}

    // Parsed dynamically ONLY when requested
    get id() { return this.view.getUint32(this.offset + 0, true); }
    get age() { return this.view.getUint8(this.offset + 4); }
}
```

### Benefits:
- **O(1) Decoding**: Decoding a 10MB binary file takes 0ms. CPU time is only consumed when properties are explicitly accessed.
- **No Garbage Collection Pressure**: No temporary objects or arrays are ever allocated in memory.
- **WebWorker / WebGPU Ready**: The underlying `ArrayBuffer` remains intact and can be directly passed as a SharedArrayBuffer to WebWorkers or GPU shaders.

---

## 3. Dynamic Size & Pointer Logic (FlatBuffers-style)

Currently, `schema-pop` strings and arrays rely heavily on `maxLength` metadata (preallocating massive blocks of zeroes to preserve strict ABI sizes like `char[64]`). While suitable for embedded systems (C/Rust), it wastes bandwidth in dynamic environments.

We plan to introduce **Pointer-Based Types** (similar to FlatBuffers). Instead of packing string bytes directly inside the struct, the struct will hold a `uint32` offset pointing to the end of the buffer where the dynamic data resides. This enables infinitely sized strings and arrays without compromising the strict V-Table layout of the primary structure.

---

## 4. Inverse-Patching & Migration Codecs

`schema-pop` guarantees backward and forward compatibility by analyzing the differences between schema versions. 

We will implement a dynamic migration mechanism inside the codec. If the backend serves v2 of the binary schema, but the frontend still runs v1, the codec will dynamically apply an inverse patch:
1. Intercept the binary payload.
2. Translate the byte offsets according to the diff engine.
3. Feed the v1 application the legacy structure, filling newly deleted fields with defaults, or discarding new fields completely.

This will allow zero-downtime updates across the entire hardware-software stack.