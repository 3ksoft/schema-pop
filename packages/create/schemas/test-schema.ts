import { binary, scope } from "schema-pop";

export const $ = scope({
	...binary.import(),
	DeviceStatus: "'Idle' | 'Active' | 'Error'",
	BatteryInfo: {
		voltage: "u16",
		current: "i16"
	}
});
