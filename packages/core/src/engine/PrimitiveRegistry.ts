import type { Field } from "@schema-pop/schema";

export function getBuiltinPrimitive(name: string): Field | undefined {
	if (name === "bool")
		return {
			kind: "primitive",
			name: "bool",
			size: 1,
			align: 1,
			paddedSize: 1,
			bitSize: 8,
			unsigned: true,
			popKind: "binary",
		};
	const match = name.match(/^([ui])(\d+)$/);
	if (match) {
		const bits = parseInt(match[2]!, 10);
		if (bits < 8) {
			return {
				kind: "primitive",
				name,
				size: 1,
				align: 1,
				paddedSize: 1,
				bitSize: bits,
				unsigned: name.startsWith("u"),
				isFloat: false,
				popKind: "bitwise",
			};
		}
		if ([8, 16, 32, 64, 128].includes(bits)) {
			const bytes = bits / 8;
			return {
				kind: "primitive",
				name,
				size: bytes,
				align: bytes,
				paddedSize: bytes,
				bitSize: bits,
				unsigned: name.startsWith("u"),
				isFloat: false,
				popKind: "binary",
			};
		}
	}
	const fMatch = name.match(/^f(32|64)$/);
	if (fMatch) {
		const bytes = parseInt(fMatch[1]!, 10) / 8;
		return {
			kind: "primitive",
			name,
			size: bytes,
			align: bytes,
			paddedSize: bytes,
			bitSize: bytes * 8,
			unsigned: false,
			isFloat: true,
			popKind: "binary",
		};
	}
	return undefined;
}
