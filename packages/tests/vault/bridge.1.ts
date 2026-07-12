import { scope } from "arktype";
import { binary } from "@schema-pop/schema";

/**
 * Binary Bridge Schema for Szczupak Engine.
 * Optimized for zero-copy high-performance communication between Rust and TS.
 */
export const $ = scope({
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

	// --- ENGINE ACTIONS (TS -> RUST) ---

	LoadModel: {
		kind: "'LoadModel'",
		path: "string<254",
		config: "ModelConfig",
	},

	Generate: {
		kind: "'Generate'",
		id: "NodeId",
		parentId: "NodeId",
		prompt: "string<16383",
		maxNewTokens: "u32",
		stopSequence: "string<128",
		contextBlockIds: "u32[] <= 16",
		loraIds: "u32[] <= 16",
		tags: "u32[] <= 16",
		"maxContextLength?": "u32",
	},

	GarbageCollect: {
		kind: "'GarbageCollect'",
		inactiveNodeIds: "NodeId[] <= 32",
	},

	LoadLora: {
		kind: "'LoadLora'",
		id: "u32",
		path: "string<254",
	},

	UnloadLora: {
		kind: "'UnloadLora'",
		id: "u32",
	},

	EngineAction: "GarbageCollect | Generate | LoadModel | LoadLora | UnloadLora",

	// --- ENGINE EVENTS (RUST -> TS) ---

	TokenEmitted: {
		kind: "'TokenEmitted'",
		id: "NodeId",
		token: "string<1023",
		isFinished: "bool",
	},

	/**
	 * Granular telemetry for the VSCode status bar and context engine.
	 */
	InferenceStats: {
		kind: "'InferenceStats'",
		// Performance
		id: "NodeId",
		tps: "f32", // Current tokens per second (decode)
		prefillMs: "u32", // Duration of the last prefill (ms)
		selectedBlocks: "u32[] < 256",
	},

	IndexingStats: {
		kind: "'IndexingStats'",
		// Performance
		block_id: "u32",
		tps: "f32", // Current tokens per second (decode)
	},

	EngineStats: {
		kind: "'EngineStats'",
		// Memory Breakdown (in bytes)
		vramFree: "u64", // Free VRAM
		vramUsed: "u64", // Total process VRAM
		vramCache: "u64", // VRAM consumed specifically by KV-cache
		vramModel: "u64", // VRAM consumed by static model weights

		// Context State
		activeNodes: "u32", // Number of branched KV-cache nodes
		activeBlocks: "u32", // Number of loaded context blocks (files/symbols)
		contextTokens: "u32", // Total tokens currently in active context
		contextLimit: "u32", // Maximum context capacity (e.g., 262144)

		// Cache Performance
		cacheHitRate: "f32", // 0.0 to 1.0 based on last prefill
	},

	ErrorEvent: {
		kind: "'ErrorEvent'",
		code: "ErrorCode",
		message: "string<512",
	},

	// Per-token diagnostic: what the sampler considered at this step.
	// Emitted alongside TokenEmitted so the debugger can show top-k logits.
	TopKEntry: {
		tokenId: "u32",
		prob: "f32",
	},

	SamplingTrace: {
		kind: "'SamplingTrace'",
		id: "NodeId",
		tokenId: "u32",
		topK: "TopKEntry[] <= 8",
	},

	EngineEvent:
		"TokenEmitted | InferenceStats | ErrorEvent | SamplingTrace | EngineStats",
}).export();
