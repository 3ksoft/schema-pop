import { scope, type } from "arktype";

/**
 * Base binary scope containing all fixed-width primitives.
 *
 * `size` is ALWAYS expressed in bytes.
 * `bitSize` is the number of meaningful bits when smaller than the
 * underlying storage unit.
 */

const u1 = type("0 <= number <= 1").configure({
	size: 1,
	align: 1,
	bitSize: 1,
	description: "unsigned 1-bit integer",

	isBinary: true,
	binaryType: "u1",
});

const u2 = type("0 <= number <= 3").configure({
	size: 1,
	align: 1,
	bitSize: 2,
	description: "unsigned 2-bit integer",

	isBinary: true,
	binaryType: "u2",
});

const u3 = type("0 <= number <= 7").configure({
	size: 1,
	align: 1,
	bitSize: 3,
	description: "unsigned 3-bit integer",

	isBinary: true,
	binaryType: "u3",
});

const u4 = type("0 <= number <= 15").configure({
	size: 1,
	align: 1,
	bitSize: 4,
	description: "unsigned 4-bit integer",

	isBinary: true,
	binaryType: "u4",
});

const u5 = type("0 <= number <= 31").configure({
	size: 1,
	align: 1,
	bitSize: 5,
	description: "unsigned 5-bit integer",

	isBinary: true,
	binaryType: "u5",
});

const u6 = type("0 <= number <= 63").configure({
	size: 1,
	align: 1,
	bitSize: 6,
	description: "unsigned 6-bit integer",

	isBinary: true,
	binaryType: "u6",
});

const u7 = type("0 <= number <= 127").configure({
	size: 1,
	align: 1,
	bitSize: 7,
	description: "unsigned 7-bit integer",

	isBinary: true,
	binaryType: "u7",
});

const u8 = type("0 <= number <= 255").configure({
	size: 1,
	align: 1,
	bitSize: 8,
	description: "unsigned 8-bit integer",

	isBinary: true,
	binaryType: "u8",
});

const i8 = type("-128 <= number <= 127").configure({
	size: 1,
	align: 1,
	bitSize: 8,
	description: "signed 8-bit integer",

	isBinary: true,
	binaryType: "i8",
});

const u16 = type("0 <= number <= 65535").configure({
	size: 2,
	align: 2,
	bitSize: 16,
	description: "unsigned 16-bit integer",

	isBinary: true,
	binaryType: "u16",
});

const i16 = type("-32768 <= number <= 32767").configure({
	size: 2,
	align: 2,
	bitSize: 16,
	description: "signed 16-bit integer",

	isBinary: true,
	binaryType: "i16",
});

const u32 = type("0 <= number <= 4294967295").configure({
	size: 4,
	align: 4,
	bitSize: 32,
	description: "unsigned 32-bit integer",

	isBinary: true,
	binaryType: "u32",
});

const i32 = type("-2147483648 <= number <= 2147483647").configure({
	size: 4,
	align: 4,
	bitSize: 32,
	description: "signed 32-bit integer",

	isBinary: true,
	binaryType: "i32",
});

const u64 = type("bigint").configure({
	size: 8,
	align: 8,
	bitSize: 64,
	description: "unsigned 64-bit integer",

	isBinary: true,
	binaryType: "u64",
});

const i64 = type("bigint").configure({
	size: 8,
	align: 8,
	bitSize: 64,
	description: "signed 64-bit integer",

	isBinary: true,
	binaryType: "i64",
});

const u128 = type("bigint").configure({
	size: 16,
	align: 8,
	bitSize: 128,
	description: "unsigned 128-bit integer",

	isBinary: true,
	binaryType: "u128",
});

const i128 = type("bigint").configure({
	size: 16,
	align: 8,
	bitSize: 128,
	description: "signed 128-bit integer",

	isBinary: true,
	binaryType: "i128",
});

const f32 = type("number").configure({
	size: 4,
	align: 4,
	bitSize: 32,
	description: "32-bit float",

	isBinary: true,
	binaryType: "f32",
});

const f64 = type("number").configure({
	size: 8,
	align: 8,
	bitSize: 64,
	description: "64-bit float",

	isBinary: true,
	binaryType: "f64",
});

export const binary = scope({
	u1,
	u2,
	u3,
	u4,
	u5,
	u6,
	u7,
	u8,
	i8,
	u16,
	i16,
	u32,
	i32,
	i64,
	u64,
	i128,
	u128,
	f32,
	f64,
});