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
			exactLength: 64,
		});
	});

	test("pointer to known ref → ref with indirection: pointer", () => {
		// Indirection marker is what lets `computeLayoutPlan` size pointer
		// fields without resolving the pointee — load-bearing for
		// self-referential structs (`struct node *next`).
		expect(resolveQualType("Foo *")).toEqual({
			kind: "ref",
			name: "Foo",
			indirection: "pointer",
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
				expect(payload.type.exactLength).toBe(64);
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
		expect(deviceId.description).toContain("Globally-unique device id");

		const header = ir.items.find((i) => i.name === "Header")!;
		expect(header.description).toContain("Wire-format header");
		if (header.kind === "struct") {
			const version = header.fields.find((f) => f.name === "version")!;
			expect(version.description).toContain("protocol revision");
			const length = header.fields.find((f) => f.name === "length")!;
			expect(length.description).toContain("total payload length");
		}

		const status = ir.items.find((i) => i.name === "Status")!;
		expect(status.description).toContain("Boot-time status");

		const dispatch = ir.items.find((i) => i.name === "dispatch")!;
		expect(dispatch.description).toContain("Dispatch a packet");
		expect(dispatch.description).toContain("@param pkt");
		expect(dispatch.description).toContain("@return");
	});

	test("edge cases — fn pointers, multidim, forward decls, defines", async () => {
		const ir = await importFile(path.join(FIXTURES, "edges.h"));
		const names = ir.items.map((i) => `${i.kind}:${i.name}`).sort();
		// Grid (all multidim) is skipped (empty struct); Flags now emits
		// because bitfields are first-class. Forward (forward + complete)
		// appears once. Buffer takes its size from a #define expanded by
		// clang.
		expect(names).toEqual([
			"struct:Buffer",
			"struct:Callbacks",
			"struct:Flags",
			"struct:Forward",
			"struct:Named",
			"struct:Node",
		]);

		const buffer = ir.items.find((i) => i.name === "Buffer")!;
		if (buffer.kind === "struct") {
			const bytes = buffer.fields[0]!;
			expect(bytes.type.kind).toBe("array");
			if (bytes.type.kind === "array") expect(bytes.type.exactLength).toBe(32);
		}

		// Self-referential pointer field — survives import as a ref tagged
		// `pointer`, which is what makes computeLayoutPlan handle the
		// circular type without a topo-sort error.
		const node = ir.items.find((i) => i.name === "Node")!;
		if (node.kind === "struct") {
			const next = node.fields.find((f) => f.name === "next")!;
			expect(next.type).toEqual({
				kind: "ref",
				name: "Node",
				indirection: "pointer",
			});
		}

		// Skipped list still captures fn pointers + multidim arrays.
		const skipped = ir.skipped.map((s) => s.name).sort();
		expect(skipped).toContain("Callbacks.on_start");
		expect(skipped).toContain("Grid.cells");
	});

	test("unresolved refs downgrade to `unknown` — keep field, preserve original name", async () => {
		const ir = await importFile(path.join(FIXTURES, "buffer.h"), {
			lang: "c++",
		});
		const struct = ir.items.find((i) => i.name === "Buffer")!;
		expect(struct.kind).toBe("struct");
		if (struct.kind !== "struct") return;
		const bufLen = struct.fields.find((f) => f.name === "bufLen")!;
		// `size_t` is filtered out as a system typedef → ref → downgraded.
		expect(bufLen.type.kind).toBe("unknown");
		if (bufLen.type.kind === "unknown") expect(bufLen.type.raw).toBe("size_t");

		// `domainLinkPos: std::vector<size_t>` becomes array(unknown).
		const linkPos = struct.fields.find((f) => f.name === "domainLinkPos")!;
		expect(linkPos.type.kind).toBe("array");
		if (linkPos.type.kind === "array") {
			expect(linkPos.type.item.kind).toBe("unknown");
		}

		// Refs to types we DID emit stay as plain refs.
		const result = struct.fields.find((f) => f.name === "bufResult")!;
		expect(result.type).toEqual({ kind: "ref", name: "BufferResult" });
	});

	test("STL templates — string/vector/array/optional translated, others skipped", async () => {
		const ir = await importFile(path.join(FIXTURES, "stl.hpp"));
		const struct = ir.items.find((i) => i.name === "WithSTL")!;
		expect(struct.kind).toBe("struct");
		if (struct.kind !== "struct") return;
		const fieldsByName = Object.fromEntries(
			struct.fields.map((f) => [f.name, f.type] as const),
		);
		expect(fieldsByName.name).toEqual({ kind: "string" });
		expect(fieldsByName.bytes).toEqual({
			kind: "array",
			item: { kind: "primitive", name: "u8" },
		});
		expect(fieldsByName.packets).toEqual({
			kind: "array",
			item: { kind: "primitive", name: "u32" },
			exactLength: 16,
		});
		expect(fieldsByName.maybe_count).toEqual({
			kind: "optional",
			inner: { kind: "primitive", name: "u32" },
		});

		// Nested templates and unknown ones (std::pair) → skipped, not
		// emitted as broken refs.
		const skippedNames = ir.skipped.map((s) => s.name);
		expect(skippedNames).toContain("WithSTL.chunks");
		expect(skippedNames).toContain("WithSTL.point");
	});

	test("packed / aligned attributes captured as repr", async () => {
		const ir = await importFile(path.join(FIXTURES, "packed.h"));
		const get = (n: string) =>
			ir.items.find((i) => i.name === n && i.kind === "struct")!;

		expect(get("Plain").kind).toBe("struct");
		// Plain — no attributes, no repr.
		if (get("Plain").kind === "struct") {
			expect((get("Plain") as { repr?: string[] }).repr).toBeUndefined();
		}

		// Frame — packed.
		if (get("Frame").kind === "struct") {
			expect((get("Frame") as { repr?: string[] }).repr).toEqual(["packed"]);
		}

		// PageHeader — aligned(4096).
		if (get("PageHeader").kind === "struct") {
			expect((get("PageHeader") as { repr?: string[] }).repr).toEqual([
				"aligned(4096)",
			]);
		}

		// WireMsg — both packed and aligned.
		if (get("WireMsg").kind === "struct") {
			const repr = (get("WireMsg") as { repr?: string[] }).repr ?? [];
			expect(repr).toContain("packed");
			expect(repr.some((r) => r.startsWith("aligned"))).toBe(true);
		}
	});

	test("bitfields emit as `bit` IRType — uN for N≤7, Bit<u32,N> wider", async () => {
		const ir = await importFile(path.join(FIXTURES, "bits.h"));
		const status = ir.items.find((i) => i.name === "StatusFlags")!;
		expect(status.kind).toBe("struct");
		if (status.kind === "struct") {
			const enabled = status.fields.find((f) => f.name === "enabled")!;
			expect(enabled.type.kind).toBe("bit");
			if (enabled.type.kind === "bit") {
				expect(enabled.type.widthBits).toBe(1);
				expect(enabled.type.underlying).toBe("u8");
			}
		}

		const ctrl = ir.items.find((i) => i.name === "ControlRegister")!;
		if (ctrl.kind === "struct") {
			const reserved = ctrl.fields.find((f) => f.name === "reserved")!;
			if (reserved.type.kind === "bit") {
				expect(reserved.type.widthBits).toBe(16);
				expect(reserved.type.underlying).toBe("u32");
			}
		}

		// Mix of bitfields + regular fields preserves both shapes.
		const pkt = ir.items.find((i) => i.name === "PacketHeader")!;
		if (pkt.kind === "struct") {
			const version = pkt.fields.find((f) => f.name === "version")!;
			expect(version.type.kind).toBe("bit");
			const length = pkt.fields.find((f) => f.name === "length")!;
			expect(length.type).toEqual({ kind: "primitive", name: "u16" });
		}
	});
});
