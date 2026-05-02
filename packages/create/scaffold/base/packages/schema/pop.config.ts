/**
 * schema-pop config (v2). The discovery glob defaults to
 * `./**\/*.pop.ts` when omitted; per-schema targets and layout
 * flags live inside each `<name>.<version>.pop.ts` file via
 * `schemaPop({...}, scope({...}))`.
 *
 * Reference: https://github.com/3ksoft/schema-pop/blob/main/docs/config-v2-spec.md
 */
import { defineConfig } from "schema-pop";

export default defineConfig({
	endian: "le",
	wordSize: 64,
});
