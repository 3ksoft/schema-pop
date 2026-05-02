/**
 * Quick throughput benchmark for PopCodec encode + decode. Not a
 * scientific suite — just a one-shot sanity check that orders of
 * magnitude look reasonable and that future codec changes don't
 * silently regress 10×. Run with:
 *
 *     bun run packages/core/src/codec/pop.bench.ts
 *
 * Output columns: ops/sec, ns/op, throughput (MB/s) based on the
 * encoded payload size.
 */
import { binary, scope } from "schema-pop";
import { SchemaAnalyzer } from "../layout/analyzer";
import { PopCodec } from "./pop";

interface Bench {
	name: string;
	bytes: number;
	encode: () => void;
	decode: () => void;
}

function buildBenches(): Bench[] {
	// 1. Small struct — primitives only, ~24 bytes.
	const smallScope = scope({
		...binary.import(),
		Small: {
			a: "u32",
			b: "u32",
			c: "u32",
			d: "u32",
			e: "u32",
			f: "u32",
		},
	});
	const smallPlan = new SchemaAnalyzer(smallScope as any, {}).analyze("v");
	const smallCodec = new PopCodec(smallPlan);
	const smallData = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
	const smallBuf = smallCodec.encode("Small", smallData);

	// 2. Medium struct — strings + arrays, mimics konektor SystemHealth.
	const medScope = scope({
		...binary.import(),
		Status: {
			uptime_secs: "u64",
			heap_free: "u32",
			heap_used: "u32",
			version: "string<=16",
			role: "string<=16",
			boot_slot: "string<=8",
			samples: "u16[] == 16",
		},
	});
	const medPlan = new SchemaAnalyzer(medScope as any, {}).analyze("v");
	const medCodec = new PopCodec(medPlan);
	const medData = {
		uptime_secs: 12345n,
		heap_free: 200_000,
		heap_used: 50_000,
		version: "0.0.728",
		role: "Master",
		boot_slot: "A",
		samples: Array.from({ length: 16 }, (_, i) => i * 100),
	};
	const medBuf = medCodec.encode("Status", medData);

	// 3. Tagged union — three variants of distinct shape. Encodes the
	//    second variant so we exercise non-zero tag dispatch.
	const unionScope = scope({
		...binary.import(),
		Heartbeat: { uptime: "u64" },
		Reading: { value: "i32", precision: "f32" },
		Telemetry: { msg: "string<=32", count: "u32" },
		M: "Heartbeat | Reading | Telemetry",
	});
	const unionPlan = new SchemaAnalyzer(unionScope as any, {}).analyze("v");
	const unionCodec = new PopCodec(unionPlan);
	const unionData = { kind: "Reading", value: 42, precision: 0.001 };
	const unionBuf = unionCodec.encode("M", unionData);

	return [
		{
			name: `Small struct (${smallBuf.byteLength} B)`,
			bytes: smallBuf.byteLength,
			encode: () => smallCodec.encode("Small", smallData),
			decode: () => smallCodec.decode("Small", smallBuf),
		},
		{
			name: `Medium status (${medBuf.byteLength} B, strings + arrays)`,
			bytes: medBuf.byteLength,
			encode: () => medCodec.encode("Status", medData),
			decode: () => medCodec.decode("Status", medBuf),
		},
		{
			name: `Tagged union, Reading variant (${unionBuf.byteLength} B)`,
			bytes: unionBuf.byteLength,
			encode: () => unionCodec.encode("M", unionData),
			decode: () => unionCodec.decode("M", unionBuf),
		},
	];
}

function bench(name: string, op: () => void, bytes: number): void {
	// Warmup — JIT, branch predictor, allocator.
	for (let i = 0; i < 5_000; i++) op();

	// Time a chunk; resize until we hit ~200ms so noise is below 5%.
	const targetNs = 200_000_000;
	let iters = 10_000;
	let elapsedNs = 0;
	while (elapsedNs < targetNs && iters < 100_000_000) {
		const t0 = Bun.nanoseconds();
		for (let i = 0; i < iters; i++) op();
		elapsedNs = Bun.nanoseconds() - t0;
		if (elapsedNs < targetNs / 4) iters *= 4;
		else break;
	}
	const nsPerOp = elapsedNs / iters;
	const opsPerSec = 1e9 / nsPerOp;
	const mbPerSec = (bytes * opsPerSec) / 1e6;
	console.log(
		`  ${name.padEnd(10)} ${formatRate(opsPerSec).padStart(14)}  ${nsPerOp.toFixed(0).padStart(7)} ns/op  ${mbPerSec.toFixed(1).padStart(7)} MB/s`,
	);
}

function formatRate(opsPerSec: number): string {
	if (opsPerSec >= 1e6) return `${(opsPerSec / 1e6).toFixed(2)}M ops/s`;
	if (opsPerSec >= 1e3) return `${(opsPerSec / 1e3).toFixed(0)}k ops/s`;
	return `${opsPerSec.toFixed(0)} ops/s`;
}

function main() {
	console.log(`PopCodec throughput  (Bun ${Bun.version})\n`);
	const benches = buildBenches();
	for (const b of benches) {
		console.log(b.name);
		bench("encode", b.encode, b.bytes);
		bench("decode", b.decode, b.bytes);
		console.log();
	}
}

main();
