import { type } from "arktype";
import { binary } from "@schema-pop/schema";

// v2 — pulls in the metadata-bearing generics. Adds bit-packed flags via
// `bitwise` (u1..u7), physical scaling via `Scale`, descriptions via
// `Describe`, and marks `LegacyVoltage` deprecated through `Obsolete` so the
// analyzer/exporters have to surface deprecation. Wider primitives (i64,
// u64) and the new `LowBattery`/`Charging` variants exercise enum growth
// paths.
export const $ = scope({
	...schemaPop,

	Mode: "'Idle' | 'Active' | 'Error' | 'LowBattery' | 'Charging'",

	StatusFlags: {
		enabled: "u1",
		mode_bits: "u3",
		retries: "u4",
	},

	BatteryInfo: {
		voltage: "Describe<Scale<u16, 0.001>, 'volts (mV raw → V scaled)'>",
		current: "Describe<i16, 'milliamps, signed'>",
		charging: "bool",
	},

	LegacyVoltage: "Obsolete<u16, 'use BatteryInfo.voltage'>",

	Reading: {
		timestamp: "i64",
		value: "Scale<i16, 0.01>",
		flags: "StatusFlags",
	},

	ReadingBatch: {
		count: "u16",
		items: "Reading[]<=64",
	},

	Heartbeat: {
		uptime: "u64",
		last_seen: "i64",
	},

	Telemetry: "BatteryInfo | ReadingBatch | Heartbeat",
});
