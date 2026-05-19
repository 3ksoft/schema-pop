import { bench, group, run, summary, do_not_optimize } from "mitata";
import { Packr } from "msgpackr";
import { makeFixture, type GameTickLit } from "./schema.ts";
import { deserializeGameTick, serializeGameTick } from "../generated/codec.ts";
import { handEncode, handDecode, HAND_SIZE } from "./handcoded.ts";
import { GameTick as BebopGameTick } from "../bebop/generated.ts";

const packr = new Packr({ useRecords: false });
const packrR = new Packr({ useRecords: true });

const fixture = makeFixture(42);

// bebop naturally shapes Vec3 as { x, y, z }, not [x, y, z]. Pre-convert once
// so that the bench measures bebop's encode/decode work, not array→object
// reshape work that wouldn't be charged to other libraries.
const bebopFixture = {
	tick: fixture.tick,
	dt: fixture.dt,
	flags: fixture.flags,
	players: fixture.players.map((p) => ({
		id: p.id,
		pos: { x: p.pos[0], y: p.pos[1], z: p.pos[2] },
		vel: { x: p.vel[0], y: p.vel[1], z: p.vel[2] },
		health: p.health,
		score: p.score,
		team: p.team,
	})),
};

// ── pre-allocate codec buffers (codec produces fixed-size payload) ──────────
const CODEC_SIZE = 332;
const codecBuf = new ArrayBuffer(CODEC_SIZE);
const codecView = new DataView(codecBuf);
const handBuf = new ArrayBuffer(HAND_SIZE);
const handView = new DataView(handBuf);

// ── pre-encode for decode benches ───────────────────────────────────────────
serializeGameTick(fixture, codecView, 0);
handEncode(fixture, handView, 0);
const jsonStr = JSON.stringify(fixture);
const jsonBytes = new TextEncoder().encode(jsonStr);
const msgpackBytes = packr.pack(fixture);
const msgpackRecBytes = packrR.pack(fixture);
// re-pack a few times for record schema to stabilize
for (let i = 0; i < 4; i++) packrR.pack(fixture);
const msgpackRecBytesFinal = packrR.pack(fixture);
const bebopBytes = BebopGameTick.encode(bebopFixture as any);

// ── correctness sanity ──────────────────────────────────────────────────────
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
const decodedCodec = deserializeGameTick(codecView, 0);
const decodedHand = handDecode(handView, 0);
const decodedJson = JSON.parse(jsonStr);
const decodedMsgpack = packr.unpack(msgpackBytes);
const decodedMsgpackRec = packrR.unpack(msgpackRecBytesFinal);
const decodedBebop = BebopGameTick.decode(bebopBytes);
// bebop fixture has Vec3 as {x,y,z} — compare against that shape.
void decodedBebop;
console.log("correctness:", {
	codec: approxEq(fixture, decodedCodec),
	hand: approxEq(fixture, decodedHand),
	json: approxEq(fixture, decodedJson),
	msgpack: approxEq(fixture, decodedMsgpack),
	msgpackRec: approxEq(fixture, decodedMsgpackRec),
	bebop: approxEq(bebopFixture, decodedBebop),
});

console.log("\npayload sizes (bytes):");
console.log(`  ts:codec     ${CODEC_SIZE}`);
console.log(`  hand-DataView ${HAND_SIZE}`);
console.log(`  bebop        ${bebopBytes.length}`);
console.log(`  msgpackr+rec ${msgpackRecBytesFinal.length}`);
console.log(`  msgpackr     ${msgpackBytes.length}`);
console.log(`  JSON         ${jsonBytes.length}`);
console.log("");

// ── benches ─────────────────────────────────────────────────────────────────

summary(() => {
	group("encode", () => {
		bench("ts:codec", () => {
			serializeGameTick(fixture, codecView, 0);
			do_not_optimize(codecBuf);
		});
		bench("hand-DataView", () => {
			handEncode(fixture, handView, 0);
			do_not_optimize(handBuf);
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
			do_not_optimize(BebopGameTick.encode(bebopFixture as any));
		});
	});

	group("decode", () => {
		bench("ts:codec", () => {
			do_not_optimize(deserializeGameTick(codecView, 0));
		});
		bench("hand-DataView", () => {
			do_not_optimize(handDecode(handView, 0));
		});
		bench("JSON.parse", () => {
			do_not_optimize(JSON.parse(jsonStr));
		});
		bench("msgpackr", () => {
			do_not_optimize(packr.unpack(msgpackBytes));
		});
		bench("msgpackr+records", () => {
			do_not_optimize(packrR.unpack(msgpackRecBytesFinal));
		});
		bench("bebop", () => {
			do_not_optimize(BebopGameTick.decode(bebopBytes));
		});
	});

	group("roundtrip", () => {
		bench("ts:codec", () => {
			serializeGameTick(fixture, codecView, 0);
			do_not_optimize(deserializeGameTick(codecView, 0));
		});
		bench("hand-DataView", () => {
			handEncode(fixture, handView, 0);
			do_not_optimize(handDecode(handView, 0));
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
				BebopGameTick.decode(BebopGameTick.encode(bebopFixture as any)),
			);
		});
	});
});

await run({ colors: false });
