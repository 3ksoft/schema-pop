import { type, type LayoutPlan } from "@schema-pop/schema";

// 1. Rejestr eksporterów jako jedno źródło prawdy
export const EXPORTER_REGISTRY = {
	c: "core",
	cpp: "core",
	rust: "core",
	"rust:serde": "core",
	ts: "core",
	"ts:codec": "core",
	"ts:exports": "core",
	zig: "core",
	wgsl: "core",
	"cpp:harness": "extra",
	"rust:harness": "extra",
	"zig:harness": "extra",
} as const;

export type ExporterTarget = keyof typeof EXPORTER_REGISTRY;

// Mock / Import rejestru importerów (podmień ścieżkę jeśli jest w innym pakiecie)
// import { IMPORTER_REGISTRY, AllowedExtensionsSchema, AllowedLanguagesSchema } from "@schema-pop/importers";
const IMPORTER_REGISTRY: Record<string, string> = {
	".ts": "typescript",
	".json": "json",
};

const AllowedExtensionsSchema = type("'ts' | 'json'");
const AllowedLanguagesSchema = type("'typescript' | 'json'");

// 2. Schematy ArkType
const AllowedTypesSchema = type.enumerated(
	...(Object.keys(EXPORTER_REGISTRY) as ExporterTarget[]),
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
	const input = typeof data.input === "string" ? [data.input] : data.input;
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

// 3. Główny interfejs dla pluginów eksportera
export interface ExporterPlugin<
	TConfig extends BaseConfig = BaseConfig,
	TOut = string | Record<string, string>,
> {
	name: string;
	config: TConfig;
	extension?: string;
	generate: (plan: LayoutPlan) => TOut;
	wrapVersion?: (version: string | undefined, code: string) => string;
	getFileHeader?: () => string;
	getFileFooter?: () => string;
	getHarness?: (plans: LayoutPlan[]) => Record<string, string>;
	getIndex?: (
		files: { dest: string; schemaName: string }[],
	) => Record<string, string>;
}