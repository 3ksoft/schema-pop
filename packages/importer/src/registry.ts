// AUTO GENERATED
export const IMPORTER_REGISTRY = {
	c: {
		className: "CImporter",
		path: "packages/importer/src/treesitter/walk-c.ts",
		supportedExtensions: [".h", ".c", ".cc", ".cxx", ".cpp", ".hxx", ".hpp"],
	},
	csharp: {
		className: "CSharpImporter",
		path: "packages/importer/src/treesitter/walk-csharp.ts",
		supportedExtensions: [".cs"],
	},
	dart: {
		className: "DartImporter",
		path: "packages/importer/src/treesitter/walk-dart.ts",
		supportedExtensions: [".dart"],
	},
	elixir: {
		className: "ElixirImporter",
		path: "packages/importer/src/treesitter/walk-elixir.ts",
		supportedExtensions: [".ex", ".exs"],
	},
	go: {
		className: "GoImporter",
		path: "packages/importer/src/treesitter/walk-go.ts",
		supportedExtensions: [".go"],
	},
	index: {
		className: "TsImporter",
		path: "packages/importer/src/treesitter/index.ts",
		supportedExtensions: [".ts", ".tsx"],
	},
	java: {
		className: "JavaImporter",
		path: "packages/importer/src/treesitter/walk-java.ts",
		supportedExtensions: [".java"],
	},
	kotlin: {
		className: "KotlinImporter",
		path: "packages/importer/src/treesitter/walk-kotlin.ts",
		supportedExtensions: [".kt"],
	},
	objc: {
		className: "ObjcImporter",
		path: "packages/importer/src/treesitter/walk-objc.ts",
		supportedExtensions: [".h", ".m"],
	},
	php: {
		className: "PhpImporter",
		path: "packages/importer/src/treesitter/walk-php.ts",
		supportedExtensions: [".php"],
	},
	python: {
		className: "PythonImporter",
		path: "packages/importer/src/treesitter/walk-python.ts",
		supportedExtensions: [".py"],
	},
	rust: {
		className: "RustImporter",
		path: "packages/importer/src/treesitter/walk-rust.ts",
		supportedExtensions: [".rs"],
	},
	scala: {
		className: "ScalaImporter",
		path: "packages/importer/src/treesitter/walk-scala.ts",
		supportedExtensions: [".scala"],
	},
	swift: {
		className: "SwiftImporter",
		path: "packages/importer/src/treesitter/walk-swift.ts",
		supportedExtensions: [".swift"],
	},
	ts: {
		className: "TsImporter",
		path: "packages/importer/src/treesitter/walk-ts.ts",
		supportedExtensions: [".ts", ".tsx"],
	},
} as const;
export type ImporterRegistry = typeof IMPORTER_REGISTRY;
