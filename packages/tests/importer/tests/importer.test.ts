import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { importFile } from "@schema-pop/importer";

const fixtures = (name: string) =>
	path.resolve(import.meta.dirname, "../fixtures/walk", name);

describe("treesitter importers — consolidated tests", () => {
	test("C importer", async () => {
		const r = await importFile(fixtures("source.c"));
		expect(r.items["Battery"]).toMatchObject({ type: "object" });
		expect(r.items["DeviceStatus"]).toMatchObject({
			type: "enum",
			options: ["DS_IDLE", "DS_ACTIVE", "DS_ERROR"],
		});
		expect(r.items["DeviceId"]).toMatchObject({
			type: "number",
			binaryType: "u32",
		});
		expect(r.items["device_reset"]).toMatchObject({
			type: "function",
			returns: { type: "unit" },
		});
	});

	test("Rust importer", async () => {
		const r = await importFile(fixtures("source.rs"));
		expect(r.items["Battery"]).toMatchObject({ type: "object" });
		expect(r.items["Status"]).toMatchObject({
			type: "enum",
			options: ["Idle", "Active", "Suspended"],
		});
		expect(r.items["add"]).toMatchObject({
			type: "function",
			returns: { type: "number", binaryType: "u32" },
		});
		expect(r.items["cb"]).toMatchObject({ type: "function", abi: "C" });
	});

	test("TypeScript importer", async () => {
		const r = await importFile(fixtures("source.ts"), { lang: "typescript" });
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
		expect(r.items["Severity"]).toMatchObject({ type: "enum" });
		expect(r.items["Either"]).toMatchObject({ type: "any" });
	});

	test("Python importer", async () => {
		const r = await importFile(fixtures("source.py"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
		expect(r.items["Status"]).toMatchObject({ type: "enum" });
	});

	test("Java importer", async () => {
		const r = await importFile(fixtures("source.java"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
		expect(r.items["TelemetryRecord"]).toMatchObject({ type: "object" });
	});

	test("Go importer", async () => {
		const r = await importFile(fixtures("source.go"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
		expect(r.items["DeviceId"]).toMatchObject({
			type: "number",
			binaryType: "u32",
		});
	});

	test("Swift importer", async () => {
		const r = await importFile(fixtures("source.swift"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
		expect(r.items["DeviceId"]).toMatchObject({
			type: "number",
			binaryType: "u32",
		});
	});

	test("Dart importer", async () => {
		const r = await importFile(fixtures("source.dart"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
	});

	test("Kotlin importer", async () => {
		const r = await importFile(fixtures("source.kt"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
	});

	test("Scala importer", async () => {
		const r = await importFile(fixtures("source.scala"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
	});

	test("Elixir importer", async () => {
		const r = await importFile(fixtures("source.ex"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
	});

	test("PHP importer", async () => {
		const r = await importFile(fixtures("source.php"));
		expect(r.items["Telemetry"]).toMatchObject({ type: "object" });
	});
});
