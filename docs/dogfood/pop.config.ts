import { defineConfig } from "schema-pop";

// Config v2 — schemas are self-describing (`<name>.<version>.pop.ts`).
// Per-target dest + layout flags live in each schema file's
// `schemaPop({...}, scope({...}))` wrap. This config only points at
// the discovery glob; each schema picks its own targets.
export default defineConfig({
	endian: "le",
	wordSize: 64,
});
