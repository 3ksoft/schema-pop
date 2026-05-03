#!/usr/bin/env bun
/**
 * Corpus harness, `.layout.json` flavour. Runs the importer's new
 * direct-LayoutPlan path on every file in a source tree and reports:
 *
 *  - hard import failures (clang invocation / parse / IR-build crashed)
 *  - skipped items (importer recognised the shape but couldn't model it
 *    — e.g. function pointers, multi-dim arrays, opaque templates)
 *  - per-item type counts that survived through to the final
 *    `LayoutPlan` (which is what exporters consume)
 *
 * Compared to `corpus-run.ts` this drops the analyzer/jiti pass 2 and
 * the IR-shape diff pass 3 entirely — the new flow doesn't round-trip
 * through arktype scope source, so there's nothing to diff against.
 * The 27 emit.ts roundtrip bugs from the old run should disappear; if
 * fresh failures show up, they live in `computeLayoutPlan` (Phase 5
 * derive logic) or one rung up in the importer.
 *
 * Usage:
 *   bun scripts/corpus-run-layout.ts <source-dir> [output-dir]
 *
 *   # ESP-IDF — overnight job, results in ./corpus-out-layout/
 *   bun scripts/corpus-run-layout.ts ~/esp-idf
 *
 * Output:
 *   <out>/out/                — one .layout.json per imported source
 *   <out>/report.json         — aggregated stats, top failure buckets
 *   <out>/import-errors.csv   — file,reason for hard import failures
 *   <out>/skipped.csv         — file,kind,name,bucket,reason
 *
 * Exit code is always 0 — research tool, not a CI gate.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	fileToLayoutPlan,
	importFile,
	pickEngine,
} from "../packages/importer/src/index";
import { writeLayoutPlan } from "../packages/core/src/layout-io";

declare const Bun: {
	Glob: new (pattern: string) => {
		scan(opts: { cwd: string; onlyFiles?: boolean }): AsyncIterable<string>;
	};
};

const SOURCE_GLOB = "**/*.{h,hpp,hxx,hh,c,cpp,cxx,cc,rs}";
const PROGRESS_EVERY = 25;

interface ImportError {
	file: string;
	reason: string;
}
interface SkipRow {
	file: string;
	name: string;
	reason: string;
	bucket: string;
}
interface PerFile {
	file: string;
	types: number;
	functions: number;
	skippedItems: number;
}

/**
 * True when a parse produced no schema-shaped types AND no function
 * declarations — the importer ran clean but the source had nothing
 * for us to emit (impl files / stub headers / pure macros). We skip
 * the write to keep `out/` focused on actual content.
 */
function isEmptyPlan(plan: { types: unknown[]; functions?: unknown[] }): boolean {
	return plan.types.length === 0 && (plan.functions?.length ?? 0) === 0;
}

