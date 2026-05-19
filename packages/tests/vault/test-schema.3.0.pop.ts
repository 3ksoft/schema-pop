import { type } from "arktype";
import { binary } from "@schema-pop/schema";

// v3 — drops the deprecated `LegacyVoltage` (was Obsolete in v2). Adds full
// primitive coverage (f32/f64, u128/i128) plus the remaining structural
// generics: `Reserved` for explicit padding holes and `At` for forced
// memory offsets. Also widens StatusFlags to span the full u8 worth of
// bit-packed fields (u1+u3+u4 → 8 bits) and introduces an aligned cumulative
// counter struct that pins fields at specific addresses.
export const $ = scope({
	...schemaPop,

	Mode: "'Idle' | 'Active' | 'Error' | 'LowBattery' | 'Charging' | 'Sleep'",

	StatusFlags: {
		enabled: "u1",
		mode_bits: "u3",
		retries: "u4",
	},

	BatteryInfo: {
		voltage: "Describe<Scale<u16, 0.001>, 'volts (mV raw → V scaled)'>",
		current: "Describe<i16, 'milliamps, signed'>",
		charging: "bool",
		_pad: "Reserved<u8, 3>",
		temperature_c: "Scale<i16, 0.01>",
	},

	Reading: {
		timestamp: "i64",
		value: "Scale<i16, 0.01>",
		precision: "f32",
		flags: "StatusFlags",
	},

	ReadingBatch: {
		count: "u16",
		_pad: "Reserved<u8, 6>",
		items: "Reading[]<=64",
	},

	Heartbeat: {
		uptime: "u64",
		last_seen: "i64",
		drift: "f64",
	},

	CounterBlock: {
		total_packets: "u128",
		net_offset: "i128",
		jitter: "f32",
	},

	PinnedRegister: {
		ctrl: "At<u32, 64>",
		data: "At<u64, 72>",
	},

	Telemetry: "BatteryInfo | ReadingBatch | Heartbeat | CounterBlock",
});
