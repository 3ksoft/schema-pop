/// <reference types="@types/bun" />
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scope } from "arktype";
import { binary, Renamed, type LayoutPlan } from "../../schema/src";
import {
	defineMigration,
	diffPlans,
	emitTsMigration,
	fromModule,
	resolveMigration,
	SchemaAnalyzer,
} from "../../core/src";
import { ts, tsCodec } from "../../exporter/src";

function analyze(s: any, version: string): LayoutPlan {
	return new SchemaAnalyzer().analyze(fromModule(s.export()), { version }).plan;
}

// One self-contained module per version: type declarations + codec together, so
// the codec's bare type references resolve locally.
function perVersionFile(plan: LayoutPlan): string {
	const types = ts({});
	const codec = tsCodec({ importPath: "" });
	return (
		types.getFileHeader() +
		types.generate(plan) +
		"\n" +
		codec.getFileHeader() +
		codec.generate(plan)
	);
}

const TMP = join(import.meta.dir, "__migtmp__");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("migration end-to-end (byte round-trip through the codec)", () => {
	test("encode v1 → migrate → decode v2 (rename + widen + default)", async () => {
		const v1Plan = analyze(
			scope({
				...binary.import(),
				Battery: { voltage_mv: "u32", current: "u8" },
			}),
			"1.0.0",
		);
		const v2Plan = analyze(
			scope({
				...binary.import(),
				Renamed,
				Battery: {
					voltage: "Renamed<u32, 'voltage_mv'>", // renamed
					current: "u16", // widened u8 → u16
					firmware: "u16 = 1", // new field, default 1
				},
			}),
			"2.0.0",
		);

		const migPlan = resolveMigration(diffPlans(v1Plan, v2Plan));
		const migCode = emitTsMigration(migPlan, {
			v1TypesImport: "./v1",
			v2TypesImport: "./v2",
			v1CodecImport: "./v1",
			v2CodecImport: "./v2",
		});

		const dir = join(TMP, "rt1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "v1.ts"), perVersionFile(v1Plan));
		writeFileSync(join(dir, "v2.ts"), perVersionFile(v2Plan));
		writeFileSync(join(dir, "migration.ts"), migCode);

		const v1mod: any = await import(join(dir, "v1.ts"));
		const v2mod: any = await import(join(dir, "v2.ts"));
		const mig: any = await import(join(dir, "migration.ts"));

		// Encode a v1 value to bytes with the v1 codec.
		const v1Bytes = new Uint8Array(v1mod.SIZEOF_Battery);
		v1mod.serializeBattery(
			{ voltage_mv: 12345, current: 200 },
			new DataView(v1Bytes.buffer),
			0,
		);

		// Migrate bytes → v2 bytes → decode with the v2 codec.
		const v2Bytes: Uint8Array = mig.migrateBattery(v1Bytes);
		const v2Obj = v2mod.deserializeBattery(
			new DataView(v2Bytes.buffer, v2Bytes.byteOffset, v2Bytes.byteLength),
			0,
		);

		expect(v2Obj.voltage).toBe(12345); // carried across the rename
		expect(v2Obj.current).toBe(200); // widened, value preserved
		expect(v2Obj.firmware).toBe(1); // filled from the ArkType default

		// The pure object transform is also usable directly.
		const t = mig.transformBattery({ voltage_mv: 42, current: 7 });
		expect(t).toEqual({ voltage: 42, current: 7, firmware: 1 });
	});

	test("nested struct composition round-trips through the codec", async () => {
		const v1Plan = analyze(
			scope({
				...binary.import(),
				Inner: { a: "u8" },
				Outer: { inner: "Inner", tag: "u8" },
			}),
			"1.0.0",
		);
		const v2Plan = analyze(
			scope({
				...binary.import(),
				Inner: { a: "u16" }, // widened → Inner dirty → Outer dirty by reference
				Outer: { inner: "Inner", tag: "u8" },
			}),
			"2.0.0",
		);
		const migPlan = resolveMigration(diffPlans(v1Plan, v2Plan));
		const migCode = emitTsMigration(migPlan, {
			v1TypesImport: "./v1",
			v2TypesImport: "./v2",
			v1CodecImport: "./v1",
			v2CodecImport: "./v2",
		});

		const dir = join(TMP, "nested");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "v1.ts"), perVersionFile(v1Plan));
		writeFileSync(join(dir, "v2.ts"), perVersionFile(v2Plan));
		writeFileSync(join(dir, "migration.ts"), migCode);

		const v1mod: any = await import(join(dir, "v1.ts"));
		const v2mod: any = await import(join(dir, "v2.ts"));
		const mig: any = await import(join(dir, "migration.ts"));

		const v1Bytes = new Uint8Array(v1mod.SIZEOF_Outer);
		v1mod.serializeOuter(
			{ inner: { a: 5 }, tag: 9 },
			new DataView(v1Bytes.buffer),
			0,
		);
		const v2Bytes: Uint8Array = mig.migrateOuter(v1Bytes);
		const v2Obj = v2mod.deserializeOuter(
			new DataView(v2Bytes.buffer, v2Bytes.byteOffset, v2Bytes.byteLength),
			0,
		);
		expect(v2Obj.inner.a).toBe(5); // child transform ran under the parent
		expect(v2Obj.tag).toBe(9);
	});

	test("per-field hook round-trips (narrowing with clamp)", async () => {
		const v1Plan = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"1.0.0",
		);
		const v2Plan = analyze(
			scope({ ...binary.import(), B: { x: "u16" } }), // narrowed → needs a hook
			"2.0.0",
		);
		// Coverage check at resolve time only inspects the mapper's keys.
		const migPlan = resolveMigration(diffPlans(v1Plan, v2Plan), {
			B: defineMigration<{ x: number }, { x: number }>({ x: (v1) => v1.x }),
		});
		const migCode = emitTsMigration(migPlan, {
			v1TypesImport: "./v1",
			v2TypesImport: "./v2",
			v1CodecImport: "./v1",
			v2CodecImport: "./v2",
			hooksImport: "./migrations.hooks",
		});

		const dir = join(TMP, "hook");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "v1.ts"), perVersionFile(v1Plan));
		writeFileSync(join(dir, "v2.ts"), perVersionFile(v2Plan));
		writeFileSync(join(dir, "migration.ts"), migCode);
		// The user's hook module: clamp the value into u16 range.
		writeFileSync(
			join(dir, "migrations.hooks.ts"),
			`export const migrationHooks = { B: { x: (v1: any) => Math.min(v1.x, 65535) } };\n`,
		);

		const v1mod: any = await import(join(dir, "v1.ts"));
		const v2mod: any = await import(join(dir, "v2.ts"));
		const mig: any = await import(join(dir, "migration.ts"));

		const v1Bytes = new Uint8Array(v1mod.SIZEOF_B);
		v1mod.serializeB({ x: 100000 }, new DataView(v1Bytes.buffer), 0);
		const v2Bytes: Uint8Array = mig.migrateB(v1Bytes);
		const v2Obj = v2mod.deserializeB(
			new DataView(v2Bytes.buffer, v2Bytes.byteOffset, v2Bytes.byteLength),
			0,
		);
		expect(v2Obj.x).toBe(65535); // clamped by the user hook
	});

	test("whole-type hook owns the conversion", async () => {
		const v1Plan = analyze(
			scope({ ...binary.import(), B: { x: "u32" } }),
			"1.0.0",
		);
		const v2Plan = analyze(
			scope({ ...binary.import(), B: { x: "u16" } }),
			"2.0.0",
		);
		const migPlan = resolveMigration(diffPlans(v1Plan, v2Plan), {
			B: defineMigration<{ x: number }, { x: number }>((v1) => ({ x: v1.x })),
		});
		const migCode = emitTsMigration(migPlan, {
			v1TypesImport: "./v1",
			v2TypesImport: "./v2",
			v1CodecImport: "./v1",
			v2CodecImport: "./v2",
			hooksImport: "./migrations.hooks",
		});

		const dir = join(TMP, "whole");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "v1.ts"), perVersionFile(v1Plan));
		writeFileSync(join(dir, "v2.ts"), perVersionFile(v2Plan));
		writeFileSync(join(dir, "migration.ts"), migCode);
		writeFileSync(
			join(dir, "migrations.hooks.ts"),
			`export const migrationHooks = { B: (v1: any) => ({ x: v1.x & 0xffff }) };\n`,
		);

		const v2mod: any = await import(join(dir, "v2.ts"));
		const mig: any = await import(join(dir, "migration.ts"));
		expect(mig.transformB({ x: 3 })).toEqual({ x: 3 });
		void v2mod;
	});
});
