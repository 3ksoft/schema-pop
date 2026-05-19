import { scope, type } from "arktype";

/**
 * Base binary scope containing all FFI-safe primitives.
 * Ordered from smallest to largest to support first-match inference.
 * Flattened to avoid compiler issues with too many nested scopes.
 */

const bool = type("boolean").configure({
	size: 1,
	align: 1,
	description: "boolean",
	popKind: "binary",
	isBinary: true,
	binaryType: "bool",
});

const u8 = type("0 <= number <= 255").configure({
	size: 1,
	align: 1,
	description: "unsigned 8-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "u8",
});

const i8 = type("-128 <= number <= 127").configure({
	size: 1,
	align: 1,
	description: "signed 8-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "i8",
});

const u16 = type("0 <= number <= 65535").configure({
	size: 2,
	align: 2,
	description: "unsigned 16-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "u16",
});

const i16 = type("-32768 <= number <= 32767").configure({
	size: 2,
	align: 2,
	description: "signed 16-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "i16",
});

const u32 = type("0 <= number <= 4294967295").configure({
	size: 4,
	align: 4,
	description: "unsigned 32-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "u32",
});

const i32 = type("-2147483648 <= number <= 2147483647").configure({
	size: 4,
	align: 4,
	description: "signed 32-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "i32",
});

const u64 = type("0 <= number <= 18446744073709551615").configure({
	size: 8,
	align: 8,
	description: "unsigned 64-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "u64",
});

const i64 = type(
	"-9223372036854775808 <= number <= 9223372036854775807",
).configure({
	size: 8,
	align: 8,
	description: "signed 64-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "i64",
});

const u128 = type(
	"0 <= number <= 340282366920938463463374607431768211455",
).configure({
	size: 16,
	align: 8,
	description: "unsigned 128-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "u128",
});

const i128 = type(
	"-170141183460469231731687303715884105728 <= number <= 170141183460469231731687303715884105727",
).configure({
	size: 16,
	align: 8,
	description: "signed 128-bit integer",
	popKind: "binary",
	isBinary: true,
	binaryType: "i128",
});

const f32 = type("number").configure({
	size: 4,
	align: 4,
	description: "32-bit float",
	popKind: "binary",
	isBinary: true,
	binaryType: "f32",
});

const f64 = type("number").configure({
	size: 8,
	align: 8,
	description: "64-bit float",
	popKind: "binary",
	isBinary: true,
	binaryType: "f64",
});

const u1 = type("0 <= number <= 1").configure({
	size: 1,
	description: "u1 (boolean)",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u1",
});

const u2 = type("0 <= number <= 3").configure({
	size: 2,
	description: "unsigned 2-bit integer",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u2",
});

const u3 = type("0 <= number <= 7").configure({
	size: 3,
	description: "unsigned 3-bit integer",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u3",
});

const u4 = type("0 <= number <= 15").configure({
	size: 4,
	description: "unsigned 4-bit integer",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u4",
});

const u5 = type("0 <= number <= 31").configure({
	size: 5,
	description: "unsigned 5-bit integer",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u5",
});

const u6 = type("0 <= number <= 63").configure({
	size: 6,
	description: "unsigned 6-bit integer",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u6",
});

const u7 = type("0 <= number <= 127").configure({
	size: 7,
	description: "unsigned 7-bit integer",
	popKind: "bitwise",
	isBinary: true,
	binaryType: "u7",
});

export const binary = scope({
	bool: bool,
	u8: u8,
	i8: i8,
	u16: u16,
	i16: i16,
	u32: u32,
	i32: i32,
	i64: i64,
	u64: u64,
	i128: i128,
	u128: u128,
	f32: f32,
	f64: f64,
	u1: u1,
	u2: u2,
	u3: u3,
	u4: u4,
	u5: u5,
	u6: u6,
	u7: u7,
});
