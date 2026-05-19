import { describe, expect, it } from "bun:test";
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import type {
	AliasPlan,
	PrimitiveField,
	StructPlan,
	TypePlan,
} from "@schema-pop/schema";
import { $ } from "../vault/analyzer-test.1.pop";

function getStruct(planTypes: TypePlan[], name: string): StructPlan {
	const found = planTypes.find((t) => t.name === name);
	if (!found || found.kind !== "struct") {
		throw new Error(
			`Expected ${name} to be a StructPlan, but found ${found?.kind}`,
		);
	}
	return found;
}

function getPrimitiveField(
	struct: StructPlan,
	fieldName: string,
): PrimitiveField {
	const field = struct.fields.find((f) => f.name === fieldName);
	if (!field) {
		throw new Error(`Field ${fieldName} not found in struct ${struct.name}`);
	}
	if (field.type.kind !== "primitive") {
		throw new Error(
			`Field ${fieldName} in ${struct.name} is not primitive (got ${field.type.kind})`,
		);
	}
	return field.type;
}

describe("SchemaAnalyzer Structural Inference", () => {
	const schema = fromModule($);
	const analyzer = new SchemaAnalyzer();
	const plan = analyzer.analyze(schema, { version: "1.0.0" });

	it("should infer correct primitives for SimpleUser", () => {
		const user = getStruct(plan.types, "SimpleUser");

		const idType = getPrimitiveField(user, "id");
		expect(idType.name).toBe("u16");
		expect(idType.size).toBe(2);

		const ageType = getPrimitiveField(user, "age");
		expect(ageType.name).toBe("u8");
		expect(ageType.size).toBe(1);

		const balanceType = getPrimitiveField(user, "balance");
		expect(balanceType.name).toBe("i16");
		expect(balanceType.size).toBe(2);

		const adminType = getPrimitiveField(user, "isAdmin");
		expect(adminType.name).toBe("bool");
		expect(adminType.size).toBe(1);
	});

	it("should infer bitwise fields for Permissions", () => {
		const perms = getStruct(plan.types, "Permissions");

		const canReadType = getPrimitiveField(perms, "canRead");
		expect(canReadType.name).toBe("u1");
		expect(canReadType.popKind).toBe("bitwise");

		const levelType = getPrimitiveField(perms, "level");
		expect(levelType.name).toBe("u2");
		expect(levelType.popKind).toBe("bitwise");
	});

	it("should infer i64 for LargeValue alias", () => {
		const alias = plan.types.find((t) => t.name === "LargeValue");

		expect(alias?.kind).toBe("alias");
		const aliasPlan = alias as AliasPlan;

		expect(aliasPlan.type.kind).toBe("primitive");
		const prim = aliasPlan.type as PrimitiveField;

		expect(prim.name).toBe("i64");
		expect(prim.size).toBe(8);
	});
});
