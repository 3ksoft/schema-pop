# Code exporters

Code exporters compile a TypeScript migration function (erasable syntax) into a target-language
function that operates on raw byte buffers, using field offsets from `fromPlan` / `toPlan`.

| Package | `@schema-pop/core-exporters` |
|---|---|
| Entry points | `compileCMigration`, `compileRustMigration` |

## Output signatures

| Language | Function signature |
|---|---|
| **TypeScript** | source function as-is (erasable syntax, no compilation step) |
| **C** | `void fn(const uint8_t* src, uint8_t* dst)` |
| **Rust** | `pub fn fn(src: &[u8], dst: &mut [u8]) { unsafe { … } }` |

## Function structure

| Construct | TS | C | Rust | Notes |
|---|:---:|:---:|:---:|---|
| `function name(param: Type)` | ✅ | ✅ | ✅ | single required parameter |
| `function name(param: v1.Type)` | ✅ | ✅ | ✅ | qualified namespace type |
| return type annotation `): ReturnType` | ✅ | ✅ | ✅ | looks up dst struct in toPlan |
| return type `): v1.ReturnType` | ✅ | ✅ | ✅ | qualified namespace |
| multiple parameters | ✅ | ❌ | ❌ | only first param is tracked |
| optional / rest parameters | ✅ | ❌ | ❌ | |
| arrow function / `const fn = () =>` | ✅ | ❌ | ❌ | only `function` declarations |

## Function body

Only the `return { ... }` pattern is supported — a direct object literal as the sole statement.

| Variant | TS | C | Rust | Emitted |
|---|:---:|:---:|:---:|---|
| `{ field: expr }` | ✅ | ✅ | ✅ | write to dst field offset |
| `{ field }` (shorthand, same name) | ✅ | ✅ | ✅ | copy src → dst by offset |
| `{ [computed]: expr }` | ✅ | ❌ | ❌ | |
| `{ ...spread }` | ✅ | ❌ | ❌ | |
| Multiple statements / if / loops | ✅ | ❌ | ❌ | complexity: high — see below |

## Expressions (right-hand side)

### Member access

| Construct | TS | C | Rust | Notes |
|---|:---:|:---:|:---:|---|
| `v1.field` | ✅ | ✅ | ✅ | read by offset |
| `v1.nested.field` (arbitrary depth via ref) | ✅ | ✅ | ✅ | accumulates offset through chain |
| Member on variable other than param | ✅ | ❌ | ❌ | emits `/* unresolved: … */` |

### Operators

| Construct | TS | C | Rust | Notes |
|---|:---:|:---:|:---:|---|
| Arithmetic `+` `-` `*` `/` `%` | ✅ | ✅ | ✅ | |
| Bitwise `&` `\|` `^` `<<` `>>` | ✅ | ✅ | ✅ | |
| Comparison `<` `>` `<=` `>=` `==` `!=` | ✅ | ✅ | ✅ | |
| Strict equality `===` `!==` | ✅ | ✅ | ✅ | Rust: maps to `==` / `!=` |
| Logical `&&` `\|\|` | ✅ | ✅ | ✅ | |
| Ternary `cond ? a : b` | ✅ | ✅ | ✅ | Rust: `if cond { a } else { b }` |
| Parenthesized `(expr)` | ✅ | ✅ | ✅ | |
| Unary `!` `-` `+` | ✅ | ✅ | ✅ | |
| Unary `~` (bitwise NOT) | ✅ | ✅ | ✅ | Rust: emits `!` |
| `??` (nullish coalescing) | ✅ | ✅ | ✅ | C: `((lhs) != 0 ? lhs : rhs)` / Rust: `if` |
| Optional chaining `?.` | ✅ | ❌ | ❌ | complexity: high — blocked by imperative body |

### Literals

| Construct | TS | C | Rust | Notes |
|---|:---:|:---:|:---:|---|
| Number `42`, `0x1F` | ✅ | ✅ | ✅ | verbatim |
| `true` / `false` | ✅ | ✅ | ✅ | C: `1`/`0` / Rust: `true`/`false` |
| `null` / `undefined` | ✅ | ✅ | ✅ | → `0` |
| String `"abc"` | ✅ | ✅ | ✅ | verbatim |
| Template literal `` `${x}` `` | ✅ | ❌ | ❌ | out of scope |
| Array literal `[…]` | ✅ | ❌ | ❌ | out of scope |

### Other

| Construct | TS | C | Rust | Notes |
|---|:---:|:---:|:---:|---|
| `expr as Type` (type assertion) | ✅ | ✅ | ✅ | strip cast, emit inner |
| `Number(x)` | ✅ | ✅ | ✅ | C: `(double)(x)` / Rust: `(x) as f64` |
| `BigInt(x)` | ✅ | ✅ | ✅ | C: `(int64_t)(x)` / Rust: `(x) as i64` |
| `Boolean(x)` | ✅ | ✅ | ✅ | `(x) != 0` |
| `parseInt(x)` | ✅ | ✅ | ✅ | C: `(int32_t)(x)` / Rust: `(x) as i32` |
| `parseFloat(x)` | ✅ | ✅ | ✅ | C: `(float)(x)` / Rust: `(x) as f32` |
| `Math.floor/ceil/round/trunc` | ✅ | ✅ | ✅ | C: `floor(x)` / Rust: `(x).floor()` |
| `Math.abs` | ✅ | ✅ | ✅ | C: ternary / Rust: `(x).abs()` |
| `Math.max/min` | ✅ | ✅ | ✅ | C: ternary / Rust: `(x).max(y)` |

## Field type mapping

| Schema type | C pointer type | Rust pointer type |
|---|---|---|
| `u8/u16/u32/u64` | `uint{n}_t` | `u8/u16/u32/u64` |
| `i8/i16/i32/i64` | `int{n}_t` | `i8/i16/i32/i64` |
| `f32` | `float` | `f32` |
| `f64` | `double` | `f64` |
| `bool`/`boolean` | `bool` | `u8` (UB-safe; read via `!= 0`) |
| reference (nested struct) | offset accumulation | offset accumulation |
| unit | skipped | skipped |

---

## Complexity estimates for missing features

### Imperative body — **high**

`return { … }` is the only supported form. To support:

```ts
function migrate(v1: Foo): Bar {
    const x = v1.a + v1.b;
    return { result: x };
}
```

A local symbol table (bindings → emitted expressions) is needed, built while traversing
`statement_block`. Handling `if_statement` in C requires temporary variables (no inline if
outside ternary position). In Rust `if` is an expression, so slightly simpler.
Estimate: **~150–250 lines** of new code + refactor of the existing `emitExpr`.

### Optional chaining `?.` — **high**

Blocked by imperative body — each `?.` needs a null/zero check before dereferencing,
which requires temporaries or blocks.

### Template literal — **out of scope**

Not meaningful in the context of binary buffer migrations.
