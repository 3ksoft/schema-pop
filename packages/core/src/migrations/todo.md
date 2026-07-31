### Blokery

**1. Zmiana `non-struct → struct` omija wymagany hook**

`diffMatchedTypes()` poprawnie oznacza zmianę rodzaju jako `user-supplied`, ale resolver patrzy wyłącznie na `td.to.kind`. Gdy typ docelowy jest strukturą, wchodzi w automatyczną migrację pól, nawet jeśli źródłem był alias, enum albo union.

Przykład `alias S = u32 → struct S { x: u32 }` dał mi plan:

```ts
{
  kind: "fields",
  ops: [{ kind: "copy", to: "x", from: "x" }]
}
```

czyli generator później wyemituje `x: v1.x`, mimo że `v1` jest liczbą. Tu przed ścieżką struktury potrzebny jest warunek:

```ts
if (td.from.kind !== td.to.kind) {
  requireWholeTypeHook();
}
```

albo osobny rodzaj diffu `kind-changed`, którego resolver nie może przypadkiem potraktować jak zwykłego `changed struct`.  

---

**2. `reordered` może nadpisać `type-narrowed` albo `type-changed`**

`diffStructFields()` może wygenerować dla jednego pola dwa wpisy, na przykład:

```ts
type-narrowed(a)
reordered(a)
```

Następnie `fieldChangesByToName()` wkłada je do `Map<string, FieldChange>`. Ponieważ `reordered` jest dodawany później, nadpisuje narrowing.

Potwierdzony przypadek:

```ts
// v1
{ a: u32, b: u32 }

// v2
{ b: u32, a: u8 }
```

Resolver nie zgłasza brakującego hooka i generuje zwykłe:

```ts
{ a: v1.a }
```

Najprościej w ogóle nie przekazywać `reordered` do resolvera — na poziomie transformacji obiektowej kolejność pól nie wymaga żadnej operacji. Alternatywnie mapa musiałaby przechowywać tablicę zmian albo mieć priorytet `type-changed > narrowed > renamed > widened > reordered`.  

---

**3. Zmiany payloadu istniejącego wariantu union są niewidoczne**

`diffUnionVariants()` porównuje wyłącznie nazwy wariantów oraz `renamedFrom`. Nie porównuje:

* `variant.type`,
* `discriminant`,
* `discriminantValue`,
* tagów, jeśli mają znaczenie dla reprezentacji obiektowej.

Przykład:

```ts
U = A<u8>  →  U = A<u32>
```

został sklasyfikowany jako `unchanged`, a resolver utworzył `identity`.

Dodatkowo `computeDirty()` propaguje zmiany tylko przez struktury. Nie przechodzi przez aliasy ani payloady unionów. Zatem także:

```ts
Child zmieniony
Alias = Child
Parent { value: Alias }
```

może zakończyć się `identity` dla `Alias` i `Parent`.

Potrzebny jest ogólny graf zależności dla każdego `TypePlan`:

* struct → pola,
* alias → `type`,
* union → typy wariantów,
* wrappers → array/optional/inline/map.

Dopiero po takim fixpoincie można wiarygodnie ustalać `dirty`.  

---

**4. Ograniczenia stringów są porównywane błędnie**

Dla stringa porównywane jest tylko `maxLength`. `exactLength` jest całkowicie pomijane.

Potwierdzony przypadek:

```ts
string exactLength 4 → exactLength 8
```

został uznany za `unchanged`.

Podobne problemy dotyczą tablic:

* stała tablica `u8[4] → u16[4]` jest uznawana za narrowing zamiast widening,
* `maxLength: 10 → brak limitu` wychodzi jako narrowing, choć jest wideningiem,
* exact i max powinny być analizowane wspólnie, a nie jako niezależne opcjonalne liczby.

Dobrze byłoby najpierw normalizować constraints do modelu:

```ts
{ minLength, maxLength, exact }
```

i dopiero porównywać zakres akceptowanych wartości. 

---

**5. „Language default” nie zawsze jest poprawną wartością schemy**

Każdy nowy string i każda nowa tablica bez jawnego defaultu są klasyfikowane jako `auto`. Emitter generuje odpowiednio `""` oraz `[]`.

To jest niepoprawne dla:

```ts
name: string exactLength 8
samples: u32[4]
```

Wygenerowane wartości nie spełniają v2 już w chwili utworzenia.

Bezpieczna zasada:

* string bez `exactLength` → `""`,
* dynamiczna tablica → `[]`,
* exact string/array o długości większej od zera → jawny default albo hook,
* ewentualnie tablicę można wypełniać rekurencyjnym zerem, ale to już świadoma semantyka, nie zwykły language default.

To jest bezpośrednio sprzeczne z hard-error stance opisanym w planie.  

### Ważne problemy

**6. Rename typów nie jest uwzględniany w referencjach**

