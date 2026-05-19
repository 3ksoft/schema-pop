import { fileURLToPath, URL } from "node:url";
import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { defineConfig } from "vite";
import vueDevTools from "vite-plugin-vue-devtools";
import { appConfig } from "./src/config/appConfig";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
	server: {
		port: 3000,
		open: true,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	plugins: [
		vue(),
		vueDevTools(),
		ui({
			autoImport: {
				imports: ["vue", "vue-router", "pinia", "@vueuse/core"],
				dirs: [
					"src/stores",
					"src/types",
					"src/composables",
					"src/components/graph/composables",
				],
			},
			components: {
				dirs: ["src/views", "src/components", "src/components/graph"],
			},
			ui: appConfig.ui as any,
		}),
	],

	resolve: {
		alias: [
			{
				find: "@",
				replacement: fileURLToPath(new URL("./src", import.meta.url)),
			},
			{
				find: "node:fs/promises",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "node:fs",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "node:path",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "node:url",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "fs/promises",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "fs",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "path",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "url",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "jiti",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
			{
				find: "module",
				replacement: fileURLToPath(new URL("./src/mock.ts", import.meta.url)),
			},
		],
	},
}));
