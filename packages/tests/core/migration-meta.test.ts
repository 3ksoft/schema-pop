/// <reference types="@types/bun" />

import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { SchemaAnalyzer, fromModule } from "@schema-pop/core";
import { binary, migrations } from "@schema-pop/schema";

describe("migrationMeta extraction", () => {
	test("ArkType native default → field.migrationMeta.defaultValue", () => {
		const s = type.module({
			...binary.import(),
			BatteryV2: {
				current: "i32",
				firmware: "u16 = 1",
				flags: "u8 = 0",
			},
		});
		const plan = new SchemaAnalyzer().analyze(fromModule(s), {
			wordSize: "64",
			autoLayout: false,
			layout: "aligned",
			mode: "binary",
			version: "2.0.0",
			endian: "le",
		});

		const battery = plan.types.find((t) => t.name === "BatteryV2");
		expect(battery?.kind).toBe("struct");
		if (battery?.kind !== "struct") return;

		const firmware = battery.fields.find((f) => f.name === "firmware");
		expect(firmware?.migrationMeta).toEqual({ defaultValue: 1 });

		const flags = battery.fields.find((f) => f.name === "flags");
		expect(flags?.migrationMeta).toEqual({ defaultValue: 0 });

		const current = battery.fields.find((f) => f.name === "current");
		expect(current?.migrationMeta).toBeUndefined();
	});

	test("Renamed<T, 'oldName'> → field.migrationMeta.renamedFrom", () => {
		const s = type.module({
			...binary.import(),
			...migrations.import(),
			BatteryV2: {
				voltage: "Renamed<u32, 'voltage_mv'>",
				current: "i32",
			},
		});
		const plan = new SchemaAnalyzer().analyze(fromModule(s), {
			wordSize: "64",
			autoLayout: false,
			layout: "aligned",
			mode: "binary",
			version: "2.0.0",
			endian: "le",
		});

		const battery = plan.types.find((t) => t.name === "BatteryV2");
		if (battery?.kind !== "struct") throw new Error("expected struct");

		const voltage = battery.fields.find((f) => f.name === "voltage");
		expect(voltage?.migrationMeta).toEqual({ renamedFrom: "voltage_mv" });

		const current = battery.fields.find((f) => f.name === "current");
		expect(current?.migrationMeta).toBeUndefined();
	});

	test("Renamed and ArkType default compose on the same field", () => {
		const s = type.module({
			...binary.import(),
			...migrations.import(),
			Wide: {
				// Renamed AND has a default — both should land in migrationMeta
				v: "Renamed<u16, 'old_v'> = 7",
			},
		});
		const plan = new SchemaAnalyzer().analyze(fromModule(s), {
			wordSize: "64",
			autoLayout: false,
			layout: "aligned",
			mode: "binary",
			version: "2.0.0",
			endian: "le",
		});
		const wide = plan.types.find((t) => t.name === "Wide");
		if (wide?.kind !== "struct") throw new Error("expected struct");
		const v = wide.fields.find((f) => f.name === "v");
		expect(v?.migrationMeta).toEqual({
			renamedFrom: "old_v",
			defaultValue: 7,
		});
	});

	test("default-bearing field is NOT wrapped in optional at binary layout", () => {
		const s = type.module({
			...binary.import(),
			Cfg: { x: "u8 = 5" },
		});
		const plan = new SchemaAnalyzer().analyze(fromModule(s), {
			wordSize: "64",
			autoLayout: false,
			layout: "aligned",
			mode: "binary",
			version: "2.0.0",
			endian: "le",
		});
		const cfg = plan.types.find((t) => t.name === "Cfg");
		if (cfg?.kind !== "struct") throw new Error("expected struct");
		const x = cfg.fields[0]!;
		expect(x.type.kind).toBe("primitive"); // not "optional"
	});

	test("type-level Renamed → plan.migrationMeta", () => {
		const s = type.module({
			...binary.import(),
			...migrations.import(),
			DeviceStatus: "Renamed<u8, 'OldStatus'>",
		});
		const plan = new SchemaAnalyzer().analyze(fromModule(s), {
			wordSize: "64",
			autoLayout: false,
			layout: "aligned",
			mode: "binary",
			version: "2.0.0",
			endian: "le",
		});
		const ds = plan.types.find((t) => t.name === "DeviceStatus");
		expect(ds?.migrationMeta).toEqual({ renamedFrom: "OldStatus" });
	});
});
