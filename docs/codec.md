# Runtime Codecs

Schema-Pop provides three codec modes for serializing, deserializing, and patching binary data from a `LayoutPlan`.

Each mode produces the same binary representation. They differ only in when codec logic is compiled and how it is executed.

---

## Choosing a Codec Mode

| Mode                    | API                      | Performance                          | CSP Compliant            | Best For                                                                        |
| :---------------------- | :----------------------- | :----------------------------------- | :----------------------- | :------------------------------------------------------------------------------ |
| **Static / AOT**        | `tsCodec`                | **Fastest generated implementation** | ✅ Yes                    | Production hot paths with a build-time generation step                          |
| **JIT Runtime**         | `createRuntimeCodec`     | **Very fast**                        | ❌ Requires `unsafe-eval` | Dynamic schemas, game engines, simulations, and other runtime-defined workloads |
| **Interpreted Runtime** | `createInterpretedCodec` | **Moderate**                         | ✅ Yes                    | Strict CSP environments, tooling, extensions, workers, and infrequent updates   |

The static and JIT codecs compile specialized JavaScript for each type. The interpreted codec traverses the layout directly during each operation.

---

## 1. Static Codec

The `tsCodec` exporter generates dedicated TypeScript codec functions during the Schema-Pop build step.

Because the generated functions are ordinary static JavaScript, they are compatible with strict Content Security Policy settings and can be optimized normally by the JavaScript runtime.

```ts
import {
	MpmParticleCodec,
	SIZEOF_MPM_PARTICLE,
} from "./generated/codec";

const buffer = new ArrayBuffer(SIZEOF_MPM_PARTICLE);
const view = new DataView(buffer);

MpmParticleCodec.serialize(particle, view, 0);

const restoredParticle =
	MpmParticleCodec.deserialize(view, 0);
```

The static codec is the preferred option when:

* the schema is known at build time,
* generated files fit naturally into the project,
* codec operations are part of a performance-critical loop,
* strict CSP compliance is required.

---

## 2. JIT Runtime Codec

`createRuntimeCodec` compiles specialized JavaScript functions directly from a `LayoutPlan` at runtime.

It uses `new Function()` during initialization. After compilation, codec operations run without repeatedly traversing the layout tree.

```ts
import { createRuntimeCodec } from "./runtimeCodec";
import type { MpmParticle } from "./types";

const suite = createRuntimeCodec(plan, {
	inlineRefBytes: 16,
});

const particleCodec =
	suite.get<MpmParticle>("MpmParticle");

const buffer = new ArrayBuffer(particleCodec.size);
const view = new DataView(buffer);

particleCodec.serialize(particle, view, 0);

const restoredParticle =
	particleCodec.deserialize(view, 0);
```

The JIT runtime codec is useful when:

* schemas are created or loaded dynamically,
* a build-time generation step is undesirable,
* codec performance matters,
* the environment permits dynamic code generation.

### Content Security Policy

Because the JIT codec uses `new Function()`, it requires a CSP configuration that permits dynamic JavaScript evaluation.

In browser environments, this normally means enabling:

```text
script-src 'unsafe-eval'
```

The interpreted or static codec should be used when this is not acceptable.

---

## 3. Interpreted Runtime Codec

`createInterpretedCodec` operates directly on the `LayoutPlan`.

It does not generate JavaScript and does not use `eval()` or `new Function()`, making it suitable for strict CSP environments.

```ts
import { createInterpretedCodec } from "./interpretedCodec";
import type { MpmParticle } from "./types";

const suite = createInterpretedCodec(plan);

const particleCodec =
	suite.get<MpmParticle>("MpmParticle");

const buffer = new ArrayBuffer(particleCodec.size);
const view = new DataView(buffer);

particleCodec.serialize(particle, view, 0);

const restoredParticle =
	particleCodec.deserialize(view, 0);
```

The interpreted codec is useful for:

* browser extensions,
* Web Workers with strict CSP,
* enterprise applications,
* development tools,
* schema inspectors,
* dynamic schemas used outside hot loops.

### Reusing an Existing Object

Deserialization can reuse an existing target object instead of creating a new root object:

```ts
particleCodec.deserialize(
	view,
	0,
	particle,
);
```

This is useful when repeatedly updating an existing object graph.

It avoids allocating a new root object, although nested values may still allocate depending on the schema and codec implementation.

---

## Targeted Byte Patching

Runtime codecs support updating a single field directly inside an existing binary buffer.

```ts
particleCodec.patch(
	["vel", 0],
	0,
	12.5,
	view,
	0,
);
```

This example updates:

```ts
particle.vel[0]
```

without serializing the entire object again.

The arguments are:

