# schema-pop — issues found while integrating into `salina`

Konfiguracja generowania: `src/schema/cli.ts` (woła `tsExports`, `tsCodec`,
`wgsl`, `gpuBindingsTs`, `gpuBindingsWgsl`). Schemy wejściowe:
`src/schema/gpu.ts` (`scope` → moduł `gpu`) i `src/schema/api.ts`
(scope → moduł `api`).

---

## 1. Field order is alphabetical, not declaration order (CRITICAL)

**Objaw.** Co byśmy nie zadeklarowali w `scope({...})`, generowany WGSL
i Codec emituje pola w kolejności alfabetycznej.

Przykład — schema:
```ts
Constraint: { 
    idxA: "i32", idxB: "i32", idxC: "i32",
    cType_color: "u32",
    restValue: "f32", compliance: "f32",
    extra: "vec2f", lambda: "f32",
    breakThreshold: "f32",
    
},
```

Wygenerowany `structs.wgsl`:
```wgsl
struct Constraint {
    extra: vec2<f32>,
    breakThreshold: f32,
    cType_color: u32,
    compliance: f32,
    idxA: i32,
    idxB: i32,
    idxC: i32,
    lambda: f32,
    restValue: f32,
};
```

**Dlaczego boli.**
- W std430 kolejność deklaracji determinuje pakowanie (vec2f + f32 + f32
  zachowuje się inaczej niż vec2f + vec2f). Autor schemy nie ma kontroli
  nad rozmiarem struktury.
- Codec.ts i WGSL zgadzają się ze sobą (oba alfabetycznie), więc *runtime
  nie wybucha od razu* — ale ręcznie napisany kod (np. `removeConstraintColor`
  z hard-coded offsetami `+ 20`/`+ 24`/`+ 28` dla `idxA/B/C`) i wszelkie
  starsze offsety od razu się rozjeżdżają po każdej drobnej zmianie nazw pól.
- Czytelność: deweloper widzi w `gpu.ts` jeden układ, w `structs.wgsl` /
  `gpu.md` zupełnie inny. Mental model się rozjeżdża.

**Czego chcemy.** Generator zachowuje kolejność wpisów z `scope({...})`.
Idealnie — auto-layout (`autoLayout: true`) działa tak: kolejność = jak
zadeklarowano, padding wstawiany tylko żeby spełnić reguły std430. Jeśli
ktoś chce optymalizować upakowanie, robi to ręcznie zmieniając kolejność
w schemie.

---

## 2. Enum value mapping is alphabetical (CRITICAL)

**Objaw.**
```ts
ConstraintType: "'distance' | 'bending' | 'area' | 'anchor'",
MaterialType:   "'water' | 'methane' | 'co' | 'steam' | 'oxygen' | 'nitrogen' | 'oil' | 'mud'",
```

Wygenerowane WGSL stałe (`structs.wgsl`):
```wgsl
const ConstraintType_anchor:   ConstraintType = 0u;
const ConstraintType_area:     ConstraintType = 1u;
const ConstraintType_bending:  ConstraintType = 2u;
const ConstraintType_distance: ConstraintType = 3u;

const MaterialType_co:       MaterialType = 0u;
const MaterialType_methane:  MaterialType = 1u;
const MaterialType_mud:      MaterialType = 2u;
const MaterialType_nitrogen: MaterialType = 3u;
const MaterialType_oil:      MaterialType = 4u;
const MaterialType_oxygen:   MaterialType = 5u;
const MaterialType_steam:    MaterialType = 6u;
const MaterialType_water:    MaterialType = 7u;
```

**Dlaczego boli.**
- Kolejność wariantów w unii w schemie jest semantyczna (distance=0 to
  pierwszy w kolejności, anchor=3 to ostatni). Alfabetyczne mieszanie
  zmienia to bez ostrzeżenia.
- Każda zmiana nazwy materiału (np. dodanie `'air'`) przesuwa indeksy
  WSZYSTKICH innych materiałów, bo `air` wlatuje na pozycję 0.
- Shader (`mpm.wgsl`) ma zaszyte zera/jedynki: `if (pt.material == 0u) ...`
  zakłada konkretne mapowanie. Po regenerze ten kod testuje wartość, której
  semantyka się zmieniła — *bez żadnego błędu kompilacji*.
- `Codec.ts` serializuje string → u32 też alfabetycznie (`if val==='co' setUint8(0)`),
  więc Codec ↔ WGSL są zgodne, ale autor schemy nie ma kontroli nad tym
  jakie surowe `u32` reprezentuje który wariant.

