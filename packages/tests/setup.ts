import { scope } from "arktype";
import { binary, wgsl } from "@schema-pop/schema";

/**
 * Test-suite preload — works around arktypeio/arktype#1640.
 *
 * ArkType 2.2.2+ can overwrite a scope's alias reference with a same-id
 * reference coming from an unrelated resolution. In a process that builds many
 * scopes (i.e. this suite, which runs every test file in ONE process) the
 * effect accumulates until `"u32"` in a freshly built scope resolves to `u3`
 * — silently producing a 1-byte field where a 4-byte one was declared.
 *
 * The failure only hits scopes built AFTER the damage is done, so resolving
 * both tiers once here, before any test file runs, keeps the aliases bound to
 * the right nodes for the rest of the process. Remove this once the upstream
 * fix (arktype#1641) ships and the dependency is bumped past it.
 */
scope({ ...binary.import(), __Warmup: { value: "u32" } }).export();
scope({ ...wgsl.import(), __Warmup: { value: "u32" } }).export();
