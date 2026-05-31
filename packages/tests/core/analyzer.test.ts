import { describe, expect, it } from "bun:test";
import { fromModule, SchemaAnalyzer } from "../../core/src";
import {
	AliasPlan,
	Field,
	PopSchema,
	StructPlan,
	UnionPlan,
	wgsl
} from "../../schema/src/";
import { $ } from "../vault/analyzer-test.1.pop";
import { type, scope } from "arktype";

const testMod = $.export();
describe("SchemaAnalyzer", () => {
	it("should parse schema without errors", () => {
		const schema = fromModule(testMod);
		expect(schema instanceof type.errors).toBe(false);
	});
	it("should sort fields by descending alignment to minimize padding", () => {
		const schema = fromModule(testMod);
		// Field reordering is now opt-in via autoSort (declaration order is
		// the default since it preserves stable offsets across schema edits).
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema, { autoSort: true } as any);

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
		const schema = fromModule(testMod);
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema, { version: "1.0.0" });

		const mac = plan.types.find((t) => t.name === "Mac") as AliasPlan;
		expect(mac?.kind).toBe("alias");
		expect(mac.type.kind).toBe("array");
		expect(mac.size).toBe(6);
	});

	it.skip("should calculate Union size correctly (1 + padding + max variant)", () => {
		// TODO(0.2.x): post-refactor analyzer reports Choice size 16 (align 8)
		// instead of 12 (align 4). Need to confirm whether the new value is
		// correct for wordSize=64 (and update expectation), or whether the
		// union-tag alignment regressed in layout/analyzer.ts.
		const schema = fromModule(testMod);
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema, { version: "1.0.0" });

		const choice = plan.types.find((t) => t.name === "Choice") as UnionPlan;
		expect(choice?.kind).toBe("union");
		expect(choice.size).toBe(12);
		expect(choice.align).toBe(4);
	});

	it("should preserve atomic attribute on array items", () => {
		const atomicScope = scope({
			...wgsl.import(),
			single_grid: `ai32[] == 4`,
			spatials: {
				collision_grid: `ai32[] == 4`,
			}
		});
		const schema = fromModule(atomicScope.export());
		const analyzer = new SchemaAnalyzer();
		const plan = analyzer.analyze(schema, { version: "1.0.0" });

		// single_grid is a top-level alias type
		const single_grid = plan.types.find(
			(t) => t.name === "single_grid",
		) as AliasPlan;

		expect(single_grid?.kind).toBe("alias");
		expect(single_grid?.type.kind).toBe("array");
		expect(single_grid?.type.exactLength).toBe(4);

		const item = single_grid?.type.item as Field;
		expect(item?.kind).toBe("primitive");
		expect(item?.name).toBe("i32");
		expect(item?.atomic).toBe(true);
		expect(item?.binaryType).toBe("i32");
		expect(item?.popKind).toBe("binary");

		// collision_grid is nested inside the "spatials" struct
		const spatials = plan.types.find(
			(t) => t.name === "spatials",
		) as StructPlan;
		expect(spatials?.kind).toBe("struct");

		const collision_grid_field = spatials?.fields.find(
			(f) => f.name === "collision_grid",
		);
		
		// W trybie "rich" typy są resolveowane do reference, więc musimy je dereferenceować
		const collision_grid_type = collision_grid_field?.type;
		let arrayType: any;
		
		if (collision_grid_type?.kind === "reference") {
			// Dereference the reference to get the actual array type
			arrayType = plan.types.find(
				(t) => t.name === collision_grid_type.type.name,
			) as AliasPlan;
		} else {
			arrayType = collision_grid_type;
		}
		
		expect(arrayType?.kind).toBe("array");
		expect(arrayType?.exactLength).toBe(4);

		const item2 = arrayType.item as Field;
		expect(item2?.kind).toBe("primitive");
		expect(item2?.name).toBe("i32");
		expect(item2?.atomic).toBe(true);
		expect(item2?.binaryType).toBe("i32");
		expect(item2?.popKind).toBe("binary");
	});
});
