#!/usr/bin/env bun
/**
 * Corpus harness — three-pass pipeline + structural diff:
 *
 *   1. import:   <src>/*.{h,hpp,c,cpp,rs}  →  out/<name>.ts
 *      (clang / tree-sitter → arktype scope source)
 *
 *   2. emit:     out/<name>.ts            →  regress/<name>.ts
 *      (ts exporter — runs analyzer; failures here are layout / rich-tier /
 *       unresolved-ref shapes the analyzer can't yet render)
 *
 *   3. diff:     out vs regress (same name)
 *      (parse both via tree-sitter typescript walker, compare IR — types
 *       lost, fields lost, type-name overlap. Tells us what survived
 *       round-trip and what dropped on the floor.)
 *
 * Usage:
 *   bun scripts/corpus-run.ts <source-dir> [output-dir]
 *
 *   # ESP-IDF — overnight job, results in ./corpus-out/
 *   bun scripts/corpus-run.ts ~/esp-idf
 *
 * Output layout:
 *   <out>/out/                   — importer-generated arktype scope sources
 *   <out>/regress/               — ts-exporter-generated TS interfaces
 *   <out>/report.json            — aggregated stats, top failure buckets
 *   <out>/import-errors.csv      — file,reason for hard import failures
 *   <out>/skipped.csv            — file,kind,name,bucket,reason (importer)
 *   <out>/emit-errors.csv        — file,reason for analyzer/emit failures
 *   <out>/diff.csv               — file,typesIn,typesOut,typesLost,fieldsIn,
 *                                  fieldsOut,fieldsLost (per-file structural
 *                                  diff between out/ and regress/)
 *
 * Exit code is always 0 — research tool, not a CI gate.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	fileToArktypeScope,
	importFile,
	pickEngine,
} from "../packages/importer/src/index";
import {
	importFile as tsImportFile,
	type RustItem,
} from "../packages/treesitter_importer/src/index";
import { ts as tsExporter } from "../packages/core-exporters/src/ts";
import { SchemaAnalyzer } from "../packages/core/src/index";
import { isArktypeScope } from "../packages/core/src/bind";
// jiti lives in packages/*/node_modules — pull it from a known
// workspace path rather than relying on root resolution.
import { createJiti } from "../packages/core/node_modules/jiti/lib/jiti.mjs";

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
interface EmitError {
	file: string;
	reason: string;
}
interface DiffRow {
	file: string;
	typesIn: number;
	typesOut: number;
	typesLost: number;
	fieldsIn: number;
	fieldsOut: number;
	fieldsLost: number;
	lostNames: string[];
}

