import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return importSource(src, "cpp");
}

describe("c++ importer — IR extraction", () => {
	test("plain struct", async () => {
		const r = await ir(`
            struct Battery {
                uint32_t voltage_mv;
                int32_t current_ma;
            };
        `);
		const it = r.items["Battery"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect(Object.keys(it.fields)).toHaveLength(2);
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
		const it = r.items["Bundle"]!;
		expect(it.type).toBe("object");
		if (it.type !== "object") throw new Error();
		expect(Object.keys(it.fields)).toEqual(["id", "scale"]);
		expect(it.fields["internal_only"]).toBeUndefined();
	});

	test("namespace items are surfaced with qualified names", async () => {
		const r = await ir(`
            namespace okon {
                struct Battery { uint32_t v; };
                struct Other { uint8_t x; };
            }
        `);
		const keys = Object.keys(r.items).sort();
		expect(keys).toEqual(["okon::Battery", "okon::Other"]);
	});

	test("using alias (= type)", async () => {
		const r = await ir(`using DeviceId = uint32_t;`);
		const it = r.items["DeviceId"]!;
		expect(it.type).toBe("number");
		if (it.type !== "number") throw new Error();
		expect(it.binaryType).toBe("u32");
	});

	test("template struct silently skipped", async () => {
		const r = await ir(`
            template <typename T>
            struct Wrapper { T value; };
            struct Battery { uint32_t v; };
        `);
		// Wrapper should not appear in items; Battery should.
		expect(Object.keys(r.items)).toEqual(["Battery"]);
		expect(r.skipped.some((s) => s.name === "Wrapper")).toBe(true);
	});

	test("enum class with underlying type", async () => {
		const r = await ir(`
            enum class Status : uint8_t {
                Idle, Active, Error
            };
        `);
		const it = r.items["Status"]!;
		expect(it.type).toBe("enum");
		if (it.type !== "enum") throw new Error();
		expect(it.options).toEqual(["Idle", "Active", "Error"]);
	});
});
