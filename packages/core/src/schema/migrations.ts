import { Renamed } from "./core";
import { scope } from "arktype";

/**
 * Opt-in scope of markers used by the migration emit pass.
 * Compose into a user scope alongside `binary`:
 *
 *   import { binary, migrations } from "schema-pop";
 *   const myScope = scope({
 *     ...binary.import(),
 *     ...migrations.import(),
 *     MyType: { voltage: "Renamed<u32, 'voltage_mv'>" },
 *   });
 *
 * Lives in its own scope so projects that don't need migrations don't
 * pay the TS inference cost of these generics in the base `binary` scope.
 */
export const migrations = scope({
	Renamed,
});
