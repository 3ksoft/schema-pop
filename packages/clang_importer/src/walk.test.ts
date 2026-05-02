import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { importFile } from "./index";
import { resolveQualType } from "./walk";

const FIXTURES = path.resolve(import.meta.dir, "../fixtures");

describe("resolveQualType", () => {
	test("stdint typedefs map to fixed-width primitives", () => {
		expect(resolveQualType("uint8_t")).toEqual({
			kind: "primitive",
			name: "u8",
		});
		expect(resolveQualType("uint32_t")).toEqual({
			kind: "primitive",
			name: "u32",
		});
		expect(resolveQualType("int64_t")).toEqual({
			kind: "primitive",
			name: "i64",
		});
	});

	test("LP64 fallthrough for ambiguous int/long", () => {
		expect(resolveQualType("int")).toEqual({
			kind: "primitive",
			name: "i32",
		});
		expect(resolveQualType("unsigned long")).toEqual({
			kind: "primitive",
			name: "u64",
		});
	});

	test("const + volatile qualifiers are stripped", () => {
		expect(resolveQualType("const uint16_t")).toEqual({
			kind: "primitive",
			name: "u16",
		});
		expect(resolveQualType("volatile int")).toEqual({
			kind: "primitive",
			name: "i32",
		});
	});

	test("struct/enum tag prefixes resolve to refs", () => {
		expect(resolveQualType("struct Foo")).toEqual({
			kind: "ref",
			name: "Foo",
		});
		expect(resolveQualType("enum Status")).toEqual({
			kind: "ref",
			name: "Status",
		});
	});

	test("array notation parses size", () => {
		expect(resolveQualType("uint8_t[64]")).toEqual({
			kind: "array",
			item: { kind: "primitive", name: "u8" },
			len: 64,
		});
	});

	test("pointer to known ref → ref", () => {
		expect(resolveQualType("Foo *")).toEqual({
			kind: "ref",
			name: "Foo",
		});
	});

	test("non-LP64 mode keeps int/long ambiguous", () => {
		expect(resolveQualType("int", { lp64: false })).toEqual({
			kind: "ref",
			name: "int",
		});
	});
});

