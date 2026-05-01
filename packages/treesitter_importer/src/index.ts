import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseRust } from "./parser";
import { walkRustFile } from "./walk";
import { emitArktypeScope, type EmitOptions } from "./emit";
import type { RustModuleIR } from "./ir";

export type { RustModuleIR, EmitOptions };
export type {
	RustField,
	RustItem,
	RustEnumVariant,
	RustType,
	RustPrimitive,
} from "./ir";

export { parseRust } from "./parser";
export { walkRustFile } from "./walk";
export { emitArktypeScope } from "./emit";

/**
 * One-shot: read a `.rs` file, walk it, return IR. No emit step.
 */
export async function importRustFile(filePath: string): Promise<RustModuleIR> {
	const abs = path.resolve(filePath);
	const source = await fs.readFile(abs, "utf8");
	const tree = await parseRust(source);
	return walkRustFile(tree, path.relative(process.cwd(), abs));
}

/**
 * One-shot: read a `.rs` file, walk it, emit arktype scope source. Returns
 * the rendered string — caller writes it where they want.
 */
export async function rustFileToArktypeScope(
	filePath: string,
	opts?: EmitOptions,
): Promise<string> {
	const ir = await importRustFile(filePath);
	return emitArktypeScope(ir, opts);
}
