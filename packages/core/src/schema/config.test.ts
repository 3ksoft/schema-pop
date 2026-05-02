/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { parseSchemaFilename } from "./config";

describe("parseSchemaFilename", () => {
	test("strips .pop segment when present", () => {
		expect(parseSchemaFilename("konektor.pop.ts")).toEqual({
			schemaName: "konektor",
			version: "1",
		});
		expect(parseSchemaFilename("konektor.1.0.pop.ts")).toEqual({
			schemaName: "konektor",
			version: "1.0",
		});
	});

	test("accepts plain .ts / .tsx without .pop convention", () => {
		expect(parseSchemaFilename("konektor.ts")).toEqual({
			schemaName: "konektor",
			version: "1",
		});
		expect(parseSchemaFilename("konektor.tsx")).toEqual({
			schemaName: "konektor",
			version: "1",
		});
		expect(parseSchemaFilename("konektor.1.0.ts")).toEqual({
			schemaName: "konektor",
			version: "1.0",
		});
		expect(parseSchemaFilename("wire.0.0.728.ts")).toEqual({
			schemaName: "wire",
			version: "0.0.728",
		});
	});

	test("absolute path resolves on basename", () => {
		expect(parseSchemaFilename("/abs/path/foo.pop.ts")).toEqual({
			schemaName: "foo",
			version: "1",
		});
		expect(parseSchemaFilename("/abs/path/foo.ts")).toEqual({
			schemaName: "foo",
			version: "1",
		});
	});

	test("rejects empty / dotfile basenames", () => {
		expect(parseSchemaFilename(".ts")).toBeNull();
		expect(parseSchemaFilename(".pop.ts")).toBeNull();
		expect(parseSchemaFilename("foo.")).toBeNull();
	});
});
