import { type } from "arktype";

export const ArkMeta = type({
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
	"inlineSafe?": "boolean",

	"atomic?": "boolean",

	"obsolete?": "boolean",
	"obsoleteReason?": "string",
	"renamedFrom?": "string",
	"originalType?": "string",

	"symbol?": "string",

	"wgslType?": "string",
	"wgslBuiltin?": "string"
});

export type ArkMeta = typeof ArkMeta.infer;

declare global {
	interface ArkEnv {
		meta(): ArkMeta
	}
}