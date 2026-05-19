import { scope } from "arktype";
import { binary } from "@schema-pop/schema";

// A moderately complex schema: a "GameTick" with 8 players.
// Mix of primitives, fixed-length vectors, nested struct refs and a
// fixed-length array of structs. No bigints (avoid JSON pain) and no
// strings (msgpack/JSON would have a huge advantage on text-heavy
// payloads — keep the comparison focused on numeric/binary work).
export const benchSchema = scope({
	...binary.import(),
	Vec3: "f32[] == 3",
	Player: {
		id: "u32",
		pos: "Vec3",
		vel: "Vec3",
		health: "u16",
		score: "u32",
		team: "u8",
	},
	GameTick: {
		tick: "u32",
		dt: "f32",
		flags: "u8",
		players: "Player[] == 8",
	},
});

export const ROOT_TYPE = "GameTick";

export type Vec3Lit = [number, number, number];
export interface PlayerLit {
	id: number;
	pos: Vec3Lit;
	vel: Vec3Lit;
	health: number;
	score: number;
	team: number;
}
export interface GameTickLit {
	tick: number;
	dt: number;
	flags: number;
	players: PlayerLit[];
}

export function makeFixture(seed = 1): GameTickLit {
	let s = seed >>> 0;
	const rand = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
	const v3 = (): Vec3Lit => [rand() * 100, rand() * 100, rand() * 100];
	const player = (i: number): PlayerLit => ({
		id: i,
		pos: v3(),
		vel: v3(),
		health: Math.floor(rand() * 65535),
		score: Math.floor(rand() * 4_000_000_000),
		team: Math.floor(rand() * 8),
	});
	return {
		tick: Math.floor(rand() * 1_000_000),
		dt: rand(),
		flags: Math.floor(rand() * 256),
		players: Array.from({ length: 8 }, (_, i) => player(i)),
	};
}
