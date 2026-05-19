const __textDecoder =
	typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const __textEncoder =
	typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export const SIZEOF_NodeId = 32;
export const SIZEOF_ModelConfig = 8;
export const SIZEOF_LoadModel = 272;
export const SIZEOF_UpsertGraphNode = 65608;
export const SIZEOF_Generate = 34044;
export const SIZEOF_GarbageCollect = 2056;
export const SIZEOF_LoadLora = 268;
export const SIZEOF_UnloadLora = 8;
export const SIZEOF_EngineAction = 65612;
export const SIZEOF_TokenEmitted = 1084;
export const SIZEOF_InferenceStats = 20;
export const SIZEOF_ErrorEvent = 520;
export const SIZEOF_TopKEntry = 8;
export const SIZEOF_SamplingTrace = 104;
export const SIZEOF_EngineEvent = 1088;

export function deserializeEngineEventTag(
	view: DataView,
	offset: number,
): EngineEventTag {
	const v = view.getUint8(offset);
	switch (v) {
		case 0:
			return "ErrorEvent";
		case 1:
			return "InferenceStats";
		case 2:
			return "SamplingTrace";
		case 3:
			return "TokenEmitted";
		default:
			throw new Error("Unknown Enum value for EngineEventTag: " + v);
	}
}

export function serializeEngineEventTag(
	val: EngineEventTag,
	view: DataView,
	offset: number,
): void {
	if (val === "ErrorEvent") {
		view.setUint8(offset, 0);
		return;
	}
	if (val === "InferenceStats") {
		view.setUint8(offset, 1);
		return;
	}
	if (val === "SamplingTrace") {
		view.setUint8(offset, 2);
		return;
	}
	if (val === "TokenEmitted") {
		view.setUint8(offset, 3);
		return;
	}
}

export function deserializeEngineActionTag(
	view: DataView,
	offset: number,
): EngineActionTag {
	const v = view.getUint8(offset);
	switch (v) {
		case 0:
			return "GarbageCollect";
		case 1:
			return "Generate";
		case 2:
			return "LoadLora";
		case 3:
			return "LoadModel";
		case 4:
			return "UnloadLora";
		case 5:
			return "UpsertGraphNode";
		default:
			throw new Error("Unknown Enum value for EngineActionTag: " + v);
	}
}

export function serializeEngineActionTag(
	val: EngineActionTag,
	view: DataView,
	offset: number,
): void {
	if (val === "GarbageCollect") {
		view.setUint8(offset, 0);
		return;
	}
	if (val === "Generate") {
		view.setUint8(offset, 1);
		return;
	}
	if (val === "LoadLora") {
		view.setUint8(offset, 2);
		return;
	}
	if (val === "LoadModel") {
		view.setUint8(offset, 3);
		return;
	}
	if (val === "UnloadLora") {
		view.setUint8(offset, 4);
		return;
	}
	if (val === "UpsertGraphNode") {
		view.setUint8(offset, 5);
		return;
	}
}

export function deserializeNodeId(view: DataView, offset: number): NodeId {
	return new Uint8Array(view.buffer, view.byteOffset + offset, 32) as any;
}

export function serializeNodeId(
	val: NodeId,
	view: DataView,
	offset: number,
): void {
	{
		const __src = val instanceof Uint8Array ? val : new Uint8Array(val as any);
		new Uint8Array(view.buffer, view.byteOffset + offset, 32).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset, 32).set(
			__src.subarray(0, 32),
		);
	}
}

export function deserializeFSMState(view: DataView, offset: number): FSMState {
	const v = view.getUint8(offset);
	switch (v) {
		case 0:
			return "REFLECTION";
		case 1:
			return "THINKING";
		case 2:
			return "TOOL_ARGS";
		case 3:
			return "TOOL_SELECTION";
		case 4:
			return "USER_INTERRUPT";
		case 5:
			return "WAITING_RESULT";
		default:
			throw new Error("Unknown Enum value for FSMState: " + v);
	}
}