**Czego chcemy.** Wartości enuma wynikają z kolejności w unii (`'distance' | 'bending' | 'area' | 'anchor'` → `distance=0, bending=1, area=2, anchor=3`).
Opcjonalnie: API żeby przypisać jawnie (`'distance=0' | 'bending=1' | ...`).

---

## 3. `gpuBindingsTs` generates `type: "storage"` not `as const` (TS error)

**Objaw.**
```ts
// GpuBindings.ts (auto-generated)
export const PHYSICS_PIPELINE_BINDINGS: Record<string, GPUBindGroupLayoutEntry[]> = {
    group0: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        // ...
    ],
};
```

`buffer.type` zostaje rozszerzony do `string`, a `GPUBufferBindingType` to
literal union (`"uniform" | "storage" | "read-only-storage"`), więc
`createBindGroupLayout({ entries: ... })` wybucha pod tsc:

```
The types of 'buffer.type' are incompatible between these types.
  Type 'string' is not assignable to type 'GPUBufferBindingType | undefined'.
```

Obecnie obchodzimy to `as any` w `PhysicsBase.ts:111`. Nie jest to bug runtime'u,
ale traci nam się typing safety.

**Czego chcemy.** Albo `type: "storage" as const`, albo emisja jako
`satisfies GPUBindGroupLayoutEntry[]`, albo bezpośrednio `buffer: { type:
"storage" } satisfies GPUBufferBindingLayout`. Cokolwiek co zachowa literal
type.

---

## 4. `cli.ts` `planApi` używa złego modułu (bug w naszym cli, ale godny uwagi)

W `src/schema/cli.ts`:
```ts
const pop = fromModule(gpu, { mode: "binary" });
const popApi = fromModule(api, { mode: "rich" });

const planApi = analyzer.analyze(pop, { schemaName: "api" });  // ← pop, nie popApi
```

To `bug` po naszej stronie (analyzer dostaje `pop` zamiast `popApi`), ale
warto żeby analyzer dał czytelny błąd albo żeby `fromModule` zwracał coś
jednoznacznego do podania w `analyze` — teraz typy są na tyle wąskie że nie
wyłapują pomyłki.

Z naszej strony — apiContent dalej używa `tsExports(...).generate(plan)`
(`plan` = gpu, nie planApi), więc `Api.ts` faktycznie dubluje exporty z
`Schema.ts`. Plan jest taki, że `Api.ts` to top-level re-export user-facing
schemy (gpu structs + walidatory ze `schema/api.ts`). Tu może by się przydała
opcja jak "tsExports z dwóch planów połączone w jeden file".

---

## 5. Nie ma `pack_*` symetrii do `unpack_*` (nice to have)

`ParticleFlags` pakuje 8 bitów w `_bitfield_0: u32`. Generator emituje:

```wgsl
fn unpack_particle_flags(packed: ParticleFlags) -> ParticleFlagsUnpacked { ... }
```

ale brak odwrotnej funkcji `pack_particle_flags(unpacked) -> ParticleFlags`.
Jak shader chce zmodyfikować flagi (np. ustawić `isStatic` na podstawie
kolizji), musi ręcznie składać bity. Codec.ts po stronie TS robi `serialize`
od pojedynczych pól, więc tam jest ok — boli tylko WGSL.

---

## 6. `cType_color` to ręcznie pakowany u32 — schema nie pomaga

Pole `cType_color: "u32"` to faktycznie:
```
bits [31:16] — color (16 bit)
bits [8]     — boundary flag
bits [7:0]   — cType (enum, 0-4)
```

W obecnej wersji schemy nie ma sposobu by to opisać. `ParticleFlags`
pokazuje, że schema-pop UMIE pakować bity (`u1`, `u5` itp.). Mogłoby się
to rozszerzyć na nazwane bitfieldy ponad jeden bajt — `cType_color: { cType:
"u8", boundary: "u1", _pad: "u7", color: "u16" }` byłoby genialne, bo:

- generator daje `unpack/pack_cType_color()` na GPU
- Codec po stronie TS akceptuje obiekt `{cType, boundary, color}` zamiast surowego u32
- Physics.ts wywala `(color << 16) | cType` na rzecz `{cType: 0, boundary: 1, color: this.assignColor(...)}`

Ten use-case (mieszany "trochę enum, trochę uint, trochę bit-flag") jest
częsty w GPU strukturach.

---

## 7. `MpmGridNode` z atomicami — działa, drobny szczegół

Działa poprawnie:
- WGSL: `atomic<u32>` per pole, dzięki `ca("u32")`.
- Codec.ts: czyta/pisze jako zwykłe u32.

