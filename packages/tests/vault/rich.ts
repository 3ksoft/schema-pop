import { scope } from "arktype";

export const $ = scope({
	AppConfig: {
		"modelFolder?": "string",
		"modelName?": "string",
		"tokenizerPath?": "string",
		"engineBin?": "string",
		"logLevel?": "'info' | 'debug'",
		"serverPort?": "number",
		"maxKvCacheVramMB?": "number",
		"bytesPerToken?": "number",
	},
});
