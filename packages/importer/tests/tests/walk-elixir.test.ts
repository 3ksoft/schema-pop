import { describe, expect, test } from "bun:test";
import { importSource } from "@schema-pop/importer";

async function ir(src: string) {
	return await importSource(src, "elixir");
}

describe("elixir importer", () => {
	test("typed struct extracts fields with primitive mapping", async () => {
		const r = await ir(`
            defmodule Telemetry do
                @type t :: %__MODULE__{
                    uptime: integer(),
                    status: String.t(),
                    flags: [integer]
                }
            end
        `);
		expect(Object.keys(r.items)).toHaveLength(1);
		const s = r.items["Telemetry"]!;
		expect(s.type).toBe("object");
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["uptime", "status", "flags"]);
			expect(s.fields["uptime"]).toMatchObject({
				type: "number",
				binaryType: "i64",
			});
			expect(s.fields["status"]).toMatchObject({ type: "string" });
			expect(s.fields["flags"]).toMatchObject({
				type: "array",
				item: { type: "number", binaryType: "i64" },
			});
		}
	});

	test("fallback to defstruct without types", async () => {
		const r = await ir(`
            defmodule Config do
                defstruct [items: [], tag: nil]
            end
        `);
		const s = r.items["Config"]!;
		if (s.type === "object") {
			expect(Object.keys(s.fields)).toEqual(["items", "tag"]);
			expect(s.fields["items"]).toMatchObject({
				type: "any",
				originalType: "any",
			});
		}
	});
});
