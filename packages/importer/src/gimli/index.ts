import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import init, { extract_metadata } from "../../pkg/gimli_wasm.js";
export { DwarfImporter } from "./DwarfImporter.js";

let initialized = false;

/**
 * Parses an ELF buffer using Gimli in WebAssembly and returns schema metadata.
 */
export async function extractMetadata(elfBuffer: Uint8Array): Promise<any> {
	if (!initialized) {
		// Resolve WASM binary path securely in both standard Node and Bun contexts
		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const wasmPath = path.resolve(__dirname, "../../pkg/gimli_wasm_bg.wasm");

		const wasmBytes = await readFile(wasmPath);
		await init(wasmBytes);
		initialized = true;
	}

	return extract_metadata(elfBuffer);
}
