// Hand-written DataView codec — same wire format as the generated tsCodec.
// Used as the "ceiling" reference: how much perf is left on the table by
// the codegen approach vs. a bespoke implementation a human would write.

import type { GameTickLit, PlayerLit } from "./schema.ts";

const PLAYER_SIZE = 40;
const GAMETICK_SIZE = 332;
export const HAND_SIZE = GAMETICK_SIZE;

export function handEncode(t: GameTickLit, view: DataView, off = 0): void {
	view.setFloat32(off + 0, t.dt, true);
	view.setUint8(off + 4, t.flags);
	const players = t.players;
	for (let i = 0; i < 8; i++) {
		const p = players[i]!;
		const o = off + 8 + i * PLAYER_SIZE;
		view.setUint16(o + 0, p.health, true);
		view.setUint32(o + 4, p.id, true);
		view.setFloat32(o + 8, p.pos[0], true);
		view.setFloat32(o + 12, p.pos[1], true);
		view.setFloat32(o + 16, p.pos[2], true);
		view.setUint32(o + 20, p.score, true);
		view.setUint8(o + 24, p.team);
		view.setFloat32(o + 28, p.vel[0], true);
		view.setFloat32(o + 32, p.vel[1], true);
		view.setFloat32(o + 36, p.vel[2], true);
	}
	view.setUint32(off + 328, t.tick, true);
}

export function handDecode(view: DataView, off = 0): GameTickLit {
	const players: PlayerLit[] = [];
	for (let i = 0; i < 8; i++) {
		const o = off + 8 + i * PLAYER_SIZE;
		players.push({
			health: view.getUint16(o + 0, true),
			id: view.getUint32(o + 4, true),
			pos: [
				view.getFloat32(o + 8, true),
				view.getFloat32(o + 12, true),
				view.getFloat32(o + 16, true),
			],
			score: view.getUint32(o + 20, true),
			team: view.getUint8(o + 24),
			vel: [
				view.getFloat32(o + 28, true),
				view.getFloat32(o + 32, true),
				view.getFloat32(o + 36, true),
			],
		});
	}
	return {
		dt: view.getFloat32(off + 0, true),
		flags: view.getUint8(off + 4),
		players,
		tick: view.getUint32(off + 328, true),
	};
}