describe("importFile", () => {
	test("simple C header — struct/enum/alias/function", async () => {
		const ir = await importFile(path.join(FIXTURES, "simple.h"));
		const names = ir.items.map((i) => `${i.kind}:${i.name}`).sort();
		expect(names).toEqual([
			"alias:DeviceId",
			"enum:Status",
			"function:do_thing",
			"struct:Foo",
		]);

		const foo = ir.items.find((i) => i.name === "Foo")!;
		expect(foo.kind).toBe("struct");
		if (foo.kind === "struct") {
			expect(foo.fields.map((f) => f.name)).toEqual(["a", "b", "flags"]);
			expect(foo.fields[0]!.type).toEqual({
				kind: "primitive",
				name: "u32",
			});
		}

		const fn = ir.items.find((i) => i.name === "do_thing")!;
		expect(fn.kind).toBe("function");
		if (fn.kind === "function") {
			expect(fn.args).toHaveLength(2);
			expect(fn.args[0]!.name).toBe("foo");
			expect(fn.returnType).toEqual({
				kind: "primitive",
				name: "i32",
			});
		}
	});

	test("complex C++ header — namespace, enum class, using, extern \"C\"", async () => {
		const ir = await importFile(path.join(FIXTURES, "complex.hpp"));
		const names = ir.items.map((i) => `${i.kind}:${i.name}`).sort();
		expect(names).toEqual([
			"alias:DeviceId",
			"enum:Status",
			"function:dispatch",
			"function:shutdown",
			"struct:Header",
			"struct:Packet",
		]);

		const status = ir.items.find((i) => i.name === "Status")!;
		expect(status.kind).toBe("enum");
		if (status.kind === "enum") {
			expect(status.repr).toEqual(["u8"]);
			expect(status.variants.map((v) => v.name)).toEqual([
				"OK",
				"ERR",
				"PENDING",
			]);
		}

		const packet = ir.items.find((i) => i.name === "Packet")!;
		if (packet.kind === "struct") {
			const payload = packet.fields.find((f) => f.name === "payload")!;
			expect(payload.type.kind).toBe("array");
			if (payload.type.kind === "array") {
				expect(payload.type.len).toBe(64);
			}
		}

		const shutdown = ir.items.find((i) => i.name === "shutdown")!;
		if (shutdown.kind === "function") {
			expect(shutdown.args).toHaveLength(0);
			expect(shutdown.returnType.kind).toBe("unsupported");
			if (shutdown.returnType.kind === "unsupported") {
				expect(shutdown.returnType.raw).toBe("void");
			}
		}
	});

	test("system headers are filtered out — only user types appear", async () => {
		const ir = await importFile(path.join(FIXTURES, "simple.h"));
		// stdint typedefs (`int8_t`, `uint32_t`, etc.) should NOT leak through.
		const sys = ir.items.find((i) =>
			["int8_t", "uint32_t", "__off_t"].includes(i.name),
		);
		expect(sys).toBeUndefined();
	});

	test("calling convention attributes captured as abi", async () => {
		const ir = await importFile(path.join(FIXTURES, "abi.h"));
		const byName = Object.fromEntries(
			ir.items.map((i) => [i.name, i] as const),
		);
		const expectAbi = (n: string, abi: string | undefined) => {
			const it = byName[n];
			expect(it?.kind).toBe("function");
			if (it?.kind === "function") expect(it.abi).toBe(abi);
		};
		expectAbi("plain_func", undefined);
		expectAbi("api_call", "stdcall");
		expectAbi("fast_call", "fastcall");
		expectAbi("ms_abi_func", "ms_abi");
		expectAbi("sysv_abi_func", "sysv_abi");
	});

	test("doc-comments propagate to alias / struct / fields / enum / function", async () => {
		const ir = await importFile(path.join(FIXTURES, "docs.h"));

		const deviceId = ir.items.find((i) => i.name === "DeviceId")!;
		expect(deviceId.doc).toContain("Globally-unique device id");

		const header = ir.items.find((i) => i.name === "Header")!;
		expect(header.doc).toContain("Wire-format header");
		if (header.kind === "struct") {
			const version = header.fields.find((f) => f.name === "version")!;
			expect(version.doc).toContain("protocol revision");
			const length = header.fields.find((f) => f.name === "length")!;
			expect(length.doc).toContain("total payload length");
		}

		const status = ir.items.find((i) => i.name === "Status")!;
		expect(status.doc).toContain("Boot-time status");

		const dispatch = ir.items.find((i) => i.name === "dispatch")!;
		expect(dispatch.doc).toContain("Dispatch a packet");
		expect(dispatch.doc).toContain("@param pkt");
		expect(dispatch.doc).toContain("@return");
	});

	test("edge cases — bitfields, fn pointers, multidim, forward decls, defines", async () => {
		const ir = await importFile(path.join(FIXTURES, "edges.h"));
		const names = ir.items.map((i) => `${i.kind}:${i.name}`).sort();
		// Flags (all bitfields) and Grid (multidim) are skipped — empty
		// structs are not emitted. Forward (forward + complete) appears
		// once. Buffer takes its size from a #define expanded by clang.
		expect(names).toEqual([
			"struct:Buffer",
			"struct:Callbacks",
			"struct:Forward",
			"struct:Named",
		]);

		const buffer = ir.items.find((i) => i.name === "Buffer")!;
		if (buffer.kind === "struct") {
			const bytes = buffer.fields[0]!;
			expect(bytes.type.kind).toBe("array");
			if (bytes.type.kind === "array") expect(bytes.type.len).toBe(32);
		}

		// Skipped list captures bitfields, fn pointers, multidim arrays.
		const skipped = ir.skipped.map((s) => s.name).sort();
		expect(skipped).toContain("Flags.a");
		expect(skipped).toContain("Callbacks.on_start");
		expect(skipped).toContain("Grid.cells");
	});
});
