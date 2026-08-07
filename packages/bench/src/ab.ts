/**
 * Interleaved A/B harness for codec micro-benchmarks.
 *
 * `run.ts` (mitata) answers "how does schema-pop compare to msgpackr/bebop".
 * It is not the right tool for "did this generator change make decode faster",
 * because it measures each variant to completion in turn: anything that drifts
 * over the life of the process — CPU frequency, GC pressure, JIT tier-up, other
 * load on the box — lands on whichever variant happened to run then, and shows
 * up as a double-digit swing between runs.
 *
 * This harness is built for the A/B question instead:
 *
 *   - ROUND-ROBIN: every round times every variant, so drift hits all of them
 *     roughly equally instead of biasing one.
 *   - ROTATION: the within-round order shifts each round, cancelling the
 *     first-position advantage (cold caches on entry, warm ones later).
 *   - MEDIAN, not mean: one descheduled round can't drag the number.
 *   - MULTI-PROCESS: `--processes N` pools rounds from N fresh processes.
 *     Code layout and JIT decisions are fixed per process, so a single process
 *     can be reproducibly-but-misleadingly fast; pooling exposes that.
 *
 * Usage:
 *   bun src/ab.ts                          # decode + encode, defaults
 *   bun src/ab.ts --rounds 60 --iters 2000
 *   bun src/ab.ts --processes 5            # pool across 5 fresh processes
 *   bun src/ab.ts --only decode
 */

import {
	createInterpretedCodec,
	createRuntimeCodec,
} from "@schema-pop/core";
import { LayoutPlan } from "@schema-pop/schema";
import { makeFixture, type GameTickLit } from "./schema.ts";
import {
	deserializeGameTick,
	serializeGameTick,
} from "../generated/data_codec.ts";
// Frozen copy of the generator's previous output (IIFE + `push` + call per
// element), kept so generator changes can be A/B'd against what they replaced.
import {
	deserializeGameTick_base,
	serializeGameTick_base,
} from "./codec-baseline.ts";
import { plan } from "../generated/data_plan.ts";
import { handDecode, handEncode, HAND_SIZE } from "./handcoded.ts";

interface Variant {
	name: string;
	fn: () => void;
}

interface Options {
	rounds: number;
	iters: number;
	warmup: number;
	processes: number;
	/** Restrict to these variant names — makes the paired ratio a direct A/B. */
	variants: string[] | null;
	only: string | null;
	json: boolean;
}

function parseArgs(argv: string[]): Options {
	const get = (flag: string, fallback: number) => {
		const i = argv.indexOf(flag);
		return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
	};
	const onlyIdx = argv.indexOf("--only");
	const variantsIdx = argv.indexOf("--variants");
	return {
		variants:
			variantsIdx >= 0 && argv[variantsIdx + 1]
				? argv[variantsIdx + 1]!.split(",")
				: null,
		// Bursts are deliberately long: decode allocates, so a burst has to span
		// many nursery collections for the per-burst GC cost to stop being a
		// coin flip. At 50k iters the paired IQR lands near ±9%; at 5k it is
		// ±30% for exactly the same code.
		rounds: get("--rounds", 25),
		iters: get("--iters", 50_000),
		warmup: get("--warmup", 20_000),
		processes: get("--processes", 1),
		only: onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? null) : null,
		json: argv.includes("--json"),
	};
}

const opts = parseArgs(Bun.argv.slice(2));

// ── Subjects ─────────────────────────────────────────────────────────────────

const fixture = makeFixture(42);
const jitCodec = createRuntimeCodec(LayoutPlan.assert(plan)).get<GameTickLit>(
	"GameTick",
);
const interpCodec = createInterpretedCodec(
	LayoutPlan.assert(plan),
).get<GameTickLit>("GameTick");

const codecView = new DataView(new ArrayBuffer(332));
const handView = new DataView(new ArrayBuffer(HAND_SIZE));
serializeGameTick(fixture, codecView, 0);
handEncode(fixture, handView, 0);

// `sink` keeps the optimizer from deleting the work whose result we discard.
let sink: unknown = null;

