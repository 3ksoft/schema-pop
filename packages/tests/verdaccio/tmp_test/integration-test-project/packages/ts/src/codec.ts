const __textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const __textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export const SIZEOF_Telemetry = 12;

export function deserializeTelemetry(view: DataView, offset: number, outObj?: any): Telemetry {
	if (!outObj) {
		return {
			id: view.getUint32(offset + 0, true),
			value: view.getFloat32(offset + 4, true),
			active: (view.getUint8(offset + 8) !== 0),
		} as any;
	}
	outObj.id = view.getUint32(offset + 0, true);
	outObj.value = view.getFloat32(offset + 4, true);
	outObj.active = (view.getUint8(offset + 8) !== 0);
	return outObj;
}

export function serializeTelemetry(val: Telemetry, view: DataView, offset: number): void {
	view.setUint32(offset + 0, val.id, true);
	view.setFloat32(offset + 4, val.value, true);
	view.setUint8(offset + 8, (val.active ? 1 : 0));
}

