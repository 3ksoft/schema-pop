import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { wgsl } from "@schema-pop/schema";
import { fromModule, SchemaAnalyzer } from "../../core/src";

describe("fixed arrays from ArkType", () => {
  test("preserves u32[] == N as a PopType array and std430 field", () => {
    const $ = scope({
      ...wgsl.import(),
      OpParams: {
        value: "u32 = 0",
        reserved: ["u32[] == 48", "=", () => new Array(48).fill(0)],
      },
    });

    const extracted = fromModule($.export());
    expect(extracted.errors).toEqual([]);

    const op = extracted.schema.types.OpParams;
    expect(op.type).toBe("object");
    if (op.type !== "object") throw new Error("OpParams did not extract as object");
    const reserved = op.fields.reserved;
    expect(reserved.type).toBe("array");
    if (reserved.type !== "array") throw new Error("reserved did not extract as array");
    expect(reserved.exactLength).toBe(48);
    expect(reserved.item.type).toBe("number");

    const { plan } = new SchemaAnalyzer().analyze($.export(), {
      layout: "std430",
      mode: "binary",
    });
    const opPlan = plan.types.find((t) => t.name === "OpParams");
    expect(opPlan?.size).toBe(196); // 4 B value + 48 * 4 B reserved
  });
});
