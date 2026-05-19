import { describe, expect, it } from "bun:test";
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import type {
	AliasPlan,
	PopSchema,
	StructPlan,
	UnionPlan,
} from "@schema-pop/schema";
import { $ } from "../vault/analyzer-test.1.pop";
import { type } from "arktype";

describe("SchemaAnalyzer", () => {
	it("should parse schema without errors", () => {
		const schema = fromModule($);
		expect(schema instanceof type.errors).toBe(false);
	});
	it("should sort fields by descending alignment to minimize padding", () => {
		const schema = fromModule($) as PopSchema;
		schema.mode = "rich";
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema);

		const opt = plan.types.find((t) => t.name === "Optimized") as StructPlan;
		expect(opt?.kind).toBe("struct");
		// u32 (y) should be first
		expect(opt.fields[0]!.name).toBe("y");
		expect(opt.fields[0]!.offset).toBe(0);
		// x and z follow
		expect(opt.fields[1]!.name).toBe("x");
		expect(opt.fields[1]!.offset).toBe(4);
		expect(opt.fields[2]!.name).toBe("z");
		expect(opt.fields[2]!.offset).toBe(5);
		// Size: 4 (y) + 1 (x) + 1 (z) = 6. Align 4 -> 8.
		expect(opt.size).toBe(8);
	});

	it("should resolve fixed-size arrays without recursion loops", () => {
		const schema = fromModule($);
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema, { version: "1.0.0" });

		const mac = plan.types.find((t) => t.name === "Mac") as AliasPlan;
		expect(mac?.kind).toBe("alias");
		expect(mac.type.kind).toBe("array");
		expect(mac.size).toBe(6);
	});

	it("should calculate Union size correctly (1 + padding + max variant)", () => {
		const schema = fromModule($);
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema, { version: "1.0.0" });

		const choice = plan.types.find((t) => t.name === "Choice") as UnionPlan;
		expect(choice?.kind).toBe("union");
		// Tag(1) + AlignPad(3) + Simple(8) = 12. Align 4.
		expect(choice.size).toBe(12);
		expect(choice.align).toBe(4);
	});
});
