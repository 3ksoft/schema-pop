bun packages/cli/src/cli.ts packages/tests/vault/bridge.1.pop.ts -t rust -o tasks/rust_export/rust/src/lib.rs
bun packages/cli/src/cli.ts packages/tests/vault/bridge.1.pop.ts -t ts:codec -o tasks/rust_export/typescript/src/codec.ts


relevant source files: 
packages/exporter/src/exporters/rust.ts
packages/exporter/src/exporters/tsCodec.ts


Cargo build fails, probably because of specifc lengths

for typescript, create new exporter, named tsExports, it will be used to generate arktype boilerplate like:


export const {
	NodeId,
	FSMState,
	ErrorCode,
	ModelConfig,
...
} = $bridge.export();

export type NodeId = typeof NodeId.infer;
export type FSMState = typeof FSMState.infer;
export type ErrorCode = typeof ErrorCode.infer;
export type ModelConfig = typeof ModelConfig.infer;
...


It also should generate Tag types for unions like: 

type EngineEventTag = "ErrorEvent" | "InferenceStats" | "TokenEmitted";

codec is using those but they're not normally defined in the schema