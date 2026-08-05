import { type } from "arktype";

export const ArkMeta = type({
	"popKind?": "'rich' | 'bitwise' | 'binary' | 'reserved'",
	"description?": "string",
	"category?": "string",
	"min?": "number",
	"max?": "number",
	"step?": "number",
	"required?": "boolean",
	"default?": "unknown.any",

	"size?": "number",
	"align?": "number",
	"binaryType?": "string",
	"scale?": "number",
	"isBinary?": "boolean",
	"bitSize?": "number",
	"unsigned?": "boolean",
	"isFloat?": "boolean",

	"atomic?": "boolean",

	"obsolete?": "boolean",
	"obsoleteReason?": "string",
	"renamedFrom?": "string",
	"originalType?": "string",
	// Literal-symbol provenance carried from source importers (e.g. ArkType UnitNode).
	// Exporters may use it to assign a target-specific global symbol identity.
	"symbol?": "string",
});

export type ArkMeta = typeof ArkMeta.infer;

declare global {
	interface ArkEnv {
		meta(): ArkMeta
	}
}