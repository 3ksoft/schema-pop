import { describe, expect, test } from "bun:test";
import { wgsl } from "@schema-pop/schema";
import { scope } from "arktype";
import {
  createInterpretedCodec,
  createRuntimeCodec,
  fromModule,
  SchemaAnalyzer,
} from "../src";

describe("fixed arrays and struct codecs", () => {
  test("preserves explicit WGSL vector alignment through matrix arrays", () => {
    const { plan } = new SchemaAnalyzer().analyze(wgsl.export(), {
      layout: "std430",
      mode: "binary",
    });
    const vec3 = plan.types.find((type) => type.name === "vec3f");
    const mat3 = plan.types.find((type) => type.name === "mat3x3f");
    expect(vec3).toMatchObject({ size: 12, align: 16, paddedSize: 16 });
    expect(mat3).toMatchObject({ size: 48, align: 16, paddedSize: 48 });
  });

  const $ = scope({
    ...wgsl.import(),
    Mode: "'prefill' | 'decode' | 'continuation'",
    OpParams: {
      value: "u32 = 0",
      mode: "Mode = 'prefill'",
      f0: "f32 = 0",
      reserved: ["u32[] == 48", "=", () => new Array(48).fill(0)],
    },
  });

  test("preserves fixed arrays through extraction and std430 layout", () => {
    const extracted = fromModule($.export());
    expect(extracted.errors).toEqual([]);
    const op = extracted.schema.types.OpParams;
    expect(op.type).toBe("object");
    if (op.type !== "object") return;
    expect(op.fields.reserved.type).toBe("array");
    if (op.fields.reserved.type !== "array") return;
    expect(op.fields.reserved.exactLength).toBe(48);

    const { plan } = new SchemaAnalyzer().analyze($.export(), {
      layout: "std430",
      mode: "binary",
      autoSort: true,
    });
    const struct = plan.types.find((type) => type.name === "OpParams");
    expect(struct?.kind).toBe("struct");
    if (struct?.kind !== "struct") return;
    const reserved = struct.fields.find((field) => field.name === "reserved");
    expect(reserved?.size).toBe(48 * 4);
  });

  test("JIT and CSP codecs distinguish full fields from packed bitfields", () => {
    const { plan } = new SchemaAnalyzer().analyze($.export(), {
      layout: "std430",
      mode: "binary",
      autoSort: true,
    });
    const struct = plan.types.find((type) => type.name === "OpParams");
    expect(struct?.kind).toBe("struct");
    if (struct?.kind !== "struct") return;

    const offsets = Object.fromEntries(struct.fields.map((field) => [field.name, field.offset]));
    const value = $.export().OpParams.assert({ mode: "decode", f0: 1.5, value: 7 });

    for (const suite of [createRuntimeCodec(plan), createInterpretedCodec(plan)]) {
      const view = new DataView(new ArrayBuffer(struct.paddedSize));
      suite.get("OpParams").serialize(value, view);
      expect(view.getUint32(offsets.value!, true)).toBe(7);
      expect(view.getFloat32(offsets.f0!, true)).toBe(1.5);
      expect(view.getUint8(offsets.mode!)).toBe(1);
      expect(suite.get<any>("OpParams").deserialize(view).mode).toBe("decode");
    }
  });
});
