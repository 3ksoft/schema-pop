/// <reference types="@types/bun" />
import { describe, test, expect } from "bun:test";
import { scope } from "arktype";
import { binary } from "@schema-pop/schema";
import { tsCodec } from "@schema-pop/exporter";
import { analyze } from "./utils";

function gen(s: any) {
	return tsCodec({ dest: "out.ts" }).generate(
		analyze(scope({ ...binary.import(), ...s }), "v1"),
	);
}

describe("tsCodec — bitfields", () => {
	test("deserialize reads each field with shift + mask", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		expect(out).toMatch(/getUint8[^)]*\)\s*>>\s*0\)\s*&\s*1/);  // a: u1 at bitOffset 0
		expect(out).toMatch(/getUint8[^)]*\)\s*>>\s*1\)\s*&\s*7/);  // b: u3 at bitOffset 1
		expect(out).toMatch(/getUint8[^)]*\)\s*>>\s*4\)\s*&\s*15/); // c: u4 at bitOffset 4
	});

	test("serialize emits one setUint8 per packed byte, not per field", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		const setCount = (out.match(/setUint8/g) ?? []).length;
		expect(setCount).toBe(1);
	});

	test("serialize packs all same-byte fields with bit OR", () => {
		const out = gen({ Flags: { a: "u1", b: "u3", c: "u4" } });
		expect(out).toMatch(/_b0\s*\|=.*val\.a.*<<\s*0/);
		expect(out).toMatch(/_b0\s*\|=.*val\.b.*<<\s*1/);
		expect(out).toMatch(/_b0\s*\|=.*val\.c.*<<\s*4/);
	});

	test("fields spanning two bytes get separate setUint8 calls", () => {
		// u5 + u5 = 10 bits → byte 0 and byte 1
		const out = gen({ Wide: { x: "u5", y: "u5" } });
		const setCount = (out.match(/setUint8/g) ?? []).length;
		expect(setCount).toBe(2);
		expect(out).toMatch(/_b0/);
		expect(out).toMatch(/_b1/);
	});

	test("mixed struct: bitfields and normal fields coexist", () => {
		const out = gen({ S: { flag: "u1", id: "u32" } });
		expect(out).toMatch(/getUint8[^)]*\)\s*>>\s*0\)\s*&\s*1/); // flag bit read
		expect(out).toMatch(/getUint32/); // id regular read
		expect(out).toMatch(/setUint8/); // flag bit write
		expect(out).toMatch(/setUint32/); // id regular write
	});
});
