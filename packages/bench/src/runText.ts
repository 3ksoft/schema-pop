import { bench, group, run, summary, do_not_optimize } from "mitata";
import { Packr } from "msgpackr";
import { makeTextFixture } from "./schemaText.ts";
import {
	deserializeChatBatch,
	serializeChatBatch,
} from "../generated/codecText.ts";
import { ChatBatch as BebopChatBatch } from "../bebop/generatedText.ts";

const packr = new Packr({ useRecords: false });
const packrR = new Packr({ useRecords: true });

const fixture = makeTextFixture(7);

// ts:codec emits a fixed-size payload — measured from the layout.
const CODEC_SIZE = 1220;
const codecBuf = new ArrayBuffer(CODEC_SIZE);
const codecView = new DataView(codecBuf);

serializeChatBatch(fixture, codecView, 0);
const jsonStr = JSON.stringify(fixture);
const jsonBytes = new TextEncoder().encode(jsonStr);
const msgpackBytes = packr.pack(fixture);
for (let i = 0; i < 4; i++) packrR.pack(fixture);
const msgpackRecBytes = packrR.pack(fixture);
const bebopBytes = BebopChatBatch.encode(fixture as any);

console.log("payload sizes (bytes):");
console.log(`  ts:codec     ${CODEC_SIZE}  (fixed-size string slots)`);
console.log(`  bebop        ${bebopBytes.length}`);
console.log(`  msgpackr+rec ${msgpackRecBytes.length}`);
console.log(`  msgpackr     ${msgpackBytes.length}`);
console.log(`  JSON         ${jsonBytes.length}`);
console.log("");

summary(() => {
	group("encode", () => {
		bench("ts:codec", () => {
			serializeChatBatch(fixture, codecView, 0);
			do_not_optimize(codecBuf);
		});
		bench("JSON.stringify", () => {
			do_not_optimize(JSON.stringify(fixture));
		});
		bench("msgpackr", () => {
			do_not_optimize(packr.pack(fixture));
		});
		bench("msgpackr+records", () => {
			do_not_optimize(packrR.pack(fixture));
		});
		bench("bebop", () => {
			do_not_optimize(BebopChatBatch.encode(fixture as any));
		});
	});

	group("decode", () => {
		bench("ts:codec", () => {
			do_not_optimize(deserializeChatBatch(codecView, 0));
		});
		bench("JSON.parse", () => {
			do_not_optimize(JSON.parse(jsonStr));
		});
		bench("msgpackr", () => {
			do_not_optimize(packr.unpack(msgpackBytes));
		});
		bench("msgpackr+records", () => {
			do_not_optimize(packrR.unpack(msgpackRecBytes));
		});
		bench("bebop", () => {
			do_not_optimize(BebopChatBatch.decode(bebopBytes));
		});
	});

	group("roundtrip", () => {
		bench("ts:codec", () => {
			serializeChatBatch(fixture, codecView, 0);
			do_not_optimize(deserializeChatBatch(codecView, 0));
		});
		bench("JSON", () => {
			do_not_optimize(JSON.parse(JSON.stringify(fixture)));
		});
		bench("msgpackr", () => {
			do_not_optimize(packr.unpack(packr.pack(fixture)));
		});
		bench("msgpackr+records", () => {
			do_not_optimize(packrR.unpack(packrR.pack(fixture)));
		});
		bench("bebop", () => {
			do_not_optimize(
				BebopChatBatch.decode(BebopChatBatch.encode(fixture as any)),
			);
		});
	});
});

await run({ colors: false });
