import { cc, FFIType } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLayoutPlan } from "../core/src/layout-io";
import type { LayoutPlan, StructPlan } from "../core/src/schema/layout";
import { compileMigration } from "../core-exporters/src/code/c";

const corpusDir = new URL("../../corpora/corpus-uart/out", import.meta.url)
	.pathname;
const v1Plan = await readLayoutPlan(
	path.join(corpusDir, "include__driver__uart.h.layout.json"),
);

const v1Struct = v1Plan.types.find(
	(t) => t.kind === "struct" && t.name === "uart_config_t",
) as StructPlan;
const v2Plan: LayoutPlan = {
	...v1Plan,
	version: "uart_config_t_2_0",
	types: [
		...v1Plan.types.filter((t) => t.name !== "uart_config_t"),
		{
			...v1Struct,
			size: 28,
			paddedSize: 28,
			fields: [
				...v1Struct.fields
					.filter((f) => f.name !== "flags")
					.map((f) =>
						f.name === "rx_flow_ctrl_thresh" ? { ...f, name: "rx_thresh" } : f,
					),
				{
					name: "source_clk",
					type: {
						kind: "primitive",
						name: "i32",
						size: 4,
						align: 4,
						paddedSize: 4,
						bitSize: 32,
						popKind: "binary",
					} as any,
					offset: 24,
					size: 4,
				},
			],
		} as StructPlan,
	],
};

const migrationSrc = `
function migrate_uart_config_t_v1_to_v2(v1: uart_config_t): uart_config_t {
    return {
        baud_rate:  v1.baud_rate,
        data_bits:  v1.data_bits,
        parity:     v1.parity,
        stop_bits:  v1.stop_bits,
        flow_ctrl:  v1.flow_ctrl,
        rx_thresh:  v1.rx_flow_ctrl_thresh,
        source_clk: 0,
    };
}
`.trim();

console.log("=== Migration source ===");
console.log(migrationSrc);
console.log();

const cCode = await compileMigration(migrationSrc, v1Plan, v2Plan);
console.log("=== Generated C ===");
console.log(cCode);

// ── Compile + run via Bun cc ──────────────────────────────────────────────────

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-pop-compiler-"));
const srcFile = path.join(tmpDir, "migration.c");
await fs.writeFile(srcFile, cCode);

const lib = cc({
	source: srcFile,
	symbols: {
		migrate_uart_config_t_v1_to_v2: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.void,
		},
	},
});

const src = new Int32Array([115200, 8, 0, 1, 0, 122]);
const dst = new Int32Array(7);

lib.symbols.migrate_uart_config_t_v1_to_v2(src, dst);
lib.close();

console.log("=== Migration executed in-process ===");
console.log(`baud_rate:  ${dst[0]}   (expect 115200)`);
console.log(`data_bits:  ${dst[1]}   (expect 8)`);
console.log(`parity:     ${dst[2]}    (expect 0)`);
console.log(`stop_bits:  ${dst[3]}    (expect 1)`);
console.log(`flow_ctrl:  ${dst[4]}    (expect 0)`);
console.log(`rx_thresh:  ${dst[5]}  (expect 122)`);
console.log(`source_clk: ${dst[6]}    (expect 0)`);

await fs.rm(tmpDir, { recursive: true });
