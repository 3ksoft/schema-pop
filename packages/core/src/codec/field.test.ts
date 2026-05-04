import { describe, expect, test } from "bun:test";
import { type, scope } from "arktype";
import { fromArktype, getArkType, type FormField } from "./field";

// ── helpers ───────────────────────────────────────────────────────────────────

function roundTrip(field: FormField): FormField {
	return fromArktype(getArkType(field));
}

// ── getArkType ────────────────────────────────────────────────────────────────

// arktype v2: t(value) returns the value on success, ArkErrors on failure
function ok(result: unknown): unknown {
	if (result !== null && typeof result === "object" && " arkKind" in result) {
		throw new Error(`Unexpected validation error: ${(result as any).summary}`);
	}
	return result;
}
function fail(result: unknown): void {
	expect(
		result !== null && typeof result === "object" && " arkKind" in result,
	).toBe(true);
}

describe("getArkType", () => {
	test("string validates strings", () => {
		const t = getArkType({ label: "S", type: "string" });
		expect(ok(t("hello"))).toBe("hello");
		fail(t(42));
	});

	test("number validates numbers with min/max", () => {
		const t = getArkType({ label: "N", type: "number", min: 0, max: 100 });
		expect(ok(t(50))).toBe(50);
		fail(t(-1));
		fail(t(101));
	});

	test("boolean validates booleans", () => {
		const t = getArkType({ label: "B", type: "boolean" });
		expect(ok(t(true))).toBe(true);
		fail(t("true"));
	});

	test("enum validates string literals", () => {
		const t = getArkType({
			label: "E",
			type: "enum",
			options: ["a", "b", "c"],
		});
		expect(ok(t("a"))).toBe("a");
		fail(t("d"));
	});

	test("array validates arrays of items", () => {
		const t = getArkType({
			label: "A",
			type: "array",
			item: { label: "n", type: "number" },
		});
		expect(ok(t([1, 2, 3]))).toEqual([1, 2, 3]);
		fail(t(["x"]));
	});

	test("array with maxItems enforces length", () => {
		const t = getArkType({
			label: "A",
			type: "array",
			item: { label: "n", type: "number" },
			maxItems: 2,
		});
		expect(ok(t([1, 2]))).toEqual([1, 2]);
		fail(t([1, 2, 3]));
	});

	test("object validates shape", () => {
		const t = getArkType({
			label: "O",
			type: "object",
			fields: {
				name: { label: "name", type: "string" },
				age: { label: "age", type: "number" },
			},
		});
		expect(ok(t({ name: "Alice", age: 30 }))).toEqual({
			name: "Alice",
			age: 30,
		});
		fail(t({ name: "Alice" }));
	});

	test("object with optional field", () => {
		const t = getArkType({
			label: "O",
			type: "object",
			fields: {
				name: { label: "name", type: "string" },
				note: { label: "note", type: "string", required: false } as any,
			},
		});
		expect(ok(t({ name: "Alice" }))).toEqual({ name: "Alice" });
		expect(ok(t({ name: "Alice", note: "hi" }))).toEqual({
			name: "Alice",
			note: "hi",
		});
	});

	test("any accepts anything", () => {
		const t = getArkType({ label: "any", type: "any" });
		expect(ok(t(42))).toBe(42);
		expect(ok(t("str"))).toBe("str");
		expect(ok(t(null))).toBeNull();
	});

	test("description is forwarded", () => {
		const t = getArkType({ label: "S", type: "string", description: "A name" });
		expect(t.description).toBe("A name");
	});
});

// ── fromArktype ───────────────────────────────────────────────────────────────

