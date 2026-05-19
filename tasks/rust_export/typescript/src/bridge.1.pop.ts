import { scope } from "arktype";
import { binary } from "@schema-pop/schema";

export const $bridge = scope({
	...binary.import(),

	// Scalars & IDs
	NodeId: "u8[] == 32", // SHA-256 Binary Hash

	// Enums / String Unions
	FSMState:
		"'THINKING' | 'TOOL_SELECTION' | 'TOOL_ARGS' | 'WAITING_RESULT' | 'REFLECTION' | 'USER_INTERRUPT'",
	ErrorCode: "'OOM' | 'ModelNotFound' | 'CompilationFailed' | 'InternalError'",

	ModelConfig: {
		contextWindow: "u32",
		gpuEnabled: "bool",
	},

	// Structs for Discriminated Union: EngineAction
	LoadModel: {
		path: "string<254",
		config: "ModelConfig",
	},

	Generate: {
		id: "NodeId",
		parentId: "NodeId",
		grammar: "string<16383",
		"stop_sequences?": "u8[] == 552",
	},

	TrainingSample: {
		prompt: "string<4096",
		completion: "string<4096",
	},

	FineTune: {
		batch: "TrainingSample[] <= 32",
	},

	GarbageCollect: {
		inactiveNodeIds: "NodeId[] <= 32",
	},

	// EngineAction Union
	EngineAction: "FineTune | GarbageCollect | Generate | LoadModel",

	// Structs for Discriminated Union: EngineEvent
	TokenEmitted: {
		id: "NodeId",
		token: "string<1023",
		isFinished: "bool",
	},

	InferenceStats: {
		tps: "f32",
		vramUsed: "u64",
		activeNodes: "u32",
	},

	ErrorEvent: {
		code: "ErrorCode",
		message: "string<512",
	},

	// EngineEvent Union
	EngineEvent: "TokenEmitted | InferenceStats | ErrorEvent",
});

const bridge = $bridge.export();
export type EngineAction = typeof bridge.EngineAction.infer;
export type EngineEvent = typeof bridge.EngineEvent.infer;
