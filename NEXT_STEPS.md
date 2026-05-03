# Next steps — kill emit.ts, importer outputs LayoutPlan directly

## The problem

The importer pipeline has a useless intermediate. Today:

```
.h/.cpp/.rs  ──walk──▶  SchemaPopIR  ──emit.ts──▶  arktype scope (TS string)
                                                          │
                                                  jiti import + arktype parse
                                                          ▼
                                                  arktype scope object
                                                          │
                                                  SchemaAnalyzer
                                                          ▼
                                                  LayoutPlan ──▶  exporters
```

`emit.ts` is **structured IR → string → re-parse**. It's the source of every
"Expected an expression" / "#bool duplicates public alias bool" bug we
saw in the ESP-IDF corpus run (21 + 6 = 27 broken outputs out of 10317).
Two-direction translation that loses info on the way down and reconstructs
it on the way up. For hand-authored schemas the arktype scope is the
canonical artifact and that round-trip is fine. For **machine-imported**
data going through arktype is pure overhead.

The clang importer already has full layout info (`-fdump-record-layouts`)
and currently throws it away to re-derive it via the analyzer.

## The pipeline we want

```
.h/.cpp/.rs  ──walk──▶  SchemaPopIR  ──computeLayoutPlan──▶  LayoutPlan (JSON)
                                                                   │
                                                ┌──────────────────┼──────────────┐
                                                ▼                  ▼              ▼
                                              rust               ts             md / ...
```

`emit.ts` deleted. `.pop.ts` no longer the importer's output — it stays
the **authoring** format only. The importer writes `.layout.json`. CLI
detects extension and routes accordingly:

- `.pop.ts` → jiti → arktype scope → analyzer → LayoutPlan → exporters
- `.layout.json` → read → LayoutPlan → exporters

## Migration plan

### Phase 1 — type rename (DONE ✓)

`RustModuleIR / RustItem / RustField / RustType / RustPrimitive /
RustEnumVariant / RustFnArg` → `SchemaPopIR / IRItem / IRField / IRType
/ IRPrimitive / IREnumVariant / IRFnArg`. No back-compat aliases — we're
pre-1.0 and the old names were inherited from the Rust-only era. Tests
pass on every workspace package. This is groundwork; it doesn't change
behavior, just clears the naming so the next phases read cleanly.

### Phase 2 — extract `computeLayoutPlan` from `SchemaAnalyzer`

`SchemaAnalyzer` currently consumes arktype scope and produces
`LayoutPlan`. Internally it walks the scope's exports and builds the IR
on the fly, then computes offsets / sizes / paddings.

Split it into two stages:

```ts
// arktype scope → IR (the existing internal walker)
export function arktypeScopeToIR(scope: Scope, opts: ScopeReadOpts): SchemaPopIR;

// IR → LayoutPlan (the offset / size / padding pass)
export function computeLayoutPlan(ir: SchemaPopIR, opts: LayoutOpts): LayoutPlan;

// SchemaAnalyzer becomes a thin wrapper for the existing public API
class SchemaAnalyzer {
    analyze(version, endian) {
        const ir = arktypeScopeToIR(this.scope, this.opts);
        return computeLayoutPlan(ir, { version, endian, ...this.opts });
    }
}
```

Both stages need tests. The split should be invariant — same inputs, same
`LayoutPlan` byte-for-byte. **This is the load-bearing piece**; if the
split is wrong every downstream consumer breaks. Spend the time on it.

### Phase 3 — clang importer feeds layout info directly

Today the clang walker discards the `-fdump-record-layouts` output and
emits abstract IR (`{ kind: "primitive", name: "u32" }` etc.). It should
attach the offsets / sizes / paddings as metadata on each `IRField` so
`computeLayoutPlan` can pass them through verbatim instead of re-deriving.

Add an optional layout sidecar field on `IRField`:

```ts
export type IRField = {
    name: string;
    type: IRType;
    doc?: string;
    pub: boolean;
    /**
     * When the importer already knows where the field sits (e.g. clang
     * `-fdump-record-layouts`), the layout pass uses these instead of
     * re-computing from the strategy. Tree-sitter walks leave it
     * undefined and the layout pass derives offsets from scratch.
     */
    layout?: { offset: number; size: number; align: number; paddingAfter?: number };
};
```

`computeLayoutPlan` honors `field.layout` when present, computes
otherwise.

### Phase 4 — `LayoutPlan` JSON write + read

