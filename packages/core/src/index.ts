// Browser-safe entry. Exports types, codec, analyzer, exporter helpers,
// migrations, scope/Binary markers — none of which pull in jiti or
// node:fs. The build-side APIs (`buildConfig`, `buildSchema`,
// `runBindings`, `bindFile`) live under "schema-pop/node" and require
// a Node / Bun runtime.
export * from "./schema/index";
export * from "./ir";
export {
	Binary,
	Bit,
	Reserved,
	Scale,
	At,
	Describe,
	Obsolete,
	Renamed,
	OriginalType,
} from "./schema/core";
export * from "./layout/analyzer";
export {
	arktypeScopeToIR,
	type ScopeToIROptions,
} from "./layout/scope-to-ir";
export {
	computeLayoutPlan,
	type ComputeLayoutOptions,
} from "./layout/compute-plan";
export * from "./migrations";
export * from "./codec/pop";
export {
	fromArktype,
	getArkType,
	type FormField,
	type FormSchema,
	type FromArktypeOpts,
} from "./codec/field";
export * from "./utils/naming";
export { renderComment } from "./utils/comments";
export type { BindResult, BindingSpec } from "./bind";
export { ExporterTools } from "./exporter-tools";
export type { ExporterToolsKit, NamespaceWrapper } from "./exporter-tools";
export { type, scope } from "arktype";