export function serializeFSMState(
	val: FSMState,
	view: DataView,
	offset: number,
): void {
	if (val === "REFLECTION") {
		view.setUint8(offset, 0);
		return;
	}
	if (val === "THINKING") {
		view.setUint8(offset, 1);
		return;
	}
	if (val === "TOOL_ARGS") {
		view.setUint8(offset, 2);
		return;
	}
	if (val === "TOOL_SELECTION") {
		view.setUint8(offset, 3);
		return;
	}
	if (val === "USER_INTERRUPT") {
		view.setUint8(offset, 4);
		return;
	}
	if (val === "WAITING_RESULT") {
		view.setUint8(offset, 5);
		return;
	}
}

export function deserializeErrorCode(
	view: DataView,
	offset: number,
): ErrorCode {
	const v = view.getUint8(offset);
	switch (v) {
		case 0:
			return "CompilationFailed";
		case 1:
			return "GraphPathInvalid";
		case 2:
			return "InternalError";
		case 3:
			return "ModelNotFound";
		case 4:
			return "OOM";
		default:
			throw new Error("Unknown Enum value for ErrorCode: " + v);
	}
}

export function serializeErrorCode(
	val: ErrorCode,
	view: DataView,
	offset: number,
): void {
	if (val === "CompilationFailed") {
		view.setUint8(offset, 0);
		return;
	}
	if (val === "GraphPathInvalid") {
		view.setUint8(offset, 1);
		return;
	}
	if (val === "InternalError") {
		view.setUint8(offset, 2);
		return;
	}
	if (val === "ModelNotFound") {
		view.setUint8(offset, 3);
		return;
	}
	if (val === "OOM") {
		view.setUint8(offset, 4);
		return;
	}
}

export function deserializeModelConfig(
	view: DataView,
	offset: number,
	outObj?: any,
): ModelConfig {
	if (!outObj) {
		return {
			contextWindow: view.getUint32(offset + 0, true),
			gpuEnabled: view.getUint8(offset + 4) !== 0,
		} as any;
	}
	outObj.contextWindow = view.getUint32(offset + 0, true);
	outObj.gpuEnabled = view.getUint8(offset + 4) !== 0;
	return outObj;
}

export function serializeModelConfig(
	val: ModelConfig,
	view: DataView,
	offset: number,
): void {
	view.setUint32(offset + 0, val.contextWindow, true);
	view.setUint8(offset + 4, val.gpuEnabled ? 1 : 0);
}

export function deserializeLoadModel(
	view: DataView,
	offset: number,
	outObj?: any,
): LoadModel {
	if (!outObj) {
		return {
			config: {
				contextWindow: view.getUint32(offset + 0 + 0, true),
				gpuEnabled: view.getUint8(offset + 0 + 4) !== 0,
			},
			path: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 8),
			kind: "LoadModel",
		} as any;
	}
	outObj.config = {
		contextWindow: view.getUint32(offset + 0 + 0, true),
		gpuEnabled: view.getUint8(offset + 0 + 4) !== 0,
	};
	outObj.path = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 8);
	outObj.kind = "LoadModel";
	return outObj;
}

export function serializeLoadModel(
	val: LoadModel,
	view: DataView,
	offset: number,
): void {
	{
		view.setUint32(offset + 0 + 0, val.config.contextWindow, true);
		view.setUint8(offset + 0 + 4, val.config.gpuEnabled ? 1 : 0);
	}
	{
		const bytes = __textEncoder!.encode(val.path);
		const len = Math.min(bytes.length, 253);
		view.setUint32(offset + 8, len, true);
		new Uint8Array(view.buffer, view.byteOffset + offset + 8 + 4, 253).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset + 8 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	view.setUint8(offset + 268, 0);
}

export function deserializeUpsertGraphNode(
	view: DataView,
	offset: number,
	outObj?: any,
): UpsertGraphNode {
	if (!outObj) {
		return {
			text: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 0),
			id: deserializeNodeId(view, offset + 65540),
			kind: "UpsertGraphNode",
			parentId: deserializeNodeId(view, offset + 65573),
			priority: view.getUint8(offset + 65605),
		} as any;
	}
	outObj.text = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 0);
	outObj.id = deserializeNodeId(view, offset + 65540);
	outObj.kind = "UpsertGraphNode";
	outObj.parentId = deserializeNodeId(view, offset + 65573);
	outObj.priority = view.getUint8(offset + 65605);
	return outObj;
}

