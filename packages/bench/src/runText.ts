import { bench, group, run, summary, do_not_optimize } from "mitata";
import { Packr } from "msgpackr";
import {
	createInterpretedCodec,
	createRuntimeCodec,
} from "@schema-pop/core";

import { makeTextFixture, type ChatBatchLit } from "./schemaText.ts";
import {
	deserializeChatBatch,
	serializeChatBatch,
} from "../generated/text_codec.ts";
import { plan } from "../generated/text_plan.ts"; // Załóżmy, że plan jest wyeksportowany stąd
import { ChatBatch as BebopChatBatch } from "../bebop/generatedText.ts";
import { LayoutPlan } from "@schema-pop/schema";

const packr = new Packr({ useRecords: false });
const packrR = new Packr({ useRecords: true });

const fixture = makeTextFixture(7);

// ── Inicjalizacja kodeków z @schema-pop/core ─────────────────────────────────
const jitSuite = createRuntimeCodec(LayoutPlan.assert(plan));
const interpSuite = createInterpretedCodec(LayoutPlan.assert(plan));

const jitChatBatch = jitSuite.get<ChatBatchLit>("ChatBatch");
const interpChatBatch = interpSuite.get<ChatBatchLit>("ChatBatch");

// ── Pre-alokacja buforów ──────────────────────────────────────────────────────
const CODEC_SIZE = 1220;
const codecBuf = new ArrayBuffer(CODEC_SIZE);
const codecView = new DataView(codecBuf);

// ── Pre-encode do testów dekodowania ──────────────────────────────────────────
serializeChatBatch(fixture, codecView, 0);
const jsonStr = JSON.stringify(fixture);
const jsonBytes = new TextEncoder().encode(jsonStr);
const msgpackBytes = packr.pack(fixture);
for (let i = 0; i < 4; i++) packrR.pack(fixture);
const msgpackRecBytes = packrR.pack(fixture);
const bebopBytes = BebopChatBatch.encode(fixture as any);

// ── Weryfikacja poprawności ──────────────────────────────────────────────────
function approxEq(a: any, b: any, tol = 1e-3): boolean {
	if (typeof a === "number" && typeof b === "number") {
		return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => approxEq(v, b[i], tol));
	}
	if (a && b && typeof a === "object") {
		const keys = new Set(
			[...Object.keys(a), ...Object.keys(b)].filter(
				(k) =>
					typeof (a as any)[k] !== "function" &&
					typeof (b as any)[k] !== "function",
			),
		);
		for (const k of keys) if (!approxEq(a[k], b[k], tol)) return false;
		return true;
	}
	return a === b;
}

const decodedCodec = deserializeChatBatch(codecView, 0);
const decodedJit = jitChatBatch.deserialize(codecView, 0);
const decodedInterp = interpChatBatch.deserialize(codecView, 0);
const decodedJson = JSON.parse(jsonStr);
const decodedMsgpack = packr.unpack(msgpackBytes);
const decodedMsgpackRec = packrR.unpack(msgpackRecBytes);
const decodedBebop = BebopChatBatch.decode(bebopBytes);

console.log("correctness:", {
	codecAOT: approxEq(fixture, decodedCodec),
	codecJIT: approxEq(fixture, decodedJit),
	codecInterp: approxEq(fixture, decodedInterp),
	json: approxEq(fixture, decodedJson),
	msgpack: approxEq(fixture, decodedMsgpack),
	msgpackRec: approxEq(fixture, decodedMsgpackRec),
	bebop: approxEq(fixture, decodedBebop),
});

console.log("\npayload sizes (bytes):");
console.log(`  ts:codec     ${CODEC_SIZE}  (fixed-size string slots)`);
console.log(`  bebop        ${bebopBytes.length}`);
console.log(`  msgpackr+rec ${msgpackRecBytes.length}`);
console.log(`  msgpackr     ${msgpackBytes.length}`);
console.log(`  JSON         ${jsonBytes.length}`);
console.log("");

// ── Bencze ───────────────────────────────────────────────────────────────────

summary(() => {
	group("encode", () => {
		bench("ts:codec (AOT generated)", () => {
			serializeChatBatch(fixture, codecView, 0);
			do_not_optimize(codecBuf);
		});
		bench("ts:codec (Runtime JIT)", () => {
			jitChatBatch.serialize(fixture, codecView, 0);
			do_not_optimize(codecBuf);
		});
		bench("ts:codec (Interpreted)", () => {
			interpChatBatch.serialize(fixture, codecView, 0);
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
		bench("ts:codec (AOT generated)", () => {
			do_not_optimize(deserializeChatBatch(codecView, 0));
		});
		bench("ts:codec (Runtime JIT)", () => {
			do_not_optimize(jitChatBatch.deserialize(codecView, 0));
		});
		bench("ts:codec (Interpreted)", () => {
			do_not_optimize(interpChatBatch.deserialize(codecView, 0));
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
		bench("ts:codec (AOT generated)", () => {
			serializeChatBatch(fixture, codecView, 0);
			do_not_optimize(deserializeChatBatch(codecView, 0));
		});
		bench("ts:codec (Runtime JIT)", () => {
			jitChatBatch.serialize(fixture, codecView, 0);
			do_not_optimize(jitChatBatch.deserialize(codecView, 0));
		});
		bench("ts:codec (Interpreted)", () => {
			interpChatBatch.serialize(fixture, codecView, 0);
			do_not_optimize(interpChatBatch.deserialize(codecView, 0));
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