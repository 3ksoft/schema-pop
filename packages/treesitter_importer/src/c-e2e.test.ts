/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { SchemaAnalyzer, scope, binary } from "schema-pop";
import { parseSource } from "./parser";
import { walkCFile } from "./walk-c";
import { walkCppFile } from "./walk-cpp";
import { emitArktypeScope } from "./emit";

describe("C/C++ importer — round-trip into schema-pop analyzer", () => {
	test("C: typedef-struct + typedef-enum + alias produce correct binary layout", async () => {
		const tree = await parseSource(
			"c",
			`
            typedef struct {
                uint32_t voltage_mv;
                int32_t current_ma;
                uint8_t flags;
            } Battery;
            typedef struct {
                uint8_t bytes[16];
            } Serial;
            typedef enum {
                Idle, Active, Error
            } Status;
            typedef uint32_t DeviceId;
        `,
		);
		const ir = walkCFile(tree, "<test>");
		const out = emitArktypeScope(ir);
		expect(out).toContain("Battery: {");

		const $ = scope({
			...binary.import(),
			Battery: {
				voltage_mv: "u32",
				current_ma: "i32",
				flags: "u8",
			},
			Serial: { bytes: "u8[] == 16" },
			Status: "'Idle' | 'Active' | 'Error'",
			DeviceId: "u32",
		});
		const plan = new SchemaAnalyzer($, {
			wordSize: 64,
			autoLayout: false,
			layoutType: "aligned",
			mode: "binary",
		}).analyze("v1", "le");

		const battery = plan.types.find((t: any) => t.name === "Battery");
		expect(battery?.size).toBe(12);
		expect(battery?.align).toBe(4);
		const serial = plan.types.find((t: any) => t.name === "Serial");
		expect(serial?.size).toBe(16);
		const status = plan.types.find((t: any) => t.name === "Status");
		expect(status?.kind).toBe("enum");
		expect(status?.size).toBe(1);
	});

	test("C++: namespace + class with private members + using alias", async () => {
		const tree = await parseSource(
			"cpp",
			`
            namespace okon {
                struct Battery {
                    uint32_t voltage_mv;
                    uint8_t flags;
                };
                class Bundle {
                public:
                    Battery battery;
                    float scale;
                private:
                    int hidden;
                };
                using DeviceId = uint32_t;
            }
        `,
		);
		const ir = walkCppFile(tree, "<test>");
		const names = ir.items.map((i) => i.name).sort();
		expect(names).toEqual(["Battery", "Bundle", "DeviceId"]);

		const bundle = ir.items.find((i) => i.name === "Bundle");
		if (!bundle || bundle.kind !== "struct") throw new Error();
		expect(bundle.fields.map((f) => f.name)).toEqual(["battery", "scale"]);

		const $ = scope({
			...binary.import(),
			Battery: { voltage_mv: "u32", flags: "u8" },
			Bundle: { battery: "Battery", scale: "f32" },
			DeviceId: "u32",
		});
		const plan = new SchemaAnalyzer($, {
			wordSize: 64,
			autoLayout: false,
			layoutType: "aligned",
			mode: "binary",
		}).analyze("v1", "le");
		const bundlePlan = plan.types.find((t: any) => t.name === "Bundle");
		// Battery is 8 bytes (u32+u8 + 3B padding to align 4); plus f32 = 12 total, aligned to 4.
		expect(bundlePlan?.size).toBe(12);
		expect(bundlePlan?.align).toBe(4);
	});
});
