/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkCppFile } from "./walk-cpp";
import { emitArktypeScope } from "./emit";

async function ir(src: string) {
	const tree = await parseSource("cpp", src);
	return walkCppFile(tree, "<test>");
}

describe("c++ importer — IR extraction", () => {
	test("plain struct", async () => {
		const r = await ir(`
            struct Battery {
                uint32_t voltage_mv;
                int32_t current_ma;
            };
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.name).toBe("Battery");
		expect(it.fields).toHaveLength(2);
	});

	test("class with private members → only public emitted", async () => {
		const r = await ir(`
            class Bundle {
            public:
                uint32_t id;
                float scale;
            private:
                int internal_only;
            };
        `);
		const it = r.items[0]!;
		if (it.kind !== "struct") throw new Error();
		expect(it.fields.map((f) => f.name)).toEqual(["id", "scale"]);
		expect(it.fields.find((f) => f.name === "internal_only")).toBeUndefined();
	});

	test("namespace items are surfaced flat", async () => {
		const r = await ir(`
            namespace okon {
                struct Battery { uint32_t v; };
                struct Other { uint8_t x; };
            }
        `);
		expect(r.items.map((i) => i.name).sort()).toEqual(["Battery", "Other"]);
	});

	test("using alias (= type)", async () => {
		const r = await ir(`using DeviceId = uint32_t;`);
		const it = r.items[0]!;
		if (it.kind !== "alias") throw new Error();
		expect(it.name).toBe("DeviceId");
		expect(it.type).toEqual({ kind: "primitive", name: "u32" });
	});

	test("template struct silently skipped", async () => {
		const r = await ir(`
            template <typename T>
            struct Wrapper { T value; };
            struct Battery { uint32_t v; };
        `);
		// Wrapper should not appear in items; Battery should.
		expect(r.items.map((i) => i.name)).toEqual(["Battery"]);
	});

	test("enum class with underlying type", async () => {
		const r = await ir(`
            enum class Status : uint8_t {
                Idle, Active, Error
            };
        `);
		const it = r.items[0]!;
		if (it.kind !== "enum") throw new Error();
		expect(it.name).toBe("Status");
		expect(it.variants.map((v) => v.name)).toEqual([
			"Idle",
			"Active",
			"Error",
		]);
	});

	test("end-to-end emit", async () => {
		const r = await ir(`
            namespace okon {
                struct Battery {
                    uint32_t voltage_mv;
                };
                using DeviceId = uint32_t;
            }
        `);
		const out = emitArktypeScope(r);
		expect(out).toContain("Battery: {");
		expect(out).toContain('voltage_mv: "u32"');
		expect(out).toContain('DeviceId: "u32"');
	});
});