async function main() {
	const root = process.argv[2];
	if (!root) {
		console.error(
			"usage: bun scripts/corpus-run.ts <source-dir> [output-dir]",
		);
		process.exit(1);
	}
	const absRoot = path.resolve(root);
	if (!(await exists(absRoot))) {
		console.error(`corpus-run: source not found: ${absRoot}`);
		process.exit(1);
	}

	const outBase = path.resolve(process.argv[3] ?? "./corpus-out");
	const outDir = path.join(outBase, "out");
	const regressDir = path.join(outBase, "regress");
	await fs.mkdir(outDir, { recursive: true });
	await fs.mkdir(regressDir, { recursive: true });

	console.log(`source: ${absRoot}`);
	console.log(`output: ${outBase}`);

	// --- discover ---------------------------------------------------------
	const files: string[] = [];
	const g = new Bun.Glob(SOURCE_GLOB);
	for await (const f of g.scan({ cwd: absRoot, onlyFiles: true })) {
		files.push(f);
	}
	console.log(`found ${files.length} source files matching ${SOURCE_GLOB}`);
	if (files.length === 0) process.exit(0);

	// --- pass 1: import ---------------------------------------------------
	console.log("\n[1/3] import pass");
	const importErrors: ImportError[] = [];
	const skipped: SkipRow[] = [];
	const importedNames: string[] = [];
	// Stash each file's importer-IR items so the diff pass can compare
	// them to the regress walker's view without re-parsing the
	// arktype-scope source (which the typescript walker can't read).
	const importedItems = new Map<string, RustItem[]>();
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
			const ir = await importFile(abs, { lang });
			for (const s of ir.skipped) {
				skipped.push({
					file: rel,
					name: s.name,
					reason: s.reason,
					bucket: bucketReason(s.reason),
				});
			}
			const code = await fileToArktypeScope(abs, { lang });
			const safeName = rel.replace(/[/\\]/g, "__");
			await fs.writeFile(
				path.join(outDir, `${safeName}.ts`),
				code,
				"utf8",
			);
			importedNames.push(safeName);
			importedItems.set(safeName, ir.items);
		} catch (e) {
			importErrors.push({
				file: rel,
				reason: oneLine((e as Error).message),
			});
		}
	}
	const t1 = Date.now();

	// --- pass 2: emit (out/*.ts → regress/*.ts) ---------------------------
	console.log(
		`\n[2/3] emit pass — running analyzer + ts exporter on ${importedNames.length} scopes`,
	);
	const emitErrors: EmitError[] = [];
	const emittedNames: string[] = [];
	const jiti = createJiti(import.meta.url);
	const exporter = tsExporter({ versionNamespace: false });
	for (let i = 0; i < importedNames.length; i++) {
		const safeName = importedNames[i]!;
		if (i % PROGRESS_EVERY === 0) {
			console.log(
				`  [${i}/${importedNames.length}] elapsed ${((Date.now() - t1) / 1000).toFixed(0)}s`,
			);
		}
		const inAbs = path.join(outDir, `${safeName}.ts`);
		const outAbs = path.join(regressDir, `${safeName}.ts`);
		try {
			const mod = (await jiti.import(inAbs)) as Record<string, unknown>;
			const scope =
				(mod["$"] && isArktypeScope(mod["$"]) ? mod["$"] : null) ??
				(mod["default"] && isArktypeScope(mod["default"])
					? mod["default"]
					: null) ??
				Object.values(mod).find((v) => isArktypeScope(v));
			if (!scope) {
				emitErrors.push({ file: safeName, reason: "no arktype scope export" });
				continue;
			}
			const analyzer = new SchemaAnalyzer(scope as never, {
				wordSize: 64,
				autoLayout: true,
				layoutType: "aligned",
				mode: "rich",
			});
			const plan = analyzer.analyze("v1", "le");
			let content = exporter.generate(plan);
			if (typeof content !== "string") {
				emitErrors.push({
					file: safeName,
					reason: "exporter returned multi-file output",
				});
				continue;
			}
			if (exporter.wrapVersion)
				content = exporter.wrapVersion(safeName, content);
			if (exporter.getFileHeader) content = exporter.getFileHeader() + content;
			if (exporter.getFileFooter) content += exporter.getFileFooter();
			await fs.writeFile(outAbs, content, "utf8");
			emittedNames.push(safeName);
		} catch (e) {
			emitErrors.push({ file: safeName, reason: oneLine((e as Error).message) });
		}
	}
	const t2 = Date.now();

	// --- pass 3: structural diff (out/ vs regress/) -----------------------
	console.log(
		`\n[3/3] diff pass — comparing IR shape on ${emittedNames.length} pairs`,
	);
	const diffs: DiffRow[] = [];
	for (let i = 0; i < emittedNames.length; i++) {
		const safeName = emittedNames[i]!;
		if (i % PROGRESS_EVERY === 0) {
			console.log(
				`  [${i}/${emittedNames.length}] elapsed ${((Date.now() - t2) / 1000).toFixed(0)}s`,
			);
		}
		try {
			const inItems = importedItems.get(safeName) ?? [];
			const outIr = await tsImportFile(
				path.join(regressDir, `${safeName}.ts`),
				{ lang: "typescript" },
			);
			diffs.push(diffIRs(safeName, inItems, outIr.items));
		} catch (e) {
			// Walker failed — count as a diff with everything lost.
			diffs.push({
				file: safeName,
				typesIn: -1,
				typesOut: -1,
				typesLost: -1,
				fieldsIn: -1,
				fieldsOut: -1,
				fieldsLost: -1,
				lostNames: [`<walker error: ${oneLine((e as Error).message)}>`],
			});
		}
	}

	// --- aggregate --------------------------------------------------------
	const skipBuckets = new Map<string, number>();
	for (const s of skipped) {
		skipBuckets.set(s.bucket, (skipBuckets.get(s.bucket) ?? 0) + 1);
	}
	const importBuckets = new Map<string, number>();
	for (const e of importErrors) {
		const b = bucketReason(e.reason);
		importBuckets.set(b, (importBuckets.get(b) ?? 0) + 1);
	}
	const emitBuckets = new Map<string, number>();
	for (const e of emitErrors) {
		const b = bucketReason(e.reason);
		emitBuckets.set(b, (emitBuckets.get(b) ?? 0) + 1);
	}
	const lostNamesAcrossCorpus = new Map<string, number>();
	for (const d of diffs) {
		for (const n of d.lostNames) {
			lostNamesAcrossCorpus.set(n, (lostNamesAcrossCorpus.get(n) ?? 0) + 1);
		}
	}

	const totalIn = diffs.reduce((s, d) => s + Math.max(0, d.typesIn), 0);
	const totalOut = diffs.reduce((s, d) => s + Math.max(0, d.typesOut), 0);
	const totalLost = diffs.reduce((s, d) => s + Math.max(0, d.typesLost), 0);
	const fieldsTotalIn = diffs.reduce((s, d) => s + Math.max(0, d.fieldsIn), 0);
	const fieldsTotalOut = diffs.reduce((s, d) => s + Math.max(0, d.fieldsOut), 0);
	const fieldsTotalLost = diffs.reduce(
		(s, d) => s + Math.max(0, d.fieldsLost),
		0,
	);

	const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
	const report = {
		source: absRoot,
		ranAt: new Date().toISOString(),
		summary: {
			scanned: files.length,
			imported: importedNames.length,
			importErrored: importErrors.length,
			skippedItems: skipped.length,
			emitted: emittedNames.length,
			emitErrored: emitErrors.length,
			diffPairs: diffs.length,
			totalTypesImporter: totalIn,
			totalTypesExporter: totalOut,
			totalTypesLost: totalLost,
			totalFieldsImporter: fieldsTotalIn,
			totalFieldsExporter: fieldsTotalOut,
			totalFieldsLost: fieldsTotalLost,
			typeRetentionPct:
				totalIn === 0 ? 100 : ((totalOut / totalIn) * 100).toFixed(2),
			fieldRetentionPct:
				fieldsTotalIn === 0
					? 100
					: ((fieldsTotalOut / fieldsTotalIn) * 100).toFixed(2),
			elapsedSec: Number(elapsedSec),
		},
		topSkipBuckets: sortedTop(skipBuckets, 30),
		topImportErrorBuckets: sortedTop(importBuckets, 30),
		topEmitErrorBuckets: sortedTop(emitBuckets, 30),
		topLostNames: sortedTop(lostNamesAcrossCorpus, 30),
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
		path.join(outBase, "emit-errors.csv"),
		toCsv(["file", "reason"], emitErrors.map((e) => [e.file, e.reason])),
		"utf8",
	);
	await fs.writeFile(
		path.join(outBase, "diff.csv"),
		toCsv(
			[
				"file",
				"typesIn",
				"typesOut",
				"typesLost",
				"fieldsIn",
				"fieldsOut",
				"fieldsLost",
				"lostNames",
			],
			diffs.map((d) => [
				d.file,
				String(d.typesIn),
				String(d.typesOut),
				String(d.typesLost),
				String(d.fieldsIn),
				String(d.fieldsOut),
				String(d.fieldsLost),
				d.lostNames.join("|"),
			]),
		),
		"utf8",
	);

	// --- console summary --------------------------------------------------
	const bar = "=".repeat(60);
	console.log(`\n${bar}\nCORPUS RUN COMPLETE\n${bar}`);
	console.log(`scanned                ${files.length}`);
	console.log(`imported               ${importedNames.length}`);
	console.log(`emitted (regress)      ${emittedNames.length}`);
	console.log(
		`type retention         ${report.summary.typeRetentionPct}% (${totalOut}/${totalIn})`,
	);
	console.log(
		`field retention        ${report.summary.fieldRetentionPct}% (${fieldsTotalOut}/${fieldsTotalIn})`,
	);
	console.log(`import errors          ${importErrors.length}`);
	console.log(`emit errors            ${emitErrors.length}`);
	console.log(`elapsed                ${elapsedSec}s`);
	if (skipBuckets.size > 0) {
		console.log(`\ntop 10 skip buckets:`);
		for (const [b, n] of sortedTop(skipBuckets, 10)) {
			console.log(`  ${String(n).padStart(6)}  ${b}`);
		}
	}
	if (emitBuckets.size > 0) {
		console.log(`\ntop 10 emit-error buckets:`);
		for (const [b, n] of sortedTop(emitBuckets, 10)) {
			console.log(`  ${String(n).padStart(6)}  ${b}`);
		}
	}
	if (lostNamesAcrossCorpus.size > 0) {
		console.log(`\ntop 10 lost type names (importer had → exporter dropped):`);
		for (const [n, count] of sortedTop(lostNamesAcrossCorpus, 10)) {
			console.log(`  ${String(count).padStart(6)}  ${n}`);
		}
	}
	console.log(`\nfull report:           ${path.relative(process.cwd(), path.join(outBase, "report.json"))}`);
	console.log(`diff.csv:              ${path.relative(process.cwd(), path.join(outBase, "diff.csv"))}`);
}

