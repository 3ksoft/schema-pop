import { binary, scope } from "@schema-pop/schema";

export const $ = scope({
	...binary.import(),
	Telemetry: {
		id: "u32",
		value: "f32",
		active: "boolean",
	},
});
