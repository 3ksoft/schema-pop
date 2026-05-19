export const {
	NodeId,
	FSMState,
	ErrorCode,
	ModelConfig,
	LoadModel,
	UpsertGraphNode,
	Generate,
	GarbageCollect,
	LoadLora,
	UnloadLora,
	EngineAction,
	TokenEmitted,
	InferenceStats,
	ErrorEvent,
	TopKEntry,
	SamplingTrace,
	EngineEvent,
} = $.export();

export type NodeId = typeof NodeId.infer;
export type FSMState = typeof FSMState.infer;
export type ErrorCode = typeof ErrorCode.infer;
export type ModelConfig = typeof ModelConfig.infer;
export type LoadModel = typeof LoadModel.infer;
export type UpsertGraphNode = typeof UpsertGraphNode.infer;
export type Generate = typeof Generate.infer;
export type GarbageCollect = typeof GarbageCollect.infer;
export type LoadLora = typeof LoadLora.infer;
export type UnloadLora = typeof UnloadLora.infer;
export type EngineAction = typeof EngineAction.infer;
export type TokenEmitted = typeof TokenEmitted.infer;
export type InferenceStats = typeof InferenceStats.infer;
export type ErrorEvent = typeof ErrorEvent.infer;
export type TopKEntry = typeof TopKEntry.infer;
export type SamplingTrace = typeof SamplingTrace.infer;
export type EngineEvent = typeof EngineEvent.infer;

export type EngineActionTag =
	| "GarbageCollect"
	| "Generate"
	| "LoadLora"
	| "LoadModel"
	| "UnloadLora"
	| "UpsertGraphNode";
export type EngineEventTag =
	| "ErrorEvent"
	| "InferenceStats"
	| "SamplingTrace"
	| "TokenEmitted";