```ts
codec.patch(
	path,
	arrayIndex,
	value,
	view,
	baseOffset,
);
```

Patching is particularly useful for:

* GPU uniform and storage buffers,
* memory-mapped state,
* network packet updates,
* ECS component storage,
* frequently changing scalar fields.

---

## Binary Compatibility

All codec modes use the same `LayoutPlan` and produce the same binary representation.

A buffer serialized by one mode can be deserialized by another:

```ts
aotCodec.serialize(value, view, 0);

const restored =
	jitCodec.deserialize(view, 0);
```

The codec mode does not affect:

* field offsets,
* alignment,
* padding,
* payload size,
* endianness,
* reference encoding.

This makes it possible to use different modes in different parts of the same system.

For example:

```text
Build tools       → Interpreted codec
Browser runtime   → JIT codec
Production server → Static codec
```

---

## Performance

The following benchmark was run on:

```text
CPU:     AMD Ryzen 5 2600 Six-Core Processor
Clock:   approximately 3.46 GHz
Runtime: Bun 1.3.13, x64 Linux
```

All implementations passed the same correctness checks:

```ts
const correctness = {
	codecAOT: true,
	codecJIT: true,
	codecInterp: true,
	hand: true,
	json: true,
	msgpack: true,
	msgpackRec: true,
	bebop: true,
};
```

### Encode

| Codec                   |      Average |
| :---------------------- | -----------: |
| Static codec            | **83.89 ns** |
| Hand-written `DataView` |    126.08 ns |
| JIT runtime codec       |    270.54 ns |
| Bebop                   |      1.85 µs |
| JSON                    |      4.34 µs |
| Msgpackr with records   |      4.71 µs |
| Interpreted codec       |      5.57 µs |
| Msgpackr                |      6.50 µs |

The static codec was:

* 1.5× faster than the hand-written `DataView` implementation,
* 3.22× faster than the JIT runtime codec,
* 22.07× faster than Bebop,
* 51.71× faster than `JSON.stringify`,
* 66.36× faster than the interpreted codec.

### Decode

| Codec                   |       Average |
| :---------------------- | ------------: |
| Hand-written `DataView` | **242.61 ns** |
| Static codec            |     315.01 ns |
| JIT runtime codec       |     433.08 ns |
| Bebop                   |     516.21 ns |
| Interpreted codec       |       4.27 µs |
| JSON                    |       7.29 µs |
| Msgpackr with records   |       7.85 µs |
| Msgpackr                |      10.77 µs |

The hand-written implementation was fastest in this decode benchmark.

The static and JIT codecs remained within the sub-microsecond range, while preserving generated or runtime-defined schema support.

### Roundtrip

| Codec                   |       Average |
| :---------------------- | ------------: |
| Hand-written `DataView` | **350.33 ns** |
| Static codec            |     428.89 ns |
| JIT runtime codec       |     788.56 ns |
| Bebop                   |       2.84 µs |
| Interpreted codec       |       8.13 µs |
| Msgpackr with records   |      10.55 µs |
| JSON                    |      11.81 µs |
| Msgpackr                |      14.76 µs |

The JIT runtime codec completed a full encode and decode roundtrip in under one microsecond.

The interpreted codec remained faster than JSON and Msgpackr in this benchmark, despite executing through direct layout traversal.

---

## Payload Size

All Schema-Pop codec modes produce the same payload because they use the same binary layout.

| Format                  |  Payload Size |
| :---------------------- | ------------: |
| Bebop                   | **293 bytes** |
| Schema-Pop              |     332 bytes |
| Hand-written `DataView` |     332 bytes |
| Msgpackr with records   |     611 bytes |
| Msgpackr                |     826 bytes |
| JSON                    |    1478 bytes |

Schema-Pop produced exactly the same payload size as the hand-written binary implementation.

The resulting payload was:

* approximately 13% larger than Bebop,
* approximately 1.84× smaller than Msgpackr with records,
* approximately 2.49× smaller than Msgpackr,
* approximately 4.45× smaller than JSON.

---

## Recommended Usage

Use the static codec for maximum generated performance:

```ts
exporters: [
	tsCodec(),
]
```

Use the JIT codec when the schema is only available at runtime:

```ts
const suite = createRuntimeCodec(plan);
```

Use the interpreted codec when strict CSP compliance matters and runtime-defined schemas are still required:

```ts
const suite =
	createInterpretedCodec(plan);
```

A practical default is:

```text
Known schema + build step      → Static
Dynamic schema + permissive CSP → JIT
Dynamic schema + strict CSP     → Interpreted
```

All three modes remain binary-compatible and can be selected independently without changing the schema or stored data format.
