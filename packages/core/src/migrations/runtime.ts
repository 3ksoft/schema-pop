/**
 * Per-field mapper for a v1 → v2 migration. Each entry is optional; missing
 * entries fall through to schema-pop's auto-emit (rename via marker, ArkType
 * default, language default, structural copy).
 */
export type MigrationMapper<From, To> = {
	[K in keyof To]?: (v1: From) => To[K];
};

/**
 * Type-helper factory for declaring a partial v1 → v2 migration. Returns
 * the mapper as-is — its only job is to give TS inference a hook so every
 * entry is correctly typed against `From` (input) and `To` (output).
 *
 * Fields not present in the mapper fall through to schema-pop's auto-emit
 * (rename / language-default / structural copy). Use this when one or two
 * fields need custom logic but the rest can be auto-derived.
 *
 *   import { defineMigration } from "schema-pop";
 *   import type { V1_0, V2_0 } from "./generated/battery";
 *
 *   export const batteryV1V2 = defineMigration<V1_0.Battery, V2_0.Battery>({
 *       voltage: (v1) => v1.voltage_mv,
 *       firmwareVersion: (v1) => detectFw(v1),
 *   });
 */
export function defineMigration<From, To>(
	mapper: MigrationMapper<From, To>,
): MigrationMapper<From, To> {
	return mapper;
}
