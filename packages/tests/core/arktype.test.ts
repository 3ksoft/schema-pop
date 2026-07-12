import { describe, it, expect } from "bun:test";
import { type } from "arktype";
import { toArktype, fromModule } from "../../core/src/arktype";
import { PopType } from "@schema-pop/schema";
import { $ } from "../vault/analyzer-test.1";

describe("ArkType Codec: toArktype (Encoder)", () => {
	it("encodes a number with bounds and step", () => {
		const def = PopType.assert({
			popKind: "rich",
			label: "TestNumber",
			type: "number",
			min: 0,
			max: 100,
			step: 5,
		});
		const t = toArktype(def);

		expect(t(50) instanceof type.errors).toBe(false);
		expect(t(0) instanceof type.errors).toBe(false);
		expect(t(100) instanceof type.errors).toBe(false);

		// Out of bounds
		expect(t(-1) instanceof type.errors).toBe(true);
		expect(t(101) instanceof type.errors).toBe(true);

		// Step mismatch
		expect(t(52) instanceof type.errors).toBe(true);
	});

	it("encodes a string with constraints", () => {
		const def: PopType = {
			popKind: "rich",
			label: "TestString",
			type: "string",
			minLength: 3,
			maxLength: 5,
			pattern: "^[a-z]+$",
		};
		const t = toArktype(def);

		expect(t("abc") instanceof type.errors).toBe(false);
		expect(t("hello") instanceof type.errors).toBe(false);

		// Constraints violated
		expect(t("ab") instanceof type.errors).toBe(true); // length < 3
		expect(t("abcdef") instanceof type.errors).toBe(true); // length > 5
		expect(t("ABC") instanceof type.errors).toBe(true); // pattern mismatch
	});

	it("encodes objects with optional fields", () => {
		const def: PopType = {
			popKind: "rich",
			label: "TestObject",
			type: "object",
			fields: {
				name: { popKind: "rich", label: "name", type: "string" },
				age: { popKind: "rich", label: "age", type: "number", required: false },
			},
		};
		const t = toArktype(def);

		expect(t({ name: "Alice" }) instanceof type.errors).toBe(false);
		expect(t({ name: "Alice", age: 30 }) instanceof type.errors).toBe(false);

		expect(t({ age: 30 }) instanceof type.errors).toBe(true); // missing required 'name'
		expect(t({ name: 123 }) instanceof type.errors).toBe(true); // wrong type
	});

	it("encodes enums correctly", () => {
		const def: PopType = {
			popKind: "rich",
			label: "TestEnum",
			type: "enum",
			options: ["A", "B", "C"],
		};
		const t = toArktype(def);

		expect(t("A") instanceof type.errors).toBe(false);
		expect(t("D") instanceof type.errors).toBe(true);
	});
});

describe("ArkType Codec: fromModule (Module decoder)", () => {
	it("decodes a full ArkType module into PopSchema", () => {
		const { schema } = fromModule($.export() as any);

		expect(schema).toBeDefined();
		expect(schema.types).toBeDefined();

		// Check Simple
		const simple = schema.types["Simple"] as any;
		expect(simple).toBeDefined();
		expect(simple.type).toBe("object");
		expect(simple.fields["a"].type).toBe("number");
		expect(simple.fields["a"].binaryType).toBe("u8");

		// Check SimpleUser constraints
		const simpleUser = schema.types["SimpleUser"] as any;
		expect(simpleUser).toBeDefined();
		expect(simpleUser.type).toBe("object");

		const ageField = simpleUser.fields["age"];
		expect(ageField.type).toBe("number");
		expect(ageField.min).toBe(0);
		expect(ageField.max).toBe(120);

		const balanceField = simpleUser.fields["balance"];
		expect(balanceField.min).toBe(-5000);
		expect(balanceField.max).toBe(5000);
	});
});
