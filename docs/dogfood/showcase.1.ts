// Showcase schema — a single fictional "device telemetry protocol"
// that touches every feature schema-pop exposes today. Use this as a
// reference when you want to know what's available (or as a smoke test
// when you ship a new exporter).
//
// Sections, top → bottom:
//   1. Primitive scalars     — u8..u128, i8..i128, f32/f64, bool
//   2. String-literal unions — enums-by-shape
//   3. Bitwise fields        — u1..u7 packed into one byte
//   4. Wrappers              — Describe, Scale, Reserved, Obsolete, Renamed
//   5. Arrays + nesting      — fixed, bounded, optional
//   6. Discriminated union   — `A | B | C` of structs
//
// Every line is intentionally small enough to render as a single block
// in the HTML viewer.

import { schemaPop, popExtensions,binary, scope } from "schema-pop";
import { html } from "@schema-pop/exporter";

export const $ = schemaPop(
	{
		// Showcase HTML doubles as the dogfood landing page.
		targets: [html({ dest: "./index.html" })],
	},
	type.module({
	...binary.import(),
	...popExtensions.export(),

	// 1. PRIMITIVES — full coverage of fixed-width integer + float.
	AllScalars: {
		flag: "bool",
		small_unsigned: "u8",
		small_signed: "i8",
		port: "u16",
		signed_short: "i16",
		count: "u32",
		signed_int: "i32",
		big_count: "u64",
		signed_long: "i64",
		nano_counter: "u128",
		signed_giant: "i128",
		ratio: "f32",
		precise_ratio: "f64",
	},

	// 2. STRING-LITERAL UNIONS — emit as enums in target languages.
	Mode: "'Idle' | 'Active' | 'Error' | 'LowBattery' | 'Charging' | 'Sleep'",
	Severity: "'info' | 'warn' | 'error' | 'fatal'",

	// 3. BITWISE — eight one-bit-to-seven-bit fields packed into a byte.
	//    The exporters lower these to bitfield struct in C, masked u8
	//    accessors in Rust. Sum of widths is verified by the analyzer
	//    (here: 1+3+4 = 8 bits — fits one byte).
	StatusFlags: {
		enabled: "u1",
		mode_bits: "u3",
		retries: "u4",
	},

	// Wider bitwise example: 16 bits split across the spectrum.
	ControlRegister: {
		ready: "u1",
		fault: "u1",
		opcode: "u6",
		channel: "u4",
		priority: "u4",
	},

	// 4. METADATA WRAPPERS — every generic schema-pop ships.
	BatteryInfo: {
		// `Scale<T, factor>` annotates a fixed-point conversion at the
		// codec layer; raw stays u16 on the wire, but consumers see V.
		// `Describe<T, "...">` adds free-form text rendered as a comment.
		voltage: "Describe<Scale<u16, 0.001>, 'volts (mV raw → V scaled)'>",
		current: "Describe<i16, 'milliamps, signed'>",
		charging: "bool",

		// `Reserved<T, N>` declares N elements of type T as padding —
		// shows up as named padding in C output, `_pad: [u8; 3]` in Rust.
		_pad: "Reserved<u8, 3>",

		// `Scale` without Describe — exporter still picks up the factor.
		temperature_c: "Scale<i16, 0.01>",

		// `Obsolete<T, "reason">` keeps the field on the wire (so old
		// readers don't break) but flags it as deprecated in language
		// output (#[deprecated] in Rust, /** @deprecated */ in TS).
		legacy_voltage: "Obsolete<u16, 'use voltage instead — kept for v1 firmware'>",

		// `Renamed<T, "oldName">` records that this field used to have
		// a different name. Migration emitter uses it to generate impl
		// From<v1::Foo> blocks; HTML viewer marks the field "renamed".
		serial_no: "Renamed<u32, 'device_id'>",
	},

	// 5. ARRAYS, NESTING, OPTIONAL.
	Sample: {
		timestamp: "i64",
		value: "Scale<i16, 0.01>",
		precision: "f32",

		// Reference to another type defined in this scope.
		flags: "StatusFlags",

		// Optional: codec emits a presence byte; "?" suffix at the key.
		"note?": "string",
	},

	SampleBatch: {
		count: "u16",
		_pad: "Reserved<u8, 6>",

		// Bounded variable-length array — codec writes a length prefix.
		items: "Sample[]<=64",

		// Fixed-length array — exact element count baked into layout.
		checksum: "u8[] == 16",
	},


	// 6. DISCRIMINATED UNION — exporter generates a tagged variant in
	//    target languages (Rust enum, C tagged struct + union, TS
	//    discriminated union). Each branch must already be a struct in
	//    this scope.
	Heartbeat: {
		uptime: "u64",
		last_seen: "i64",
		drift: "f64",
	},

	Telemetry: "BatteryInfo | SampleBatch | PinnedRegisters | Heartbeat",
}),
);
