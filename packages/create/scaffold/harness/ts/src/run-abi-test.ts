import * as schema from "./schema";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { PopCodec, type LayoutPlan } from "schema-pop";
import { random } from "@schema-pop/core-exporters";

const execDir = import.meta.dir;
const targets = [
	{ name: "Rust", bin: join(execDir, "../../rust/harness"), layoutOnly: false },
	{ name: "C++", bin: join(execDir, "../../cpp/harness"), layoutOnly: false },
	{ name: "Zig", bin: join(execDir, "../../zig/harness"), layoutOnly: false },
	{ name: "BF", bin: join(execDir, "../../bf/harness"), layoutOnly: true },
];

const COUNT_PER_TYPE = 8;
let totalChecks = 0;
let totalFailures = 0;
let totalSkips = 0;

console.log("🛡️  Cross-Language ABI Consistency Test\n");

const versions = Object.keys(schema).filter(
	(k) => (schema as any)[k]?.LAYOUT_PLAN,
);

for (const vKey of versions) {
	const v = (schema as any)[vKey];
	const plan = v.LAYOUT_PLAN as LayoutPlan;
	const codec = new PopCodec(plan);

	const dataset = JSON.parse(
		random({ count: COUNT_PER_TYPE, seed: 42 }).generate(plan) as string,
	) as Record<string, any[]>;

	console.log(`📁 Version: ${vKey}\n`);

	for (const target of targets) {
		if (!existsSync(target.bin)) {
			console.log(
				`  ⏭️  ${target.name}: harness binary not found, skipping (${target.bin})`,
			);
			continue;
		}

		console.log(`  ▶️  ${target.name}`);

		const layoutProc = spawnSync(target.bin, ["layout"], { encoding: "utf-8" });
		if (layoutProc.status !== 0) {
			console.error(`    ❌ layout failed: ${layoutProc.stderr}`);
			totalFailures++;
			continue;
		}
		const nativeLayouts = new Map<string, { size: number; align: number }>();
		for (const line of layoutProc.stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const [ver, name, size, align] = trimmed.split(",");
			if (ver && name && size && align) {
				nativeLayouts.set(`${ver}::${name}`, {
					size: parseInt(size, 10),
					align: parseInt(align, 10),
				});
			}
		}

		// Single-version exporters (BF, C, …) only emit the latest schema
		// version. If the harness reports zero types for this vKey, assume
		// it's that case and skip — anything else (some types missing but
		// not all) is still treated as a real bug.
		const versionPrefix = `${vKey}::`;
		const hasAnyTypeForVersion = [...nativeLayouts.keys()].some((k) =>
			k.startsWith(versionPrefix),
		);
		if (!hasAnyTypeForVersion) {
			const structCount = plan.types.filter((t) => t.kind === "struct").length;
			console.log(
				`    ⏭️  skipping ${structCount} type(s) — single-version exporter, schema not emitted for this version`,
			);
			totalSkips += structCount;
			continue;
		}

		for (const t of plan.types) {
			if (t.kind !== "struct") continue;
			const items = dataset[t.name];
			if (!items) continue;

			totalChecks++;

			const layoutKey = `${vKey}::${t.name}`;
			const native = nativeLayouts.get(layoutKey);
			if (!native) {
				console.error(`    ❌ ${t.name}: no layout from native`);
				totalFailures++;
				continue;
			}
			if (native.size !== t.paddedSize || native.align !== t.align) {
				console.error(
					`    ❌ ${t.name}: layout mismatch — TS ${t.paddedSize}/${t.align} vs native ${native.size}/${native.align}`,
				);
				totalFailures++;
				continue;
			}

			if (target.layoutOnly) {
				console.log(`    ✅ ${t.name} (layout ${t.paddedSize}/${t.align})`);
				continue;
			}

			const expected = new Uint8Array(items.length * t.paddedSize);
			for (let i = 0; i < items.length; i++) {
				const bytes = codec.encode(t.name, items[i]);
				expected.set(bytes, i * t.paddedSize);
			}

			const rt = spawnSync(target.bin, ["roundtrip", vKey, t.name], {
				input: expected,
				maxBuffer: 64 * 1024 * 1024,
			});
			if (rt.status !== 0) {
				console.error(
					`    ❌ ${t.name}: roundtrip exit ${rt.status} — ${rt.stderr.toString()}`,
				);
				totalFailures++;
				continue;
			}
			const got = new Uint8Array(rt.stdout);
			if (got.length !== expected.length) {
				console.error(
					`    ❌ ${t.name}: bytes length ${got.length} ≠ ${expected.length}`,
				);
				totalFailures++;
				continue;
			}
			let mismatch = -1;
			for (let i = 0; i < got.length; i++) {
				if (got[i] !== expected[i]) {
					mismatch = i;
					break;
				}
			}
			if (mismatch >= 0) {
				console.error(`    ❌ ${t.name}: byte mismatch at offset ${mismatch}`);
				totalFailures++;
				continue;
			}
			console.log(`    ✅ ${t.name} (${items.length} × ${t.paddedSize}b)`);
		}
	}
	console.log("");
}

const skipNote =
	totalSkips > 0 ? ` (${totalSkips} skipped — single-version exporters)` : "";
if (totalFailures > 0) {
	console.error(
		`\n💥 ${totalFailures} / ${totalChecks} checks failed${skipNote}.`,
	);
	process.exit(1);
}

console.log(`✨ All ${totalChecks} ABI checks passed${skipNote}!`);