export function serializeUpsertGraphNode(
	val: UpsertGraphNode,
	view: DataView,
	offset: number,
): void {
	{
		const bytes = __textEncoder!.encode(val.text);
		const len = Math.min(bytes.length, 65534);
		view.setUint32(offset + 0, len, true);
		new Uint8Array(view.buffer, view.byteOffset + offset + 0 + 4, 65534).fill(
			0,
		);
		new Uint8Array(view.buffer, view.byteOffset + offset + 0 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	serializeNodeId(val.id, view, offset + 65540);
	view.setUint8(offset + 65572, 0);
	serializeNodeId(val.parentId, view, offset + 65573);
	view.setUint8(offset + 65605, val.priority);
}

export function deserializeGenerate(
	view: DataView,
	offset: number,
	outObj?: any,
): Generate {
	if (!outObj) {
		return {
			loraIds: ((o) => {
				const l = view.getUint32(o, true);
				const a: any[] = [];
				const start = o + 4;
				for (let i = 0; i < l; i++) {
					const o = start;
					a.push(view.getUint32(o + i * 4, true));
				}
				return a;
			})(offset + 0),
			maxNewTokens: view.getUint32(offset + 68, true),
			pathIds: ((o) => {
				const l = view.getUint32(o, true);
				const a: any[] = [];
				const start = o + 4;
				for (let i = 0; i < l; i++) {
					const o = start;
					a.push(deserializeNodeId(view, o + i * 32));
				}
				return a;
			})(offset + 72),
			prompt: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 1100),
			stopSequence: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 17488),
			volatileContext: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 17620),
			id: deserializeNodeId(view, offset + 34008),
			kind: "Generate",
			priority: view.getUint8(offset + 34041),
		} as any;
	}
	outObj.loraIds = ((o) => {
		const l = view.getUint32(o, true);
		const a: any[] = [];
		const start = o + 4;
		for (let i = 0; i < l; i++) {
			const o = start;
			a.push(view.getUint32(o + i * 4, true));
		}
		return a;
	})(offset + 0);
	outObj.maxNewTokens = view.getUint32(offset + 68, true);
	outObj.pathIds = ((o) => {
		const l = view.getUint32(o, true);
		const a: any[] = [];
		const start = o + 4;
		for (let i = 0; i < l; i++) {
			const o = start;
			a.push(deserializeNodeId(view, o + i * 32));
		}
		return a;
	})(offset + 72);
	outObj.prompt = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 1100);
	outObj.stopSequence = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 17488);
	outObj.volatileContext = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 17620);
	outObj.id = deserializeNodeId(view, offset + 34008);
	outObj.kind = "Generate";
	outObj.priority = view.getUint8(offset + 34041);
	return outObj;
}

