To świetne podejście. Skoro masz już doświadczenie z importerami `clang` i `tree-sitter`, wiesz, że różnica polega na tym, że Gimli/DWARF daje Ci dane "po bitwie" – czyli to, co faktycznie trafiło do binarki, a nie to, co programista chciał napisać.

Oto podział feature'ów na 3 tiery dla Twojego importera Gimli -> LLP:

---

### Tier 1: Simple (The "Skeleton")

_Cel: Wyciągnięcie płaskiej struktury typów i podstawowych rozmiarów._

1.  **Mapowanie Base Types:** Przetworzenie `DW_TAG_base_type` na `PrimitiveField`. Mapowanie nazw (np. `int`, `size_t`) na `popKind: 'binary'`.
2.  **Płaskie Struktury:** Obsługa `DW_TAG_structure_type` i prostych pól `DW_TAG_member`.
    - Wyciąganie `DW_AT_byte_size` dla `TypeLayout`.
    - Obliczanie `offset` z `DW_AT_data_member_location`.
3.  **Proste Aliasy:** Obsługa `DW_TAG_typedef` (tworzenie `AliasPlan`).
4.  **Enumy (Bez rekurencji):** Mapowanie `DW_TAG_enumeration_type` na `EnumPlan`. Wyciąganie wartości `DW_TAG_enumerator` jako `EnumVariant`.
5.  **Podstawowy LayoutConfig:** Ustalenie `endian` i `wordSize` (32/64 bit) na podstawie nagłówka ELF/Mach-O, który parsujesz przed Gimli.

---

### Tier 2: Medium (The "Graph")

_Cel: Rozwiązanie relacji między typami i obsługa kontenerów._

1.  **Indirekcje (Pointers & References):**
    - Obsługa `DW_TAG_pointer_type` i `DW_TAG_reference_type`.
    - **Kluczowe wyzwanie:** Mapowanie offsetów DWARF na Twoje `ReferenceField.name`. Musisz zbudować mapę `Offset -> TypeName`.
2.  **Tablice (Arrays):** Obsługa `DW_TAG_array_type`. Wyciąganie `maxLength` z `DW_TAG_subrange_type` (atrybut `DW_AT_upper_bound`).
3.  **Zagnieżdżone Typy:** Obsługa `InlineStructField` – rozpoznawanie, kiedy pole w strukturze nie jest wskaźnikiem, ale inną strukturą wkomponowaną bezpośrednio.
4.  **Deduplikacja ODR:** DWARF często powiela definicje tych samych typów w różnych jednostkach kompilacji (CU). Musisz zaimplementować mechanizm "unifikacji", żeby nie mieć w `LayoutPlan.types` dziesięciu kopii tej samej struktury `Vector3`.
5.  **Obsługa Opcjonalności:** Mapowanie specyficznych konwencji (jeśli binarka je ma) na `OptionalField`.

---

### Tier 3: Hard (The "Deep Dive")

_Cel: Precyzja bitowa, unie i funkcje._

1.  **Pola Bitowe (Bitfields):**
    - Obsługa `DW_AT_bit_size` i `DW_AT_data_bit_offset`.
    - To tutaj Twój `bitOffset: "number<8"` i `bitSize` w `FieldPlan` zostaną przetestowane. Obliczanie tego poprawnie, biorąc pod uwagę Endianness, jest trudne.
2.  **Unie (UnionPlan):**
    - DWARF traktuje unie jako `DW_TAG_union_type`, gdzie wszystkie pola mają `offset: 0`.
    - Jeśli to Rust Enums (Tagged Unions), musisz szukać `DW_TAG_variant_part` i mapować dyskryminator na `tagOffset` i `tagSize`.
3.  **FunctionPlan (Pełna obsługa):**
    - Parsowanie `DW_TAG_subprogram`.
    - Wyciąganie argumentów (`DW_TAG_formal_parameter`) i mapowanie ich na `FunctionArg`.
    - Określanie `returnType` z `DW_AT_type`.
    - **Problem:** DWARF rzadko przechowuje wprost `abi` (np. `stdcall` vs `cdecl`) – czasem trzeba to inferować z flag kompilatora lub specyficznych atrybutów targetu.
4.  **Rekurencyjne Layouty:** Poprawne obliczanie `paddingAfter` i `paddedSize` dla struktur, które mają niestandardowe wyrównanie (`align`) wymuszone przez `#pragma pack` lub atrybuty kompilatora.
5.  **Cross-Unit References:** Obsługa sytuacji, gdzie typ jest zdefiniowany w jednym pliku `.debug_info`, a używany w innym (wymaga sprawnego `Dwarf::load` i zarządzania pamięcią).

---

### Podpowiedź "pro-tip" dla Gimli:

Przy Tier 2 i 3, Gimli udostępnia coś takiego jak `AttributeValue::UnitRef`. Zamiast polegać na nazwach stringowych, które mogą być nieobecne (anonimowe struktury!), używaj **Globalnego Offsetu DIE** jako tymczasowego klucza w mapie typów. Dopiero na samym końcu, przy eksporcie do LLP, zamieniaj te offsety na czytelne nazwy lub generuj syntetyczne (np. `AnonStruct_0x1234`).

Który z tych tierów wydaje Ci się najbardziej problematyczny przy przejściu z `clang-importer` na `gimli`? Moim zdaniem **Tier 3 i unie** będą największym wyzwaniem, bo clang-ast ma to "wyłożone na tacy", a w DWARF musisz to składać z surowych bajtów.
