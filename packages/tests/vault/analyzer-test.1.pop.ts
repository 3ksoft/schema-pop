import { type } from "arktype";
import { binary } from "@schema-pop/schema";

export const $ = type.module({
	...binary.import(),

	// Layout / analyzer fixtures
	Simple: {
		a: "u8",
		b: "u32",
		c: "u16",
	},
	Optimized: {
		x: "u8",
		y: "u32",
		z: "u8",
	},
	Mac: "u8[] == 6",
	Choice: "u8 | Simple",

	// Structural inference fixtures
	SimpleUser: {
		id: "0 <= number <= 1000",
		age: "0 <= number <= 120",
		balance: "-5000 <= number <= 5000",
		isAdmin: "boolean",
	},
	LargeValue: "bigint",
});