Gdy `Old` zostaje przemianowany na `New`, pole:

```ts
child: Old → child: New
```

jest klasyfikowane jako strukturalna zmiana referencji i wymaga hooka. Resolver powinien znać mapę:

```ts
Old -> New
```

i traktować taką referencję jako zgodną oraz generować `transformNew(v1.child)`.

Czysty rename enuma, unionu albo aliasu również nie przechodzi automatycznie: `computeDirty()` uznaje każdy `renamed` za dirty, po czym resolver wymaga whole-type hooka dla każdego non-structa. Potwierdzony czysty rename enuma z identycznymi wariantami zakończył się błędem resolvera, mimo że `PlanDiff.status` wynosił `"auto"`.

Brakuje też kontroli jednoznaczności. Obecnie jedno pole lub typ źródłowy może zostać równocześnie:

* zachowany pod starą nazwą,
* użyty jako źródło `renamedFrom` dla nowego elementu.

Generator potraktuje to jak legalne kopiowanie jednego źródła do dwóch celów. Semantycznie `Renamed` powinien raczej wymuszać parowanie jeden-do-jednego.  

---

**7. Emitter może wygenerować jawnie uszkodzony kod hooków**

Jeżeli `MigrationPlan` używa hooków, ale `hooksImport` nie został podany, powstaje:

```ts
return (null!.S as (v1: any) => any)(v1);
```

Emitter powinien od razu rzucić:

```ts
if (plan.hookedTypes.length && !config.hooksImport) {
  throw new Error(...)
}
```

Dodatkowo nazwy pól są emitowane bez escaping:

```ts
foo-bar: v1.old-name
```

ArkType pozwala na klucze niebędące identyfikatorami, więc wszędzie powinien być wspólny helper:

```ts
const access = (base: string, key: string) =>
  isIdentifier(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
```

Analogicznie hook registry powinien używać `migrationHooks["Type"]["field"]`, a klucze obiektu powinny być cytowane. 

---

**8. `JSON.stringify()` nie jest serializerem literałów TypeScript**

`defaultLiteral` jest emitowany przez `JSON.stringify()`. Potwierdzony `1n` kończy się wyjątkiem:

```text
TypeError: Do not know how to serialize a BigInt
```

Problematyczne są także:

* `NaN` i `Infinity` → `null`,
* `undefined`,
* obiekty niestandardowe,
* potencjalnie `-0`.

Tu potrzebny jest mały, jawny `emitTsLiteral()`, który albo obsłuży dozwolony zestaw wartości, albo odmówi generowania i zażąda hooka. 

---

**9. Widening został zgubiony w IR**

Plan architektoniczny mówi o osobnej operacji `widen`, ale bieżący `FieldOp` redukuje widening do zwykłego `copy`. 

To działa dla `u8 → u16`, jeśli oba są w TS reprezentowane jako `number`, ale przestaje być neutralne językowo. W szczególności `u32 → u64` może wymagać `BigInt(v1.x)`, a przyszły emitter Rust/C również potrzebuje jawnej konwersji.

IR powinien zachować informację:

```ts
{
  kind: "convertPrimitive",
  from: "u32",
  to: "u64",
  source: "field"
}
```

zamiast zakładać, że widening zawsze jest identycznością wartości na poziomie języka.

### Mniejsze rzeczy

* `PlanDiff.status` nie oznacza obecnie tego, co mówi komentarz. Może być `"auto"`, a `resolveMigration()` i tak wymagać whole-type hooka, na przykład przy czystym rename enuma albo dodaniu wariantu union.
* `isFixedSize()` jest wewnętrznie niespójne: enum jest odrzucony na wejściu, mimo że wewnętrzne `typeFixed()` uznaje enum za fixed. Stringi i optionale są zawsze traktowane jako variable, choć analizator wylicza dla nich fizyczny `paddedSize`; to zależy jeszcze od dokładnego kontraktu codeców. 
* `defaultValue !== undefined` nie rozróżnia „brak defaultu” od jawnego defaultu `undefined`. Analizator zna chwilowo `hasDefault`, ale nie przenosi tej informacji do `FieldPlan`. 
* `runtime.ts` jest przyjemnie mały i czytelny, a publiczny `index.ts` nie przecieka nadmiernie implementacją.  

## Kolejność napraw

Najpierw poprawiłbym trzy rzeczy: guard na zmianę rodzaju typu, usunięcie `reordered` z mapowania operacji oraz pełny dependency graph obejmujący aliasy i uniony. Następnie constraints string/array i politykę defaultów. Dopiero potem utwardzanie emittera.

Do rozstrzygnięcia dwóch warunkowych punktów przydałyby się jeszcze emitter typów TS oraz `tsCodec` — głównie reprezentacja `i64/u64` i kontrakt `SIZEOF_*` dla stringów, optionals i tablic z `maxLength`.
