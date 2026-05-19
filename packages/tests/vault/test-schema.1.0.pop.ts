import { type } from "arktype";
import { binary } from "@schema-pop/schema";

// v1 — minimum viable surface. Hits primitives across width classes and
// the basic compound shapes (struct, sealed string union, fixed-size array,
// tagged union) so the analyzer has something non-trivial to chew on
// before the v2 evolution adds metadata-heavy generics.
export const $ = type.module({
	...binary.import(),

	Mode: "'Idle' | 'Active' | 'Error'",

	BatteryInfo: {
		voltage: "u16",
		current: "i16",
	},

	Reading: {
		timestamp: "u32",
		value: "i16",
	},

	ReadingBatch: {
		count: "u8",
		items: "Reading[]<=16",
	},

	Heartbeat: {
		uptime: "u32",
	},

	Telemetry: "BatteryInfo | ReadingBatch | Heartbeat",
});