const GROUPS: Record<string, Variant[]> = {
	decode: [
		{ name: "AOT opt", fn: () => void (sink = deserializeGameTick(codecView, 0)) },
		{ name: "AOT base", fn: () => void (sink = deserializeGameTick_base(codecView, 0)) },
		{ name: "Runtime JIT", fn: () => void (sink = jitCodec.deserialize(codecView, 0)) },
		{ name: "Interpreted", fn: () => void (sink = interpCodec.deserialize(codecView, 0)) },
		{ name: "hand-DataView", fn: () => void (sink = handDecode(handView, 0)) },
	],
	encode: [
		{ name: "AOT opt", fn: () => serializeGameTick(fixture, codecView, 0) },
		{ name: "AOT base", fn: () => serializeGameTick_base(fixture, codecView, 0) },
		{ name: "Runtime JIT", fn: () => jitCodec.serialize(fixture, codecView, 0) },
		{ name: "Interpreted", fn: () => interpCodec.serialize(fixture, codecView, 0) },
		{ name: "hand-DataView", fn: () => handEncode(fixture, handView, 0) },
	],
};

// ── Measurement ──────────────────────────────────────────────────────────────

/** Nanoseconds per iteration for one timed burst. */
function timeBurst(fn: () => void, iters: number): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < iters; i++) fn();
	return (Bun.nanoseconds() - start) / iters;
}

/**
 * One round-robin pass per round, with the starting variant rotated so no
 * variant keeps the first (or last) slot.
 */
function measureGroup(variants: Variant[], o: Options): Map<string, number[]> {
	const samples = new Map<string, number[]>(variants.map((v) => [v.name, []]));

	for (const v of variants) {
		// Warm up to a steady tier before any sample counts.
		let burn = o.warmup;
		while (burn > 0) {
			v.fn();
			burn--;
		}
	}

	for (let round = 0; round < o.rounds; round++) {
		for (let k = 0; k < variants.length; k++) {
			const v = variants[(round + k) % variants.length]!;
			samples.get(v.name)!.push(timeBurst(v.fn, o.iters));
		}
	}
	return samples;
}

// ── Statistics ───────────────────────────────────────────────────────────────

const quantile = (sorted: number[], q: number): number => {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

interface Stats {
	median: number;
	p25: number;
	p75: number;
	min: number;
	/** Interquartile range as a share of the median — the noise indicator. */
	spread: number;
	n: number;
}

function summarize(values: number[]): Stats {
	const sorted = [...values].sort((a, b) => a - b);
	const median = quantile(sorted, 0.5);
	const p25 = quantile(sorted, 0.25);
	const p75 = quantile(sorted, 0.75);
	return {
		median,
		p25,
		p75,
		min: sorted[0]!,
		spread: (p75 - p25) / median,
		n: sorted.length,
	};
}

/**
 * Mann-Whitney U via normal approximation. Non-parametric on purpose: burst
 * timings are right-skewed (descheduling only ever makes things slower), so a
 * t-test's normality assumption does not hold.
 */
function significant(a: number[], b: number[]): boolean {
	const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
		(x, y) => x.v - y.v,
	);
	let rankSumA = 0;
	for (let i = 0; i < all.length; i++) if (all[i]!.g === 0) rankSumA += i + 1;
	const n1 = a.length;
	const n2 = b.length;
	const u = rankSumA - (n1 * (n1 + 1)) / 2;
	const mean = (n1 * n2) / 2;
	const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
	return Math.abs((u - mean) / sd) > 1.96; // two-sided, α = 0.05
}

// ── Child-process pooling ────────────────────────────────────────────────────

async function poolAcrossProcesses(o: Options): Promise<Record<string, Record<string, number[]>>> {
	const pooled: Record<string, Record<string, number[]>> = {};
	for (let p = 0; p < o.processes; p++) {
		const args = [
			"bun",
			import.meta.path,
			"--json",
			"--rounds",
			String(o.rounds),
			"--iters",
			String(o.iters),
			"--warmup",
			String(o.warmup),
			...(o.only ? ["--only", o.only] : []),
			...(o.variants ? ["--variants", o.variants.join(",")] : []),
		];
		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const parsed = JSON.parse(out) as Record<string, Record<string, number[]>>;
		for (const [group, variants] of Object.entries(parsed)) {
			pooled[group] ??= {};
			for (const [name, values] of Object.entries(variants)) {
				(pooled[group]![name] ??= []).push(...values);
			}
		}
		process.stderr.write(`  process ${p + 1}/${o.processes} done\n`);
	}
	return pooled;
}

