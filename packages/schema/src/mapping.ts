import { scope } from "arktype";

export const $logic = scope({
	ScalarType:
		"'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'i8' | 'i16' | 'i32' | 'i64' | 'i128' | 'f32' | 'f64' | 'bool'",

	ReadField: {
		kind: "'ReadField'",
		path: "string[]",
	},

	Literal: {
		kind: "'Literal'",
		value: "string | number | boolean | bigint",
		type: "ScalarType",
	},

	UnaryOp: {
		kind: "'UnaryOp'",
		operator: "'!' | '-' | '~'",
	},

	BinaryOp: {
		kind: "'BinaryOp'",
		operator:
			"'+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '&&' | '||' | '&' | '|' | '^' | '<<' | '>>'",
	},

	/**
	 * Explicit conversion between scalar types.
	 * - 'clamp': Saturates to min/max of target type.
	 * - 'wrap': modulo-style overflow (standard C cast).
	 * - 'strict': throws/fails if value out of range.
	 * - 'lossy': bit-level interpretation (transmute).
	 */
	Convert: {
		kind: "'Convert'",
		target: "ScalarType",
		strategy: "'clamp' | 'wrap' | 'strict' | 'lossy'",
	},

	BuiltInCall: {
		kind: "'BuiltInCall'",
		func: "'abs' | 'min' | 'max' | 'clamp' | 'floor' | 'ceil' | 'round' | 'sqrt' | 'saturate'",
		arity: "number",
	},

	Token: "ReadField | Literal | UnaryOp | BinaryOp | Convert | BuiltInCall",

	Expression: "Token[]",

	FieldAssignment: {
		kind: "'FieldAssignment'",
		targetField: "string",
		value: "Expression",
	},

	MappingProgram: {
		kind: "'MappingProgram'",
		"sourceNamespace?": "string",
		"targetNamespace?": "string",
		assignments: "FieldAssignment[]",
	},
});

export const {
	ScalarType,
	ReadField,
	Literal,
	UnaryOp,
	BinaryOp,
	Convert,
	BuiltInCall,
	Token,
	Expression,
	FieldAssignment,
	MappingProgram,
} = $logic.export();

export type ScalarType = typeof ScalarType.infer;
export type ReadField = typeof ReadField.infer;
export type Literal = typeof Literal.infer;
export type UnaryOp = typeof UnaryOp.infer;
export type BinaryOp = typeof BinaryOp.infer;
export type Convert = typeof Convert.infer;
export type BuiltInCall = typeof BuiltInCall.infer;
export type Token = typeof Token.infer;
export type Expression = typeof Expression.infer;
export type FieldAssignment = typeof FieldAssignment.infer;
export type MappingProgram = typeof MappingProgram.infer;
