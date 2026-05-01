import { binary, scope } from "schema-pop";

export const $ = scope({
	...binary.import(),
	DeviceStatus: "'Idle' | 'Active' | 'Error' | 'LowBattery'",
	BatteryInfo: {
		voltage: "u32",
		current: "i32"
	}
});
