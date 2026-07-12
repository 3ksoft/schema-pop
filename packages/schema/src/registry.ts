export const IMPORTER_REGISTRY = {
	".ts": "typescript",
	".tsx": "typescript",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".hpp": "cpp",
	".go": "go",
	".py": "python",
	".java": "java",
	".cs": "c_sharp",
	".kt": "kotlin",
	".swift": "swift",
	".php": "php",
	".dart": "dart",
	".scala": "scala",
	".ex": "elixir",
	".exs": "elixir",
	".m": "objc",
};

// Single source of truth for CLI-dispatchable exporter targets. The exporter
// package derives `ExporterTarget` (and, through it, the config map + factory
// table) from these keys, so a target added/removed here flows through the
// whole dispatch path and the compiler forces the pieces to stay in sync.
//
// Structured-return exporters (tsWebgpu, gpuBindingsTs) are intentionally
// absent: they return `{ section: contents }` for imperative use and don't go
// through the string/path `exportPlan` pipeline.
export const EXPORTER_REGISTRY = {
	c: "core",
	cpp: "core",
	rust: "core",
	"rust:serde": "core",
	ts: "core",
	"ts:codec": "core",
	"ts:exports": "core",
	zig: "core",
	md: "core",
	random: "core",
	bf: "extra",
	html: "extra",
	svg: "extra",
	mermaid: "extra",
	wgsl: "extra",
	"cpp:harness": "extra",
	"rust:harness": "extra",
	"zig:harness": "extra",
	"bf:harness": "extra",
} as const;

export const BINARY_METADATA: Record<string, Record<string, unknown>> = {
	bool: { size: 1, align: 1, popKind: "bitwise" },
	u8: { min: 0, max: 255, size: 1, align: 1, popKind: "binary" },
	i8: { min: -128, max: 127, size: 1, align: 1, popKind: "binary" },
	u16: { min: 0, max: 65535, size: 2, align: 2, popKind: "binary" },
	i16: { min: -32768, max: 32767, size: 2, align: 2, popKind: "binary" },
	u32: { min: 0, max: 4294967295, size: 4, align: 4, popKind: "binary" },
	i32: {
		min: -2147483648,
		max: 2147483647,
		size: 4,
		align: 4,
		popKind: "binary",
	},
	u64: { min: 0, size: 8, align: 8, popKind: "binary" },
	i64: { size: 8, align: 8, popKind: "binary" },
	u128: { min: 0, size: 16, align: 8, popKind: "binary" },
	i128: { size: 16, align: 8, popKind: "binary" },
	f32: { size: 4, align: 4, popKind: "binary" },
	f64: { size: 8, align: 8, popKind: "binary" },
	u1: { min: 0, max: 1, size: 1, popKind: "bitwise" },
	u2: { min: 0, max: 3, size: 2, popKind: "bitwise" },
	u3: { min: 0, max: 7, size: 3, popKind: "bitwise" },
	u4: { min: 0, max: 15, size: 4, popKind: "bitwise" },
	u5: { min: 0, max: 31, size: 5, popKind: "bitwise" },
	u6: { min: 0, max: 63, size: 6, popKind: "bitwise" },
	u7: { min: 0, max: 127, size: 7, popKind: "bitwise" },
};
