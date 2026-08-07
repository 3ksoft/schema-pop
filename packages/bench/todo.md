
# Section H: Best-of-All Synthesis

## Recommended Generator Pipeline

```
[Schema IR]
    │
    ├── 1. Structural Analyzer
    │      └── Identify fixed-size structs & fixed-length array fields
    │
    ├── 2. Offset & Stride Compiler
    │      └── Fold all primitive field relative offsets statically
    │
    ├── 3. Code Emitter (Serialization)
    │      └── For fixed arrays (N >= 4): Emit tight `for` loop + inlined field setters
    │
    └── 4. Code Emitter (Deserialization)
           ├── Eliminate IIFEs
           ├── Emit `new Array(N)` allocation
           └── Emit tight `for` loop + inlined object construction
```

## Optimization Strategy Classification

### Implement Now
1. **Loop + Inline Field Access:** Emit a `for` loop over fixed arrays, but write primitive `DataView` getters/setters inline inside the loop. (*High confidence; +18% decode, 0% encode penalty*).
2. **Pre-allocated Array Allocation:** Emit `const arr = new Array(N)` followed by indexed assignment. (*High confidence; +10% decode*).
3. **IIFE Elimination:** Remove closure wrappers around array deserialization. (*High confidence; eliminates allocation*).
4. **Static Offset Folding:** Fold static relative offsets (`po + 4`, `po + 8`). (*High confidence*).

### Benchmark Further
1. **Unrolling Thresholds for Small Arrays (N = 2, 3, 4):** Test whether unrolling is beneficial for tiny arrays before triggering V8's bytecode threshold.

### Reject for Now
1. **Full Unrolling for Array Serialization (N >= 8):** Causes a massive 140%+ encode regression on V8.
2. **Scratch TypedArrays / Manual Byte Shifting:** 2.4x–2.8x slower than `DataView` intrinsics.
3. **DataView Method Binding:** Adds function call indirection without performance benefit.

---

# Section I: Proposed Optimized Generator Design

## Conceptual Code Generator Rules

1. **Standalone Type Helpers:**
   * Emit standalone `serializeT` and `deserializeT` functions for every struct `T`. These serve as direct entry points for single-object codecs.
2. **Fixed-Length Struct Arrays (`T[N]`):**
   * **Do NOT unroll the loop** when $N \ge 4$.
   * Emit a compact `for (let i = 0; i < N; i++)` loop.
   * **Inline the field operations of `T` directly inside the loop body.**
3. **Deserialization Object Construction:**
   * Pre-allocate arrays: `const players = new Array(N);`.
   * Construct objects using single-pass object literals inside the loop to allow JIT shape initialization in a single IC allocation pass.

## Representative Generated Code Structure

```typescript
// Auto-generated GameTick Codec (Optimized Generator Pattern)

export function serializeGameTick(val: GameTick, view: DataView, offset: number): void {
    // Primitive fields
    view.setUint32(offset + 0, val.tick, true);
    view.setFloat32(offset + 4, val.dt, true);
    view.setUint8(offset + 8, val.flags);

    // Fixed array (N=8) -> Tight loop with INLINED field setters
    const players = val.players;
    const baseOffset = offset + 12;
    for (let i = 0; i < 8; i++) {
        const p = players[i];
        const po = baseOffset + i * 40; // Strided offset
        view.setUint32(po + 0, p.id, true);
        view.setFloat32(po + 4, p.pos[0], true);
        view.setFloat32(po + 8, p.pos[1], true);
        view.setFloat32(po + 12, p.pos[2], true);
        view.setFloat32(po + 16, p.vel[0], true);
        view.setFloat32(po + 20, p.vel[1], true);
        view.setFloat32(po + 24, p.vel[2], true);
        view.setUint16(po + 28, p.health, true);
        view.setUint32(po + 32, p.score, true);
        view.setUint8(po + 36, p.team);
    }
}

export function deserializeGameTick(view: DataView, offset: number, outObj?: any): any {
    if (!outObj) {
        const players = new Array(8); // Pre-allocated
        const baseOffset = offset + 12;
        for (let i = 0; i < 8; i++) {
            const po = baseOffset + i * 40;
            players[i] = {
                id: view.getUint32(po + 0, true),
                pos: [
                    view.getFloat32(po + 4, true),
                    view.getFloat32(po + 8, true),
                    view.getFloat32(po + 12, true),
                ],
                vel: [
                    view.getFloat32(po + 16, true),
                    view.getFloat32(po + 20, true),
                    view.getFloat32(po + 24, true),
                ],
                health: view.getUint16(po + 28, true),
                score: view.getUint32(po + 32, true),
                team: view.getUint8(po + 36),
            };
        }
        return {
            tick: view.getUint32(offset + 0, true),
            dt: view.getFloat32(offset + 4, true),
            flags: view.getUint8(offset + 8),
            players,
        };
    }

    // Secondary path for outObj reuse...
    outObj.tick = view.getUint32(offset + 0, true);
    outObj.dt = view.getFloat32(offset + 4, true);
    outObj.flags = view.getUint8(offset + 8);
    if (!outObj.players) outObj.players = new Array(8);
    const baseOffset = offset + 12;
    for (let i = 0; i < 8; i++) {
        const po = baseOffset + i * 40;
        let p = outObj.players[i];
        if (!p) p = outObj.players[i] = {};
        p.id = view.getUint32(po + 0, true);
        let pos = p.pos; if (!pos) pos = p.pos = [0, 0, 0];
        pos[0] = view.getFloat32(po + 4, true);
        pos[1] = view.getFloat32(po + 8, true);
        pos[2] = view.getFloat32(po + 12, true);
        let vel = p.vel; if (!vel) vel = p.vel = [0, 0, 0];
        vel[0] = view.getFloat32(po + 16, true);
        vel[1] = view.getFloat32(po + 20, true);
        vel[2] = view.getFloat32(po + 24, true);
        p.health = view.getUint16(po + 28, true);
        p.score = view.getUint32(po + 32, true);
        p.team = view.getUint8(po + 36);
    }
    return outObj;
}
```

