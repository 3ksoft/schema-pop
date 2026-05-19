/**
 * @module pin-status
 * Schema for the `pin-status` example
 */
import { binary, scope } from "@schema-pop/schema";
export const $ = scope({
	...binary.import(),
	InputPin: {
		mode: "'input'",
		state: "u32",
	},
	OutputPin: {
		mode: "'output'",
	},
	PinStatus: "InputPin | OutputPin",
});
