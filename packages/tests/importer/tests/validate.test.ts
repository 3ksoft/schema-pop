import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "arktype";
import { importFile } from "@schema-pop/importer";
import { WalkResult } from "@schema-pop/importer";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

describe("Validation of importer output against ArkType schema", () => {
	const langs = [
		{ name: "C", file: "source.c" },
		{ name: "Rust", file: "source.rs" },
		{ name: "TypeScript", file: "source.ts", lang: "typescript" },
		{ name: "Python", file: "source.py" },
		{ name: "Java", file: "source.java" },
		{ name: "Go", file: "source.go" },
		{ name: "Swift", file: "source.swift" },
		{ name: "Dart", file: "source.dart" },
		{ name: "Kotlin", file: "source.kt" },
		{ name: "Scala", file: "source.scala" },
		{ name: "Elixir", file: "source.ex" },
		{ name: "PHP", file: "source.php" },
		{ name: "C++", file: "source.cpp" },
		{ name: "C#", file: "source.cs" },
		{ name: "Objective-C", file: "source.m" },
	];

	for (const { name, file, lang } of langs) {
		test(`validate ${name}`, async () => {
			const r = await importFile(path.join(fixturesDir, file), {
				lang: lang as any,
			});

			const validation = WalkResult(r);
			if (validation instanceof type.errors) {
				console.error(`Validation errors for ${name}:`, validation.summary);
			}
			// if(!fs.existsSync("packages/treesitter-importer/tests/output"))
			// fs.mkdirSync("packages/treesitter-importer/tests/output")
			// fs.writeFileSync(`packages/treesitter-importer/tests/output/from_${file}.json`, JSON.stringify(validation ,null, 2))

			expect(validation instanceof type.errors).toBe(false);

			// Tworzymy snapshot, żeby łatwo śledzić co dokładnie generator wypluwa
			expect(r).toMatchSnapshot();
		});
	}
});