// ── Reporting ────────────────────────────────────────────────────────────────

function report(group: string, samples: Record<string, number[]>) {
	const names = Object.keys(samples);
	const stats = new Map(names.map((n) => [n, summarize(samples[n]!)]));
	const baselineName = names.reduce((best, n) =>
		stats.get(n)!.median < stats.get(best)!.median ? n : best,
	);
	const baseSamples = samples[baselineName]!;

	console.log(`\n• ${group}`);
	console.log(
		"  " +
		"variant".padEnd(16) +
		"median".padStart(11) +
		"abs".padStart(8) +
		"    paired vs " +
		baselineName,
	);
	for (const name of names) {
		const s = stats.get(name)!;
		if (name === baselineName) {
			console.log(
				"  " +
				name.padEnd(16) +
				`${s.median.toFixed(1)} ns`.padStart(11) +
				`${(s.spread * 100).toFixed(0)}%`.padStart(8) +
				"    baseline",
			);
			continue;
		}
		// PAIRED ratio: variant and baseline are timed inside the SAME round, so
		// a clock-speed change or a scheduling hiccup scales both and cancels in
		// the quotient. This is the number to trust on a noisy desktop — the
		// absolute medians can swing 2x between runs while these stay put.
		const ratios = samples[name]!.map((v, i) => v / baseSamples[i]!);
		const r = summarize(ratios);
		const sig = significant(samples[name]!, baseSamples) ? "" : "  (n.s.)";
		console.log(
			"  " +
			name.padEnd(16) +
			`${s.median.toFixed(1)} ns`.padStart(11) +
			`${(s.spread * 100).toFixed(0)}%`.padStart(8) +
			`    ${r.median.toFixed(3)}x  [${r.p25.toFixed(3)}…${r.p75.toFixed(3)}] ±${((r.spread / 2) * 100).toFixed(1)}%${sig}`,
		);
	}

	const worstAbs = Math.max(...names.map((n) => stats.get(n)!.spread));
	const worstPaired = Math.max(
		...names
			.filter((n) => n !== baselineName)
			.map((n) => summarize(samples[n]!.map((v, i) => v / baseSamples[i]!)).spread),
	);
	console.log(
		`  noise: absolute IQR up to ${(worstAbs * 100).toFixed(0)}%, paired IQR up to ${(worstPaired * 100).toFixed(1)}%`,
	);
	if (worstPaired > 0.05) {
		console.log(
			"  ⚠ even paired ratios are noisy — quiet the machine (this box runs plasma/sunshine/krfb) or raise --iters",
		);
	}
}

// ── Entry ────────────────────────────────────────────────────────────────────

const filterVariants = (vs: Variant[]): Variant[] =>
	opts.variants ? vs.filter((v) => opts.variants!.includes(v.name)) : vs;

const groups = opts.only
	? { [opts.only]: GROUPS[opts.only] ?? [] }
	: GROUPS;

if (opts.processes > 1) {
	process.stderr.write(
		`pooling ${opts.rounds} rounds × ${opts.iters} iters across ${opts.processes} processes\n`,
	);
	const pooled = await poolAcrossProcesses({ ...opts, processes: opts.processes });
	for (const [group, samples] of Object.entries(pooled)) report(group, samples);
} else {
	const collected: Record<string, Record<string, number[]>> = {};
	for (const [group, variants] of Object.entries(groups)) {
		if (!variants.length) continue;
		const selected = filterVariants(variants);
		if (!selected.length) continue;
		const samples = measureGroup(selected, opts);
		collected[group] = Object.fromEntries(samples);
	}
	if (opts.json) {
		console.log(JSON.stringify(collected));
	} else {
		console.log(
			`${opts.rounds} rounds × ${opts.iters} iters, ${opts.warmup} warmup iters, round-robin + rotation`,
		);
		for (const [group, samples] of Object.entries(collected)) report(group, samples);
	}
}

// Keep `sink` observably live so the decode work can't be optimized away.
if (sink === Symbol.for("never")) console.log(sink);
