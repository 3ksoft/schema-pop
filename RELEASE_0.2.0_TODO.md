# v0.2.0 release — pozostałe TODO

Stan: testy częściowo zielone po wycince migracji + adaptacji do nowego analyzer API.

**Bieżące liczby (po Phase 1-3 + częściowej Fazie 5):**
- Pass: 87
- Fail: 90
- Skip: 4
- Errors: 4
- Total: 181 / 32 files

---

## Fazy projektu

- [x] **Faza 1** — wycięcie emitterów migracji (c/cpp/zig/html/jsonSchema, html.diffStatus, exportMigration API)
- [x] **Faza 2** — `core/package.json` `!src/engine` (engine/ committed, excluded from npm)
- [x] **Faza 3** — infra: `tests/package.json`, `scripts/publish.sh`, `.github/workflows/ci.yml`
- [x] **Faza 4** — bump wszystkich publishable do `0.2.0`
- [ ] **Faza 5** — restore green tests *(in progress, this doc)*
- [ ] **Faza 6** — README experimental section + `cli/README.md`
- [ ] **Faza 7** — squash 24 commitów na czystą historię release'u
- [ ] **Faza 8** — manualny publish + git push + tag + GitHub release

---

## Faza 5 — pozostałe kategorie błędów

### A. Stare snapshoty i fixture po refaktorze analyzera (22 fails)

Refaktor `engine/SchemaAnalyzer.ts` → `layout/analyzer.ts` zmienił:
- konstruktor: `new SchemaAnalyzer(schema, opts)` → `new SchemaAnalyzer()`
- analyze: `analyze(version, endian)` → `analyze(schema, settings)`
- pole config: `layoutType` → `layout`
- pole `wordSize`: `64` (number) → `"64"` (string literal)
- `version` musi być SemVer `^\d+\.\d+\.\d+$` (a nie `"v1"` / `"1.0"`)

**Status migracji testów:**
- [x] `exporter/utils.ts` — helper przerobiony, semver normalizacja
- [x] `core/migration-meta.test.ts` — 2/5 pass, **3 fails** (kat. B)
- [x] `core/analyzer.test.ts` — **4 fails** — `TraversalError: "label" in data` na `fromModule($)` z `vault/analyzer-test.1.pop.ts`
- [x] `core/inference.test.ts` — API zmienione, status TBD
- [x] `core/layout-io.test.ts` — API zmienione, status TBD
- [x] `core/_baseline.test.ts` — API zmienione, **18 fails** — snapshoty w `core/__baseline__/*.json` przeterminowane

**Do zrobienia:**
1. Sprawdzić czy `vault/analyzer-test.1.pop.ts` używa schema fields które już nie istnieją (`label`?)
2. `BASELINE_UPDATE=1 bun test core/_baseline.test.ts` — regeneracja snapshotów (po naprawie A1)
3. Diff snapshotów ręcznie — sanity check że nowy analyzer nie zepsuł semantyki

**Estimate:** 30-60 min

---

### B. Regressje w analyzerze (3 fails — `core/migration-meta.test.ts`)

Realne błędy semantyczne w `layout/analyzer.ts`:

1. **`ArkType default → field.migrationMeta.defaultValue`** — pole z `"u16 = 1"` nie dostaje `migrationMeta.defaultValue: 1`
2. **`Renamed + default compose`** — `"Renamed<u16, 'old_v'> = 7"` traci `defaultValue` (ma tylko `renamedFrom`)
3. **`default-bearing field NOT wrapped in optional`** — pole z defaultem analizowane jako `optional` zamiast `primitive`

Root cause prawdopodobnie w `core/src/arktype/fromArktype.ts` — branch ekstrakcji defaultów nie wstrzykuje meta, lub ekstrakcja optional dla pól z defaultem.

**Estimate:** 1-2h

---

### C. Regressje w eksporterach (9 fails)

Pojedyncze testy gdzie output już nie matchuje expected:

| Exporter | Test | Skala |
|---|---|---|
| `rust` | `SharedString/SharedVec impls > file header includes alloc-gated From impls` | brakuje `#[cfg(feature = "alloc")]` gate |
| `rust` | `versionNamespace` (3) | wrap version → `pub mod` nie działa zgodnie z testem |
| `go` | `versionNamespace prefix` (1) | prefix slug |
| `go` | `getHarness` (2) | wieloplikowy emit harness |
| `md` | `functions section when plan.functions populated` (1) | sekcja functions |
| `jsonSchema` | `idBase emits $id; pretty:false produces single-line JSON` (1) | $id + minify |

Każdy do indywidualnej diagnozy. Brak wspólnego root cause.

**Estimate:** 1-2h (najprostsze najpierw)

---

### D. Importer — WASM ABI mismatch (~50 fails)

`web-tree-sitter@0.26.8` rzuca `Error` w `getDylinkMetadata` przy `Language.load(wasmPath)`.

**Działające języki:** `c`, `cpp` (5/6), `rust`, `typescript`
**Niedziałające (`failIf` w dylink):** `python`, `java`, `go`, `kotlin`, `swift`, `dart`, `scala`, `elixir`, `php`, `objc`, `c#`

Wszystkie wasmy mają tekst `"dylink"` w nagłówku, więc to nie absencja — to wersja formatu. Część wasmów (c/cpp/rust/typescript) zbudowana z nowszą ABI tree-sittera, reszta z odpowiednio starszą.

**Opcje:**
1. **Przebudować** wasmy via `packages/importer/scripts/build-wasm.sh` (sprawdzić co tam jest)
2. **Downgrade** `web-tree-sitter` do wersji kompatybilnej z aktualnymi wasmami
3. **Wyciąć** niedziałające języki z listy `Lang` + `IMPORTER_REGISTRY` na 0.2.0, dodać w 0.2.1

Drobne błędy (poza wasm):
- `c importer > fixed array field` (1) — semantyczna regresja walkera C
- `cpp importer > template struct silently skipped` (1) — semantyczna regresja walkera C++

**Estimate:**
- Opcja 1: 1-3h zależnie od dostępności grammar repos i toolchainu
- Opcja 2: 30 min - 1h (testowanie kompatybilności)
- Opcja 3: 30 min — najszybsza, najczystsza dla 0.2.0

---

### E. Integration test (1 fail)

`create-schema-pop Integration > should scaffold project via bunx from local registry` — wymaga verdaccio + lokalnej publikacji.

**Estimate:** 30-60 min (jeśli verdaccio config wymaga aktualizacji ścieżek paczek)

---

## Łączne oszacowanie do "green for 0.2.0"

| Kategoria | Estimate | Priorytet |
|---|---|---|
| A. Stare snapshoty / fixtures | 30-60 min | Wysoki (zaślepia A6 sygnał) |
| B. Analyzer regressje | 1-2h | Wysoki (realny bug w shippowanym kodzie) |
| C. Exporter regressje | 1-2h | Średni (część to małe rzeczy) |
| D. Importer WASM | 30 min - 3h | Niski (opcja: skip 11 języków w 0.2.0) |
| E. Verdaccio integration | 30-60 min | Niski (można odpalać manualnie) |

**Reasonable budget:** 4-8h focused work do realnie greenu.
**Minimalny scope dla 0.2.0:** A + B + 2-3 najprostsze z C + skip D dla 11 języków → ~2-3h.

---

## Decyzje do podjęcia

1. **Importer:** rebuild wasms vs skip-and-document w 0.2.0?
2. **Snapshot baseline:** regenerujemy ślepo czy review per-fixture?
3. **Verdaccio:** wymagany na CI czy tylko manualne smoke?