export function serializeGenerate(
	val: Generate,
	view: DataView,
	offset: number,
): void {
	{
		view.setUint32(offset + 0, val.loraIds.length, true);
		let o = offset + 0 + 4;
		for (let i = 0; i < val.loraIds.length; i++) {
			view.setUint32(o + i * 4, val.loraIds[i]!, true);
		}
	}
	view.setUint32(offset + 68, val.maxNewTokens, true);
	{
		view.setUint32(offset + 72, val.pathIds.length, true);
		let o = offset + 72 + 4;
		for (let i = 0; i < val.pathIds.length; i++) {
			serializeNodeId(val.pathIds[i]!, view, o + i * 32);
		}
	}
	{
		const bytes = __textEncoder!.encode(val.prompt);
		const len = Math.min(bytes.length, 16382);
		view.setUint32(offset + 1100, len, true);
		new Uint8Array(
			view.buffer,
			view.byteOffset + offset + 1100 + 4,
			16382,
		).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset + 1100 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	{
		const bytes = __textEncoder!.encode(val.stopSequence);
		const len = Math.min(bytes.length, 127);
		view.setUint32(offset + 17488, len, true);
		new Uint8Array(view.buffer, view.byteOffset + offset + 17488 + 4, 127).fill(
			0,
		);
		new Uint8Array(view.buffer, view.byteOffset + offset + 17488 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	{
		const bytes = __textEncoder!.encode(val.volatileContext);
		const len = Math.min(bytes.length, 16382);
		view.setUint32(offset + 17620, len, true);
		new Uint8Array(
			view.buffer,
			view.byteOffset + offset + 17620 + 4,
			16382,
		).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset + 17620 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	serializeNodeId(val.id, view, offset + 34008);
	view.setUint8(offset + 34040, 0);
	view.setUint8(offset + 34041, val.priority);
}

export function deserializeGarbageCollect(
	view: DataView,
	offset: number,
	outObj?: any,
): GarbageCollect {
	if (!outObj) {
		return {
			prunedNodeIds: ((o) => {
				const l = view.getUint32(o, true);
				const a: any[] = [];
				const start = o + 4;
				for (let i = 0; i < l; i++) {
					const o = start;
					a.push(deserializeNodeId(view, o + i * 32));
				}
				return a;
			})(offset + 0),
			kind: "GarbageCollect",
		} as any;
	}
	outObj.prunedNodeIds = ((o) => {
		const l = view.getUint32(o, true);
		const a: any[] = [];
		const start = o + 4;
		for (let i = 0; i < l; i++) {
			const o = start;
			a.push(deserializeNodeId(view, o + i * 32));
		}
		return a;
	})(offset + 0);
	outObj.kind = "GarbageCollect";
	return outObj;
}

export function serializeGarbageCollect(
	val: GarbageCollect,
	view: DataView,
	offset: number,
): void {
	{
		view.setUint32(offset + 0, val.prunedNodeIds.length, true);
		let o = offset + 0 + 4;
		for (let i = 0; i < val.prunedNodeIds.length; i++) {
			serializeNodeId(val.prunedNodeIds[i]!, view, o + i * 32);
		}
	}
	view.setUint8(offset + 2052, 0);
}

export function deserializeLoadLora(
	view: DataView,
	offset: number,
	outObj?: any,
): LoadLora {
	if (!outObj) {
		return {
			id: view.getUint32(offset + 0, true),
			path: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 4),
			kind: "LoadLora",
		} as any;
	}
	outObj.id = view.getUint32(offset + 0, true);
	outObj.path = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 4);
	outObj.kind = "LoadLora";
	return outObj;
}

export function serializeLoadLora(
	val: LoadLora,
	view: DataView,
	offset: number,
): void {
	view.setUint32(offset + 0, val.id, true);
	{
		const bytes = __textEncoder!.encode(val.path);
		const len = Math.min(bytes.length, 253);
		view.setUint32(offset + 4, len, true);
		new Uint8Array(view.buffer, view.byteOffset + offset + 4 + 4, 253).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset + 4 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	view.setUint8(offset + 264, 0);
}

export function deserializeUnloadLora(
	view: DataView,
	offset: number,
	outObj?: any,
): UnloadLora {
	if (!outObj) {
		return {
			id: view.getUint32(offset + 0, true),
			kind: "UnloadLora",
		} as any;
	}
	outObj.id = view.getUint32(offset + 0, true);
	outObj.kind = "UnloadLora";
	return outObj;
}

export function serializeUnloadLora(
	val: UnloadLora,
	view: DataView,
	offset: number,
): void {
	view.setUint32(offset + 0, val.id, true);
	view.setUint8(offset + 4, 0);
}

export function deserializeEngineAction(
	view: DataView,
	offset: number,
): EngineAction {
	const tag = view.getUint8(offset + 0);
	switch (tag) {
		case 0: {
			const obj = deserializeGarbageCollect(view, offset + 4);
			(obj as any).kind = "GarbageCollect";
			return obj as any;
		}
		case 1: {
			const obj = deserializeGenerate(view, offset + 4);
			(obj as any).kind = "Generate";
			return obj as any;
		}
		case 2: {
			const obj = deserializeLoadLora(view, offset + 4);
			(obj as any).kind = "LoadLora";
			return obj as any;
		}
		case 3: {
			const obj = deserializeLoadModel(view, offset + 4);
			(obj as any).kind = "LoadModel";
			return obj as any;
		}
		case 4: {
			const obj = {
				id: view.getUint32(offset + 4 + 0, true),
				kind: "UnloadLora",
			};
			(obj as any).kind = "UnloadLora";
			return obj as any;
		}
		case 5: {
			const obj = deserializeUpsertGraphNode(view, offset + 4);
			(obj as any).kind = "UpsertGraphNode";
			return obj as any;
		}
		default:
			throw new Error("Unknown Union tag for EngineAction: " + tag);
	}
}

export function serializeEngineAction(
	val: EngineAction,
	view: DataView,
	offset: number,
): void {
	switch (val.kind) {
		case "GarbageCollect": {
			view.setUint8(offset + 0, 0);
			serializeGarbageCollect(val, view, offset + 4);
			break;
		}
		case "Generate": {
			view.setUint8(offset + 0, 1);
			serializeGenerate(val, view, offset + 4);
			break;
		}
		case "LoadLora": {
			view.setUint8(offset + 0, 2);
			serializeLoadLora(val, view, offset + 4);
			break;
		}
		case "LoadModel": {
			view.setUint8(offset + 0, 3);
			serializeLoadModel(val, view, offset + 4);
			break;
		}
		case "UnloadLora": {
			view.setUint8(offset + 0, 4);
			{
				view.setUint32(offset + 4 + 0, val.id, true);
				view.setUint8(offset + 4 + 4, 0);
			}
			break;
		}
		case "UpsertGraphNode": {
			view.setUint8(offset + 0, 5);
			serializeUpsertGraphNode(val, view, offset + 4);
			break;
		}
	}
}

export function deserializeTokenEmitted(
	view: DataView,
	offset: number,
	outObj?: any,
): TokenEmitted {
	if (!outObj) {
		return {
			textChunk: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 0),
			tokenIds: ((o) => {
				const l = view.getUint32(o, true);
				const a: any[] = [];
				const start = o + 4;
				for (let i = 0; i < l; i++) {
					const o = start;
					a.push(view.getUint32(o + i * 4, true));
				}
				return a;
			})(offset + 1028),
			id: deserializeNodeId(view, offset + 1048),
			isFinished: view.getUint8(offset + 1080) !== 0,
			kind: "TokenEmitted",
		} as any;
	}
	outObj.textChunk = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 0);
	outObj.tokenIds = ((o) => {
		const l = view.getUint32(o, true);
		const a: any[] = [];
		const start = o + 4;
		for (let i = 0; i < l; i++) {
			const o = start;
			a.push(view.getUint32(o + i * 4, true));
		}
		return a;
	})(offset + 1028);
	outObj.id = deserializeNodeId(view, offset + 1048);
	outObj.isFinished = view.getUint8(offset + 1080) !== 0;
	outObj.kind = "TokenEmitted";
	return outObj;
}

export function serializeTokenEmitted(
	val: TokenEmitted,
	view: DataView,
	offset: number,
): void {
	{
		const bytes = __textEncoder!.encode(val.textChunk);
		const len = Math.min(bytes.length, 1022);
		view.setUint32(offset + 0, len, true);
		new Uint8Array(view.buffer, view.byteOffset + offset + 0 + 4, 1022).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset + 0 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	{
		view.setUint32(offset + 1028, val.tokenIds.length, true);
		let o = offset + 1028 + 4;
		for (let i = 0; i < val.tokenIds.length; i++) {
			view.setUint32(o + i * 4, val.tokenIds[i]!, true);
		}
	}
	serializeNodeId(val.id, view, offset + 1048);
	view.setUint8(offset + 1080, val.isFinished ? 1 : 0);
	view.setUint8(offset + 1081, 0);
}

export function deserializeInferenceStats(
	view: DataView,
	offset: number,
	outObj?: any,
): InferenceStats {
	if (!outObj) {
		return {
			activeNodesInGraph: view.getUint32(offset + 0, true),
			tps: view.getFloat32(offset + 4, true),
			vramDeltaStateMB: view.getUint32(offset + 8, true),
			vramKvCacheMB: view.getUint32(offset + 12, true),
			kind: "InferenceStats",
		} as any;
	}
	outObj.activeNodesInGraph = view.getUint32(offset + 0, true);
	outObj.tps = view.getFloat32(offset + 4, true);
	outObj.vramDeltaStateMB = view.getUint32(offset + 8, true);
	outObj.vramKvCacheMB = view.getUint32(offset + 12, true);
	outObj.kind = "InferenceStats";
	return outObj;
}

export function serializeInferenceStats(
	val: InferenceStats,
	view: DataView,
	offset: number,
): void {
	view.setUint32(offset + 0, val.activeNodesInGraph, true);
	view.setFloat32(offset + 4, val.tps, true);
	view.setUint32(offset + 8, val.vramDeltaStateMB, true);
	view.setUint32(offset + 12, val.vramKvCacheMB, true);
	view.setUint8(offset + 16, 0);
}

export function deserializeErrorEvent(
	view: DataView,
	offset: number,
	outObj?: any,
): ErrorEvent {
	if (!outObj) {
		return {
			message: ((o) => {
				const l = view.getUint32(o, true);
				return __textDecoder!.decode(
					new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
				);
			})(offset + 0),
			code: deserializeErrorCode(view, offset + 516),
			kind: "ErrorEvent",
		} as any;
	}
	outObj.message = ((o) => {
		const l = view.getUint32(o, true);
		return __textDecoder!.decode(
			new Uint8Array(view.buffer, view.byteOffset + o + 4, l),
		);
	})(offset + 0);
	outObj.code = deserializeErrorCode(view, offset + 516);
	outObj.kind = "ErrorEvent";
	return outObj;
}

export function serializeErrorEvent(
	val: ErrorEvent,
	view: DataView,
	offset: number,
): void {
	{
		const bytes = __textEncoder!.encode(val.message);
		const len = Math.min(bytes.length, 511);
		view.setUint32(offset + 0, len, true);
		new Uint8Array(view.buffer, view.byteOffset + offset + 0 + 4, 511).fill(0);
		new Uint8Array(view.buffer, view.byteOffset + offset + 0 + 4, len).set(
			bytes.subarray(0, len),
		);
	}
	serializeErrorCode(val.code, view, offset + 516);
	view.setUint8(offset + 517, 0);
}

export function deserializeTopKEntry(
	view: DataView,
	offset: number,
	outObj?: any,
): TopKEntry {
	if (!outObj) {
		return {
			prob: view.getFloat32(offset + 0, true),
			tokenId: view.getUint32(offset + 4, true),
		} as any;
	}
	outObj.prob = view.getFloat32(offset + 0, true);
	outObj.tokenId = view.getUint32(offset + 4, true);
	return outObj;
}

export function serializeTopKEntry(
	val: TopKEntry,
	view: DataView,
	offset: number,
): void {
	view.setFloat32(offset + 0, val.prob, true);
	view.setUint32(offset + 4, val.tokenId, true);
}

export function deserializeSamplingTrace(
	view: DataView,
	offset: number,
	outObj?: any,
): SamplingTrace {
	if (!outObj) {
		return {
			topK: ((o) => {
				const l = view.getUint32(o, true);
				const a: any[] = [];
				const start = o + 4;
				for (let i = 0; i < l; i++) {
					const o = start;
					a.push({
						prob: view.getFloat32(o + i * 8 + 0, true),
						tokenId: view.getUint32(o + i * 8 + 4, true),
					});
				}
				return a;
			})(offset + 0),
			id: deserializeNodeId(view, offset + 68),
			kind: "SamplingTrace",
			stepOffset: view.getUint8(offset + 101),
		} as any;
	}
	outObj.topK = ((o) => {
		const l = view.getUint32(o, true);
		const a: any[] = [];
		const start = o + 4;
		for (let i = 0; i < l; i++) {
			const o = start;
			a.push({
				prob: view.getFloat32(o + i * 8 + 0, true),
				tokenId: view.getUint32(o + i * 8 + 4, true),
			});
		}
		return a;
	})(offset + 0);
	outObj.id = deserializeNodeId(view, offset + 68);
	outObj.kind = "SamplingTrace";
	outObj.stepOffset = view.getUint8(offset + 101);
	return outObj;
}

export function serializeSamplingTrace(
	val: SamplingTrace,
	view: DataView,
	offset: number,
): void {
	{
		view.setUint32(offset + 0, val.topK.length, true);
		let o = offset + 0 + 4;
		for (let i = 0; i < val.topK.length; i++) {
			{
				view.setFloat32(o + i * 8 + 0, val.topK[i]!.prob, true);
				view.setUint32(o + i * 8 + 4, val.topK[i]!.tokenId, true);
			}
		}
	}
	serializeNodeId(val.id, view, offset + 68);
	view.setUint8(offset + 100, 0);
	view.setUint8(offset + 101, val.stepOffset);
}

export function deserializeEngineEvent(
	view: DataView,
	offset: number,
): EngineEvent {
	const tag = view.getUint8(offset + 0);
	switch (tag) {
		case 0: {
			const obj = deserializeErrorEvent(view, offset + 4);
			(obj as any).kind = "ErrorEvent";
			return obj as any;
		}
		case 1: {
			const obj = deserializeInferenceStats(view, offset + 4);
			(obj as any).kind = "InferenceStats";
			return obj as any;
		}
		case 2: {
			const obj = deserializeSamplingTrace(view, offset + 4);
			(obj as any).kind = "SamplingTrace";
			return obj as any;
		}
		case 3: {
			const obj = deserializeTokenEmitted(view, offset + 4);
			(obj as any).kind = "TokenEmitted";
			return obj as any;
		}
		default:
			throw new Error("Unknown Union tag for EngineEvent: " + tag);
	}
}

export function serializeEngineEvent(
	val: EngineEvent,
	view: DataView,
	offset: number,
): void {
	switch (val.kind) {
		case "ErrorEvent": {
			view.setUint8(offset + 0, 0);
			serializeErrorEvent(val, view, offset + 4);
			break;
		}
		case "InferenceStats": {
			view.setUint8(offset + 0, 1);
			serializeInferenceStats(val, view, offset + 4);
			break;
		}
		case "SamplingTrace": {
			view.setUint8(offset + 0, 2);
			serializeSamplingTrace(val, view, offset + 4);
			break;
		}
		case "TokenEmitted": {
			view.setUint8(offset + 0, 3);
			serializeTokenEmitted(val, view, offset + 4);
			break;
		}
	}
}