---

# Section J: Recommended Follow-Up Benchmark Matrix

To refine the codec generator further, the following minimal test suite should be executed:

1. **Array Length Unrolling Threshold Sweep:**
   * Test array lengths $N \in \{2, 4, 8, 16, 32\}$ comparing `for` loop + inlined fields vs. fully unrolled code across V8 and JSC. Determine the exact $N$ where V8 penalizes unrolling.
2. **Nested Object Graph Depth Test:**
   * Compare flat struct inlining vs. 2-level and 3-level nested struct inlining to determine maximum inlining depth before code size degrades performance.
3. **Monomorphic vs. Polymorphic OutObj Mutation:**
   * Benchmark decode speedup when callers pass pre-allocated `outObj` instances with identical hidden classes versus omitted `outObj`.

---

# Final Verdict

**Best overall submission:** `model_6`

**Best performance evidence:** `model_4`

**Best reasoning / experimentation:** `model_6`

**Best generator architecture recommendations:** `model_6`

**Most useful unique idea:** `model_4` — Hybrid fixed-array handling using a `for` loop with inlined field-level `DataView` operations inside the loop body.

**Recommended basis for the real implementation:** The real generator should adopt the hybrid loop + inlined fields design code-shaped by `model_4` and `model_6`. It must eliminate IIFE wrappers, pre-allocate fixed arrays (`new Array(N)`), fold static offsets, and retain `for` loops over fixed-size struct arrays instead of unrolling them, directly incorporating the negative unrolling evidence established by `model_6`.

**Confidence in final recommendation:** High
---

# Section K: Implementation Status (2026-08-07)

Measured against the generator's own output, not hand-written variants:
`src/codec-baseline.ts` freezes what `tsCodec` emitted before this change, and
`src/gen-multi.ts` drops both through the `multi/` scaffolding so the same code
runs on every engine.

## Landed

All four "Implement Now" items, in `packages/exporter/src/exporters/tsCodec.ts`:

1. **Loop + inlined field access** — a fixed-array element that is a struct
   reference now has its fields inlined into the loop body (one level deep,
   independent of `inlineRefBytes`) instead of calling `deserializeT`.
2. **Pre-allocated arrays** — `new Array(N)` + indexed assignment, replacing
   `[]` + `.push`. The old code carried a comment claiming `new Array(N)` gets
   deoptimized as holey on V8; measured on node AND deno, it does not — decode
   is 15–19% faster there.
3. **IIFE elimination** — fixed-length array fields are read into a hoisted
   local before the object literal, so no closure is allocated per struct read.
4. **Static offset folding** — `offset + 12 + 4` → `offset + 16`,
   `offset + (2 * 4)` → `offset + 8`. Also, loops carry the element offset in an
   accumulator (`__o += 40`) instead of recomputing `o + i * stride`.

## Measured effect (base → opt, median of repeated runs)

| runtime          | encode           | decode           |
|------------------|------------------|------------------|
| node 24 (V8)     | 61.4 → 57.0 ns   | 382 → 311 ns     |
| deno 2.9 (V8)    | 68.9 → 62.5 ns   | 365 → 308 ns     |
| bun 1.3 (JSC)    | 114.5 → 78.5 ns  | 337 → 310 ns     |
| SpiderMonkey 140 | 260 → 196 ns     | 521 → 433 ns     |

Every runtime improves on both paths. Against `hand-DataView` in `run.ts` the
generated codec is now statistically indistinguishable on encode and decode
alike; before it was 1.2–1.4x behind.

**Caveat on single runs:** the first node measurement showed encode 11% SLOWER
for opt. Three repeats reversed it. Do not act on one mitata run — see below.

## Not done

- **Unrolling threshold sweep (N = 2, 4, 8, 16, 32)** — still open. The current
  generator keeps the existing `<= 16 && primitive item` literal-unroll rule for
  primitive arrays and always loops for struct arrays.
- Nested-depth and monomorphic-outObj matrices from Section J.

## Measurement infrastructure added

`src/ab.ts` (`bun run ab`) exists because per-run variance on this box was large
enough to flip conclusions. It differs from `run.ts` in ways that matter:

- **round-robin + rotation** — every round times every variant, starting slot
  rotates, so clock/GC drift hits all variants instead of biasing one;
- **paired ratios** — the headline number is the median of per-round
  `variant / baseline` quotients. Frequency scaling multiplies both terms and
  cancels; absolute medians swung 2x between runs while paired ratios held
  within ±5%;
- **long bursts** — default 50k iters/round. Decode allocates, so a burst must
  span many nursery GCs before the per-burst GC cost stops being a coin flip
  (±9% paired at 50k vs ±30% at 5k for identical code);
- **`--processes N`** pools rounds from fresh processes, since code layout and
  JIT decisions are fixed per process;
- **`--variants A,B`** narrows to a direct two-way A/B.

Known environment problem: this machine runs plasma, VS Code, sunshine and krfb,
with the `schedutil` governor. Absolute numbers here are not comparable across
sessions; only paired ratios are. `taskset` alone did not help.