describe("fromArktype", () => {
	test("string type", () => {
		const f = fromArktype(type("string"), { label: "S" });
		expect(f.type).toBe("string");
	});

	test("number type", () => {
		const f = fromArktype(type("number"), { label: "N" });
		expect(f.type).toBe("number");
	});

	test("boolean type", () => {
		const f = fromArktype(type("boolean"), { label: "B" });
		expect(f.type).toBe("boolean");
	});

	test("string union → enum", () => {
		const f = fromArktype(type("'a' | 'b' | 'c'"), { label: "E" });
		expect(f.type).toBe("enum");
		expect((f as any).options).toEqual(["a", "b", "c"]);
	});

	test("constrained number preserves min/max", () => {
		const f = fromArktype(type("0 <= number <= 100"), { label: "N" }) as any;
		expect(f.type).toBe("number");
		expect(f.min).toBe(0);
		expect(f.max).toBe(100);
	});

	test("constrained string preserves maxLength", () => {
		const f = fromArktype(type("string <= 50"), { label: "S" }) as any;
		expect(f.type).toBe("string");
		expect(f.maxLength).toBe(50);
	});

	test("object type", () => {
		const f = fromArktype(type({ name: "string", age: "number" }), {
			label: "O",
		});
		expect(f.type).toBe("object");
		expect((f as any).fields).toHaveProperty("name");
		expect((f as any).fields).toHaveProperty("age");
	});

	test("array type", () => {
		const f = fromArktype(type("number[]"), { label: "A" });
		expect(f.type).toBe("array");
		expect((f as any).item?.type).toBe("number");
	});

	test("description is recovered", () => {
		const f = fromArktype(type("string").describe("A label"), { label: "S" });
		expect((f as any).description).toBe("A label");
	});

	test("schema-pop meta fields round-trip through configure()", () => {
		const t = type("number").configure({
			SCHEMA_POP_KIND: "binary",
			size: 4,
			align: 4,
			type: "i32",
		} as any);
		const f = fromArktype(t, { label: "F" }) as any;
		expect(f.popKind).toBe("binary");
		expect(f.size).toBe(4);
		expect(f.align).toBe(4);
		expect(f.binaryType).toBe("i32");
	});
});

// ── round-trip ────────────────────────────────────────────────────────────────

describe("FormField round-trip (getArkType → fromArktype)", () => {
	test("string", () => {
		expect(roundTrip({ label: "S", type: "string" }).type).toBe("string");
	});

	test("number with constraints", () => {
		const rt = roundTrip({
			label: "N",
			type: "number",
			min: 1,
			max: 99,
		}) as any;
		expect(rt.type).toBe("number");
		expect(rt.min).toBe(1);
		expect(rt.max).toBe(99);
	});

	test("boolean", () => {
		expect(roundTrip({ label: "B", type: "boolean" }).type).toBe("boolean");
	});

	test("enum options preserved", () => {
		const rt = roundTrip({
			label: "E",
			type: "enum",
			options: ["x", "y"],
		}) as any;
		expect(rt.type).toBe("enum");
		expect(rt.options).toEqual(["x", "y"]);
	});

	test("array with item type", () => {
		const rt = roundTrip({
			label: "A",
			type: "array",
			item: { label: "n", type: "number" },
		}) as any;
		expect(rt.type).toBe("array");
		expect(rt.item?.type).toBe("number");
	});

	test("object preserves fields", () => {
		const rt = roundTrip({
			label: "O",
			type: "object",
			fields: {
				x: { label: "x", type: "string" },
				y: { label: "y", type: "number" },
			},
		}) as any;
		expect(rt.type).toBe("object");
		expect(rt.fields.x.type).toBe("string");
		expect(rt.fields.y.type).toBe("number");
	});

	test("description preserved", () => {
		const rt = roundTrip({
			label: "S",
			type: "string",
			description: "A name",
		} as any) as any;
		expect(rt.description).toBe("A name");
	});

	test("schema-pop binary meta preserved", () => {
		const field: FormField = {
			label: "F",
			type: "number",
			popKind: "binary",
			size: 4,
			align: 4,
			binaryType: "u32",
		} as any;
		const rt = roundTrip(field) as any;
		expect(rt.popKind).toBe("binary");
		expect(rt.size).toBe(4);
		expect(rt.binaryType).toBe("u32");
	});
});

// ── alias registry (scopeExports) ─────────────────────────────────────────────

describe("alias registry — structured aliases become links", () => {
	test("object alias is replaced by link ref", () => {
		const s = scope({
			Address: { street: "string", city: "string" },
			Person: { name: "string", address: "Address" },
		});
		const exported = s.export();
		const f = fromArktype(exported.Person, {
			label: "Person",
			scopeId: "my-schema",
			scopeExports: exported as any,
			aliases: ["Address", "Person"],
			skipName: "Person",
		}) as any;
		expect(f.type).toBe("object");
		expect(f.fields.address.type).toBe("link");
		expect(f.fields.address.target).toBe("#/schemas/my-schema/Address");
	});

	test("primitive alias is inlined, not linked", () => {
		const s = scope({
			Name: "string",
			Person: { name: "Name" },
		});
		const exported = s.export();
		const f = fromArktype(exported.Person, {
			label: "Person",
			scopeId: "my-schema",
			scopeExports: exported as any,
			skipName: "Person",
		}) as any;
		// Name is a primitive alias → inlined as string, not a link
		expect(f.fields.name.type).toBe("string");
	});
});
