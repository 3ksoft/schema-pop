import type { LayoutPlan } from "@schema-pop/schema";
/**
 * Compiles a TypeScript migration function (erasable-syntax, `return { ... }`
 * body) into a C function that operates on raw byte buffers using the field
 * offsets from `fromPlan` / `toPlan`.
 *
 * Signature of emitted C: `void <fnName>(const uint8_t* src, uint8_t* dst)`
 */
export declare function compileMigration(
	source: string,
	fromPlan: LayoutPlan,
	toPlan: LayoutPlan,
): Promise<string>;
