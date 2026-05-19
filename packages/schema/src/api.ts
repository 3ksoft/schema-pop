import { type } from "arktype";
import type { LayoutPlan } from "./layout";
import { EXPORTER_REGISTRY, IMPORTER_REGISTRY } from "./registry";

const AllowedExtensionsSchema = type.enumerated(
	...(Object.keys(IMPORTER_REGISTRY) as (keyof typeof IMPORTER_REGISTRY)[]),
);
const AllowedLanguagesSchema = type.enumerated(
	...(Array.from(
		new Set(Object.values(IMPORTER_REGISTRY)),
	) as (typeof IMPORTER_REGISTRY)[keyof typeof IMPORTER_REGISTRY][]),
);
const AllowedTypesSchema = type.enumerated(
	...(Object.keys(EXPORTER_REGISTRY) as (keyof typeof EXPORTER_REGISTRY)[]),
);

export const exporter = type.module({
	NamingStrategy: "'snake_case' | 'camelCase' | 'PascalCase' | 'original'",
	CommentStyle: "'slash' | 'star' | 'xml' | 'hash' | 'none'",
	ExportStrategy: "'standalone' | 'inline' | 'barrel'",

	BaseConfig: {
		"dest?": "string",
		"fieldNaming?": "NamingStrategy",
		"typeNaming?": "NamingStrategy",
		"commentStyle?": "CommentStyle",
		"exportStrategy?": "ExportStrategy",
		"prependToFile?": "string",
		"appendToFile?": "string",
		"noHeader?": "boolean",
		"noWrap?": "boolean",
	},
});
const CliConfig = type.module({
	AllowedTypesSchema: AllowedTypesSchema,
	AllowedExtensionsSchema: AllowedExtensionsSchema,
	AllowedLanguagesSchema: AllowedLanguagesSchema,
	BuildTarget: {
		path: "string = 'stdout'",
		type: "AllowedTypesSchema='ts'",
	},
	InputFile: {
		path: "string",
		language: "AllowedLanguagesSchema",
	},
	Config: {
		inputs: "InputFile[]",
		target: "BuildTarget",
		mode: "'binary' | 'rich'",
	},
});

function findLanguage(filepath: string) {
	for (const [k, val] of Object.entries(IMPORTER_REGISTRY)) {
		if (filepath.endsWith(k)) {
			return val;
		}
	}
	return IMPORTER_REGISTRY[".ts"];
}

export const { BuildTarget, InputFile, Config } = CliConfig;
export type BuildTarget = typeof BuildTarget.infer;
export type InputFile = typeof InputFile.infer;
export type Config = typeof Config.infer;

export const CliParserSchema = type({
	"output?": "string",
	"type?": "string",
	"mode?": "string",
	input: "string | string[]",
}).pipe((data) => {
	var input = typeof data.input === "string" ? [data.input] : data.input;
	const parsedInputs = input.map((filepath) => {
		return InputFile({
			path: filepath,
			language: findLanguage(filepath),
		});
	});
	const buildTarget = BuildTarget({
		path: data.output,
		type: data.type,
	});
	return Config({
		inputs: parsedInputs,
		target: buildTarget,
		mode: data.mode,
	});
});

export const { NamingStrategy, CommentStyle, ExportStrategy, BaseConfig } =
	exporter;

export type NamingStrategy = typeof NamingStrategy.infer;
export type CommentStyle = typeof CommentStyle.infer;
export type ExportStrategy = typeof ExportStrategy.infer;
export type BaseConfig = typeof BaseConfig.infer;

export interface ExporterPlugin<TConfig extends BaseConfig = BaseConfig> {
	name: string;
	config: TConfig;
	/**
	 * Default file extension (without leading dot) for output files
	 * when the user sets `defineConfig.destDir` instead of explicit
	 * `dest` per target. Falls back to `name` when omitted.
	 */
	extension?: string;
	generate: (plan: LayoutPlan) => string | Record<string, string>;
	wrapVersion?: (version: string | undefined, code: string) => string;
	getFileHeader?: () => string;
	getFileFooter?: () => string;
	getHarness?: (plans: LayoutPlan[]) => Record<string, string>;
	/**
	 * Aggregate every per-schema file written by this plugin instance
	 * into the same directory and return additional barrel files
	 * (`{ filename: contents }`) to drop next to them. Used by the TS
	 * exporter to emit `index.ts` so consumers can
	 * `import { ... } from "./schema"` instead of cherry-picking each
	 * `<schemaName>.ts` by hand.
	 */
	getIndex?: (
		files: { dest: string; schemaName: string }[],
	) => Record<string, string>;
}