/**
 * Compute structural diff between two IR snapshots — what types /
 * fields the importer surfaced vs what survived through the analyzer
 * and emit pipeline. Counts lost fields by total field-shape (not
 * field-name match), since renamed fields would skew the picture.
 */
/**
 * Compare two IR snapshots, scoped to data types only — `function`
 * items in the importer IR end up as a separate `plan.functions[]`
 * channel rather than `plan.types[]`, so counting them on the "in"
 * side would inflate the loss number with function declarations the
 * ts exporter never aimed to render.
 */
function diffIRs(file: string, inItems: RustItem[], outItems: RustItem[]): DiffRow {
	const isType = (it: RustItem): boolean => it.kind !== "function";
	const inTypes = inItems.filter(isType);
	const outTypes = outItems.filter(isType);

	const inNames = new Set(inTypes.map((it) => it.name));
	const outNames = new Set(outTypes.map((it) => it.name));
	const lostNames = [...inNames].filter((n) => !outNames.has(n));

	const fieldsCount = (items: RustItem[]): number => {
		let n = 0;
		for (const it of items) {
			if (it.kind === "struct") n += it.fields.length;
			else if (it.kind === "enum") n += it.variants.length;
		}
		return n;
	};

	const fieldsIn = fieldsCount(inTypes);
	const fieldsOut = fieldsCount(outTypes);

	return {
		file,
		typesIn: inNames.size,
		typesOut: outNames.size,
		typesLost: lostNames.length,
		fieldsIn,
		fieldsOut,
		fieldsLost: Math.max(0, fieldsIn - fieldsOut),
		lostNames,
	};
}

function bucketReason(reason: string): string {
	const stripped = reason.replace(/"[^"]*"/g, '"…"').replace(/`[^`]*`/g, "`…`");
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