Already a typed shape (`core/src/schema/layout.ts`). Add:

```ts
// core/src/layout-io.ts (new)
export function writeLayoutPlan(plan: LayoutPlan, dest: string): Promise<void>;
export function readLayoutPlan(src: string): Promise<LayoutPlan>;
```

JSON shape = `LayoutPlan` directly serialized. Add `$schemaVersion: "1"`
at the root for future-proof migration.

### Phase 5 — CLI dual-input

`schema-pop emit <input> -t <type> -o <out>` learns to handle both:

- input ends in `.pop.ts` / `.tsx` → existing path (jiti, arktype, analyzer)
- input ends in `.layout.json` → `readLayoutPlan` → exporters directly

Same for batch mode (`schema-pop emit gen/*.layout.json -t md -o docs/`).
Also `schema-pop` build flow can accept either as a schema source — when
the file is `.layout.json` it skips analyzer entirely.

### Phase 6 — importer outputs `.layout.json`

`schema-pop-import` flips its default output:

- `-o foo.ts` (current): emit arktype scope source — keep for round-trip
  / hand-edit workflows
- `-o foo.layout.json` (new): emit LayoutPlan JSON, no arktype roundtrip
- batch dir mode: pick `.layout.json` per file unless user says
  otherwise

The corpus harness switches to `.layout.json` mode → all 27 emit-time
bugs go away as a side effect (we never round-trip through the broken
emit.ts).

### Phase 7 — delete `emit.ts`

Once nothing produces `.pop.ts` from imports, `emit.ts` is dead code.
Delete it. Tree-sitter walker stays for the **TypeScript schema** ingest
path (`-l typescript`) which is its own concern — that one consumes a
hand-written TS file with arktype-style types and emits IR; it never
needed emit.ts anyway.

## Open questions (to answer before coding)

1. **Should `LayoutPlan.json` be the authoritative artifact in build outputs?**
   Right now exporters write `.rs` / `.ts` / `.h` directly to disk. If
   we add a `.layout.json` sidecar next to them, downstream tooling can
   diff layouts across versions / detect breakage without re-running
   the importer. Probably yes, but adds one more file per schema.

2. **What about hand-edited `.pop.ts` projects?** They keep working —
   the arktype-scope path stays for the authoring case. Phases 5-7 only
   add the JSON path; they don't remove the TS path.

3. **Tree-sitter walks vs clang.** Tree-sitter walks (rust / c / cpp /
   ts) have NO layout info from the parser. They need `computeLayoutPlan`
   with `autoLayout: true` to derive offsets. That's the same logic
   `SchemaAnalyzer` runs today — the Phase 2 split is what makes both
   paths share it.

4. **What does the `corpus-run.ts` regression test do once emit.ts is
   gone?** Diff `outDir/*.layout.json` directly. The "import →
   re-import via TS walker" trick was a workaround for round-tripping
   through .pop.ts. With JSON we can hash + structurally diff layouts
   directly, no walker needed.

## Risk register

- **Phase 2 split is invariant-critical.** Any divergence between
  pre-split and post-split LayoutPlan output breaks every exporter
  silently. Need byte-equal regression test on the existing test
  fixtures before merging the split.

- **Tree-sitter walker semantics.** The TS walker (walk-ts.ts) parses
  hand-written TypeScript types. It already produces IR. With Phase 2
  it can feed straight into `computeLayoutPlan` and skip emit.ts. But
  there might be subtle differences in how the analyzer normalizes
  arktype `scope` exports vs raw IR — needs an audit pass.

- **Public API surface.** `SchemaAnalyzer` is exported. The split keeps
  the class as a wrapper, so the public API doesn't change. Phase 5/6
  add new APIs (`readLayoutPlan`, layout-json input mode), don't remove
  any.

- **Clang dump format stability.** Phase 3 depends on parsing
  `-fdump-record-layouts` output. We already do (P16). Format is stable
  enough across clang versions that we haven't seen breaks, but a
  future clang revision could rearrange fields. Cover with a snapshot
  test.

## What's done as of this writing

- ✓ Type rename (`RustModuleIR → SchemaPopIR` etc.)
- ✓ Hard rename, no back-compat aliases (we're pre-1.0)
- ✓ Tests green across all workspace packages

## What to start with

Phase 2. Until `computeLayoutPlan` exists as a standalone function over
`SchemaPopIR`, none of the other phases can land — both clang import
and the JSON CLI path need it. Everything else is plumbing once the
split is in.
