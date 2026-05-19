import { type } from "arktype";
import { binary } from "@schema-pop/schema";

/**
 * Binary Bridge Schema for Stateless-VM (Qwen 3.5 Graph Architecture)
 * Uses fixed-width types for zero-copy communication.
 */
export const $ = type.module({
	...binary.import(),

	// Scalars & IDs
	NodeId: "u8[] == 32", // SHA-256 Binary Hash (0-filled for 'None' or 'Root')

	// Enums / String Unions
	FSMState:
		"'THINKING' | 'TOOL_SELECTION' | 'TOOL_ARGS' | 'WAITING_RESULT' | 'REFLECTION' | 'USER_INTERRUPT'",
	ErrorCode:
		"'OOM' | 'ModelNotFound' | 'CompilationFailed' | 'InternalError' | 'GraphPathInvalid'",

	ModelConfig: {
		contextWindow: "u32",
		gpuEnabled: "bool",
	},

	// --- Actions ---

	LoadModel: {
		kind: "'LoadModel'",
		path: "string<254",
		config: "ModelConfig",
	},

	// NOWE: Służy do budowania grafu w tle (bez generowania odpowiedzi)
	// Idealne do VFS - gdy plik się zmienia, wysyłasz to, a Rust przelicza stan w tle.
	UpsertGraphNode: {
		kind: "'UpsertGraphNode'",
		id: "NodeId",
		parentId: "NodeId",
		text: "string<65535",
		priority: "u8", // np. 0 = tło (nie blokuj), 10 = natychmiast
	},

	Generate: {
		kind: "'Generate'",
		id: "NodeId", // ID dla tej konkretnej ścieżki generowania
		pathIds: "NodeId[] <= 32", // Ścieżka w grafie (Pien): [SysPrompt, Deps, File]
		prompt: "string<16383", // Faktyczne zapytanie użytkownika (Liść)

		// NOWE: "Look-aside" context. Doklejany na samym końcu, nie psuje bit-perfect cache'u z pathIds.
		volatileContext: "string<16383", // Np. aktualne Errory kompilatora/LSP diagnostics

		priority: "u8", // 10 = przerywa UpsertGraphNode i natychmiast generuje
		maxNewTokens: "u32",
		stopSequence: "string<128",
		loraIds: "u32[] <= 16",
	},

	GarbageCollect: {
		kind: "'GarbageCollect'",
		// W grafie po prostu zdejmujemy referencje. Jak spadnie do 0, Rust zwalnia VRAM.
		prunedNodeIds: "NodeId[] <= 64",
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

	EngineAction:
		"GarbageCollect | Generate | UpsertGraphNode | LoadModel | LoadLora | UnloadLora",

	// --- Events ---

	TokenEmitted: {
		kind: "'TokenEmitted'",
		id: "NodeId",
		// Qwen 3.5 może wypluć 2-3 tokeny w jednym cyklu!
		tokenIds: "u32[] <= 4",
		textChunk: "string<1023", // Zdekodowany tekst (może zawierać kilka połączonych tokenów z MTP)
		isFinished: "bool",
	},

	InferenceStats: {
		kind: "'InferenceStats'",
		tps: "f32",
		vramKvCacheMB: "u32", // VRAM zajęty przez liniowy Attention (25% warstw)
		vramDeltaStateMB: "u32", // VRAM zajęty przez macierze RNN/DeltaNet (75% warstw)
		activeNodesInGraph: "u32",
	},

	ErrorEvent: {
		kind: "'ErrorEvent'",
		code: "ErrorCode",
		message: "string<512",
	},

	TopKEntry: {
		tokenId: "u32",
		prob: "f32",
	},

	SamplingTrace: {
		kind: "'SamplingTrace'",
		id: "NodeId",
		stepOffset: "u8",
		topK: "TopKEntry[] <= 8",
	},

	EngineEvent: "TokenEmitted | InferenceStats | ErrorEvent | SamplingTrace",
});