async function main() {
	const root = process.argv[2];
	if (!root) {
		console.error(
			"usage: bun scripts/corpus-run-layout.ts <source-dir> [output-dir]",
		);
		process.exit(1);
	}
	const absRoot = path.resolve(root);
	if (!(await exists(absRoot))) {
		console.error(`corpus-run-layout: source not found: ${absRoot}`);
		process.exit(1);
	}

	const outBase = path.resolve(process.argv[3] ?? "./corpus-out-layout");
	const outDir = path.join(outBase, "out");
	await fs.mkdir(outDir, { recursive: true });

	console.log(`source: ${absRoot}`);
	console.log(`output: ${outBase}`);

	const files: string[] = [];
	const g = new Bun.Glob(SOURCE_GLOB);
	for await (const f of g.scan({ cwd: absRoot, onlyFiles: true })) {
		files.push(f);
	}
	console.log(`found ${files.length} source files matching ${SOURCE_GLOB}`);
	if (files.length === 0) process.exit(0);

	const importErrors: ImportError[] = [];
	const skipped: SkipRow[] = [];
	const perFile: PerFile[] = [];
	let emptyImports = 0;
	const t0 = Date.now();

	for (let i = 0; i < files.length; i++) {
		const rel = files[i]!;
		const abs = path.join(absRoot, rel);
		if (i % PROGRESS_EVERY === 0) {
			const eta =
				i === 0
					? "?"
					: `${(((Date.now() - t0) / i) * (files.length - i) / 1000).toFixed(0)}s`;
			console.log(
				`  [${i}/${files.length}] elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s eta ${eta}`,
			);
		}
		try {
			const lang = pickEngine(abs).lang as "rust" | "c" | "c++";
			// Two-step so we can capture skipped items before the layout pass.
			const ir = await importFile(abs, { lang });
			for (const s of ir.skipped) {
				skipped.push({
					file: rel,
					name: s.name,
					reason: s.reason,
					bucket: bucketReason(s.reason),
				});
			}
			const plan = await fileToLayoutPlan(abs, { lang });
			if (isEmptyPlan(plan)) {
				// Nothing to write — record so the report still shows the
				// file was processed, but don't pollute out/ with empty
				// plans (or the per-file CSV with zero-row entries).
				emptyImports++;
				continue;
			}
			const safeName = rel.replace(/[/\\]/g, "__");
			await writeLayoutPlan(plan, path.join(outDir, `${safeName}.layout.json`));
			perFile.push({
				file: rel,
				types: plan.types.length,
				functions: plan.functions?.length ?? 0,
				skippedItems: ir.skipped.length,
			});
		} catch (e) {
			importErrors.push({
				file: rel,
				reason: oneLine((e as Error).message),
			});
		}
	}

	const skipBuckets = new Map<string, number>();
	for (const s of skipped) {
		skipBuckets.set(s.bucket, (skipBuckets.get(s.bucket) ?? 0) + 1);
	}
	const importBuckets = new Map<string, number>();
	for (const e of importErrors) {
		const b = bucketReason(e.reason);
		importBuckets.set(b, (importBuckets.get(b) ?? 0) + 1);
	}

	const totalTypes = perFile.reduce((s, p) => s + p.types, 0);
	const totalFns = perFile.reduce((s, p) => s + p.functions, 0);
	const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

	const report = {
		source: absRoot,
		ranAt: new Date().toISOString(),
		mode: "layout-json",
		summary: {
			scanned: files.length,
			imported: perFile.length,
			importErrored: importErrors.length,
			emptyImports,
			skippedItems: skipped.length,
			totalTypes,
			totalFunctions: totalFns,
			elapsedSec: Number(elapsedSec),
		},
		topSkipBuckets: sortedTop(skipBuckets, 30),
		topImportErrorBuckets: sortedTop(importBuckets, 30),
	};

	await fs.writeFile(
		path.join(outBase, "report.json"),
		JSON.stringify(report, null, "\t"),
		"utf8",
	);
	await fs.writeFile(
		path.join(outBase, "import-errors.csv"),
		toCsv(["file", "reason"], importErrors.map((e) => [e.file, e.reason])),
		"utf8",
	);
	await fs.writeFile(
		path.join(outBase, "skipped.csv"),
		toCsv(
			["file", "name", "bucket", "reason"],
			skipped.map((s) => [s.file, s.name, s.bucket, s.reason]),
		),
		"utf8",
	);
	await fs.writeFile(
		path.join(outBase, "per-file.csv"),
		toCsv(
			["file", "types", "functions", "skippedItems"],
			perFile.map((p) => [
				p.file,
				String(p.types),
				String(p.functions),
				String(p.skippedItems),
			]),
		),
		"utf8",
	);

	const bar = "=".repeat(60);
	console.log(`\n${bar}\nCORPUS RUN COMPLETE (.layout.json mode)\n${bar}`);
	console.log(`scanned                ${files.length}`);
	console.log(`imported               ${perFile.length}`);
	console.log(`empty (no types/fns)   ${emptyImports}`);
	console.log(`import errors          ${importErrors.length}`);
	console.log(`skipped items          ${skipped.length}`);
	console.log(`total types            ${totalTypes}`);
	console.log(`total functions        ${totalFns}`);
	console.log(`elapsed                ${elapsedSec}s`);
	if (skipBuckets.size > 0) {
		console.log(`\ntop 10 skip buckets:`);
		for (const [b, n] of sortedTop(skipBuckets, 10)) {
			console.log(`  ${String(n).padStart(6)}  ${b}`);
		}
	}
	if (importBuckets.size > 0) {
		console.log(`\ntop 10 import-error buckets:`);
		for (const [b, n] of sortedTop(importBuckets, 10)) {
			console.log(`  ${String(n).padStart(6)}  ${b}`);
		}
	}
	console.log(
		`\nfull report:           ${path.relative(process.cwd(), path.join(outBase, "report.json"))}`,
	);
	console.log(
		`per-file:              ${path.relative(process.cwd(), path.join(outBase, "per-file.csv"))}`,
	);
}

function bucketReason(reason: string): string {
	const stripped = reason
		.replace(/"[^"]*"/g, '"…"')
		.replace(/`[^`]*`/g, "`…`");
	const head = stripped.split(/[:(]/)[0]!.trim();
	return head.length > 80 ? head.slice(0, 77) + "..." : head;
}

function sortedTop(m: Map<string, number>, n: number): Array<[string, number]> {
	return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

function toCsv(header: string[], rows: string[][]): string {
	const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
	return (
		header.map(esc).join(",") +
		"\n" +
		rows.map((r) => r.map(esc).join(",")).join("\n") +
		"\n"
	);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
