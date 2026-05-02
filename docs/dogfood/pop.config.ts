import { defineConfig } from "schema-pop";
import { html, wgsl } from "@schema-pop/extra-exporters";

// Dogfood: run schema-pop against one of its own internal scopes
// and emit a self-contained HTML doc page. Output lands next to this
// config so GH Pages / static hosting can pick it up directly.
//
// `testScope` is used (not `$layout`) because $layout exercises a few
// arktype features the analyzer does not yet cover (cross-scope `$Field`
// references, numeric literal unions like `32 | 64`). Once rich-tier
// support lands, this config will switch to `$layout`.

export default defineConfig({
	endian: "le",
	wordSize: 64,
	autoLayout: true,
	schemas: [
		{
			name: "core-fixtures",
			versions: [
				{
					version: "1.0",
					source: "../../packages/core/src/schema/test.ts",
					exportName: "testScope",
				},
			],
			targets: [html({ dest: "./index.html" })],
		},
		{
			name: "gpu-physics",
			layout: "std430",
			autoLayout: false,
			versions: [{ version: "1.0", source: "./gpu-physics.ts" }],
			targets: [
				wgsl({ dest: "./gpu-physics.wgsl" }),
				html({ dest: "./gpu-physics.html" }),
			],
		},
		{
			name: "showcase",
			versions: [{ version: "1.0", source: "./showcase.ts" }],
			targets: [html({ dest: "./showcase.html" })],
		},
	],
});
