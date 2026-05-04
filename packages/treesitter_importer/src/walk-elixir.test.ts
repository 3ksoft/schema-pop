import { describe, expect, test } from "bun:test";
import { parseSource } from "./parser";
import { walkElixirFile } from "./walk-elixir";

async function ir(src: string) {
	const tree = await parseSource("elixir", src);
	return walkElixirFile(tree, "test.ex");
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
		expect(r.items).toHaveLength(1);
		const s = r.items[0]!;
		expect(s.kind).toBe("struct");
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual([
				"uptime",
				"status",
				"flags",
			]);
			expect(s.fields[0]!.type).toEqual({ kind: "primitive", name: "i64" });
			expect(s.fields[1]!.type).toEqual({ kind: "string" });
			expect(s.fields[2]!.type).toEqual({
				kind: "array",
				item: { kind: "primitive", name: "i64" },
			});
		}
	});

	test("fallback to defstruct without types", async () => {
		const r = await ir(`
            defmodule Config do
                defstruct [items: [], tag: nil]
            end
        `);
		const s = r.items[0]!;
		if (s.kind === "struct") {
			expect(s.fields.map((f) => f.name)).toEqual(["items", "tag"]);
			expect(s.fields[0]!.type).toEqual({ kind: "unknown", raw: "any" });
		}
	});
});
