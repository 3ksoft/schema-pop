/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, SchemaAnalyzer } from "schema-pop";
import { jsonSchema } from "./json-schema";

function analyze(s: any, version: string) {
	return new SchemaAnalyzer(s, {
		wordSize: 64,
		autoLayout: false,
		layoutType: "aligned",
		mode: "binary",
	}).analyze(version, "le");
}

describe("jsonSchema exporter", () => {
	test("struct → object schema with required + integer ranges", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Battery: { voltage_mv: "u32", current: "i32" },
			}),
			"v1",
		);
		const exp = jsonSchema({ dest: "x.json" });
		const out = JSON.parse(exp.generate(plan) as string);
		expect(out.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(out.$defs.Battery.type).toBe("object");
		// arktype canonicalises field order alphabetically — match
		// membership, not source order.
		expect(out.$defs.Battery.required.sort()).toEqual([
			"current",
			"voltage_mv",
		]);
		expect(out.$defs.Battery.properties.voltage_mv.type).toBe("integer");
		expect(out.$defs.Battery.properties.voltage_mv.minimum).toBe(0);
		expect(out.$defs.Battery.properties.voltage_mv.maximum).toBe(4294967295);
		expect(out.$defs.Battery.properties.voltage_mv.format).toBe("uint32");
		expect(out.$defs.Battery.properties.current.type).toBe("integer");
		expect(out.$defs.Battery.properties.current.format).toBe("int32");
	});

	test("plain enum → string + enum array", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Status: "'ok' | 'err' | 'busy'",
			}),
			"v1",
		);
		const out = JSON.parse(
			jsonSchema({ dest: "x.json" }).generate(plan) as string,
		);
		expect(out.$defs.Status.type).toBe("string");
		expect([...out.$defs.Status.enum].sort()).toEqual(["busy", "err", "ok"]);
	});

	test("optional fields drop out of `required`, references emit $ref", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Inner: { x: "u8" },
				Outer: {
					a: "Inner",
					"b?": "u16",
				},
			}),
			"v1",
		);
		const out = JSON.parse(
			jsonSchema({ dest: "x.json" }).generate(plan) as string,
		);
		expect(out.$defs.Outer.required).toEqual(["a"]);
		expect(out.$defs.Outer.properties.a.$ref).toBe("#/$defs/Inner");
		expect(out.$defs.Outer.properties.b.type).toBe("integer");
	});

	test("idBase emits $id; pretty:false produces single-line JSON", () => {
		const plan = analyze(scope({ ...binary.import(), Foo: { x: "u8" } }), "v1");
		const out = jsonSchema({
			dest: "x.json",
			idBase: "https://example.com/schemas",
			pretty: false,
		}).generate(plan) as string;
		expect(out.includes("\n\t")).toBe(false);
		const parsed = JSON.parse(out);
		expect(parsed.$id).toBe("https://example.com/schemas/v1.json");
	});

	test("includeExtensions: true forwards schema-pop meta as x-* keys", () => {
		const plan = analyze(
			scope({
				...binary.import(),
				Pin: { idx: "u8", value: "u32" },
			}),
			"v1",
		);
		const out = JSON.parse(
			jsonSchema({
				dest: "x.json",
				includeExtensions: true,
			}).generate(plan) as string,
		);
		// size/align come from the layout pass and should round-trip into
		// the struct's JSON Schema as x-size / x-align.
		expect(typeof out.$defs.Pin["x-size"]).toBe("number");
		expect(typeof out.$defs.Pin["x-align"]).toBe("number");
	});
});