Drobiazg ergonomiczny: w schemie zapisuje się to jako `mass: ca("u32")`,
gdzie `ca = (typeName) => t(typeName).configure({ atomic: true })`. Mógłby
być cukier `atomic("u32")` na poziomie schema-pop, ale to drobiazg.

---

## 8. Padding na końcu uniformów: jakie znaczenie ma `_pad_X`?

`SimulationState` kończy się:
```wgsl
phase: u32,
_pad_phase: array<u32, 2>,
```

Czyli generator nazywa padding tail po polu które go poprzedza. To OK, byle
SIZEOF_* w Codec się zgadzał i alokacja bufora była robiona z tym samym
`SIZEOF_SimulationState`. Nazwa `_pad_phase` jest myląca — sugeruje pad
*dla* `phase`, a to pad strukturalny do 16-byte align dla uniformu. Drobiazg
nazewniczy — może `_pad_tail` byłoby jaśniejsze.

---

## 9. Dwa pomysły co jeszcze schema-pop mógłby wyeksportować

### 9a. Discriminated union dispatch (walidatory)

W `src/schema/api.ts` mamy:
```ts
ConstraintSpawn: "DistanceConstraintSpawn | BendingConstraintSpawn | AreaConstraintSpawn | AnchorConstraintSpawn",
```

`Physics.spawnConstraint(s)` robi `switch (v.type)` i mapuje pola każdego
wariantu na pola GPU struct. Każdy wariant ma inny zestaw pól, ale wszystkie
serializują się do tej samej struktury `Constraint`. Schema-pop mógłby:
- wygenerować dispatcher `serializeConstraintSpawn(union, view, offset)` który
  sam routuje po `type`,
- albo eksportować mapping `cType` per wariant (jeśli wariant ma metadane).

Możliwie out-of-scope, ale to byłoby silne narzędzie.

### 9b. SIZEOF + offset constants też do WGSL

`Codec.ts` eksportuje `SIZEOF_Constraint`, `SIZEOF_Particle` etc. W WGSL też
czasem przydaje się znać rozmiar (np. dispatch count). Mogłoby się eksportować
do osobnego `sizes.wgsl` / `offsets.wgsl`.

---

## 10. Pełen obraz lokalnych zniszczeń po regenerze (FYI dla nas, nie schema-pop)

Po włączeniu `gpuBindingsWgsl` w `cli.ts` i odpaleniu `bun run generate`,
nasz shader code (`mpm.wgsl`, `render.wgsl`) ma trzy klasy bugów wynikające
z punktów 1 i 2 powyżej:

1. **Pole zmieniło nazwę** — schemat: `material: "MaterialType"` (kiedyś
   `type_mat: "u32"`). Shadery dalej używają `pt.type_mat` w 12 miejscach
   (`mpm.wgsl`) i 1 (`render.wgsl`). Trzeba przemianować po regenerze.

2. **Indeksy materiałów są pomieszane** — `mpm.wgsl` ma zaszyte:
   ```
   pt.type_mat == 0u  → kiedyś water, teraz co
   pt.type_mat == 1u  → metan (oba)
   pt.type_mat == 3u  → kiedyś steam, teraz nitrogen
   pt.type_mat == 6u  → kiedyś oil, teraz steam
   ```
   Wszystkie te porównania trzeba przepisać na stałe z `structs.wgsl`
   (`MaterialType_water`, `MaterialType_steam` itp.) — wtedy regenery nie
   będą cicho psuły logiki.

3. **`ConstraintType` enum** — `Physics.ts spawnConstraint` koduje
   `distance=0, bending=1, area=2, anchor=3` (manual). Generator gada
   `anchor=0, area=1, bending=2, distance=3`. Field `cType_color` to surowy
   u32 (nie enum), więc to nie wybucha dziś — ale jeśli kiedykolwiek
   wepniemy enum jako typ pola, się rozjedzie. Po fixie punktu 2 to zniknie.

Wniosek: zanim schema-pop nie przestanie sortować alfabetycznie, każde
dodanie/zmiana nazwy materiału lub typu constraintu psuje shader bez
ostrzeżenia ze strony kompilatora.

---

## Priorytety od mojej strony

1. **#1 Field order**  — bez tego nie da się w schemie kontrolować std430
   layoutu, każdy regen ryzykuje rozjazd offsetów w manualnie napisanym
   kodzie.
2. **#2 Enum value mapping** — bez tego materiały/typy constraintów
   przeskakują indeksy przy najmniejszej zmianie.
3. **#3 `as const` w gpuBindingsTs** — łatwy fix, robi nam ładny typecheck.
4. (po fixach #1 i #2) regen po naszej stronie + przepisanie shaderów
   żeby używały stałych zamiast literałów.

#5–9 to nice-to-haves.
