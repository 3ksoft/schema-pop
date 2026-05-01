import { binary } from "./binary";
import { bitwise } from "./bitwise";
import { Reserved, Scale, At } from "./core";

/**
 * Convenience alias bundle merging everything schema-pop offers in one go:
 * `binary` (bool, u8..u128/i8..i128, f32/f64, plus Binary/Describe/Obsolete generics),
 * `bitwise` (u1..u7, plus Bit), and the standalone generics `Reserved`, `Scale`, `At`.
 *
 * Use it when you want full coverage without juggling individual imports:
 * ```ts
 * import { schemaPop, scope } from "schema-pop";
 * const $ = scope({ ...schemaPop, MyType: { ... } });
 * ```
 *
 * Note this is a plain alias dict, not an arktype scope — splat it directly.
 * (If we wrapped it in `scope(...)`, `.import()` would only re-emit the
 * locally-defined aliases, dropping the spread-in primitives.)
 */
export const schemaPop = {
	...binary.import(),
	...bitwise.import(),
	"#Reserved": Reserved,
	"#Scale": Scale,
	"#At": At,
};
