import { scope, binary } from "schema-pop";
export const $testScope = scope({
	...binary.import(),
	BasePin: {
		pin_number: "0 >= number <= 21",
	},
	InputPin: {
		"...": "BasePin",
		mode: "'input'",
		state: "u32",
	},
	OutputPin: {
		"...": "BasePin",
		mode: "'output'",
	},
	PinStatus: "InputPin | OutputPin",
	DeviceStatus: {
		pins: "PinStatus[]<=13>",
	},
	SetPinMode: {
		pin: "0 >= number <= 21",
		mode: "'input' | 'output'",
	},
	SetPinState: {
		pin: "0 >= number <= 21",
		state: "u32",
	},
	WsMessage: "DeviceStatus | SetPinMode | SetPinState",
});
