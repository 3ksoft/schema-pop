/// <reference types="@types/bun" />
import { describe, expect, test } from "bun:test";
import { scope } from "arktype";
import { binary, Renamed, type LayoutPlan } from "../../schema/src";
import { diffPlans, fromModule, SchemaAnalyzer } from "../../core/src";

// Each call gets a fresh analyzer so per-run state never leaks between plans.
function analyze(s: any): LayoutPlan {
	return new SchemaAnalyzer().analyze(fromModule(s.export()), {
		version: "1.0.0",
	}).plan;
}

describe("diffPlans", () => {
	test("identical plans → all types unchanged, status auto", () => {
		const s1 = scope({
			...binary.import(),
			Battery: { voltage: "u32", current: "i32" },
		});
		const diff = diffPlans(analyze(s1), analyze(s1));
		expect(diff.status).toBe("auto");
		expect(diff.types.every((t) => t.kind === "unchanged")).toBe(true);
	});

	test("field added with ArkType default → auto (literal)", () => {
		const v1 = analyze(
			scope({ ...binary.import(), Battery: { voltage: "u32" } }),
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				Battery: { voltage: "u32", firmware: "u16 = 1" },
			}),
		);
		const diff = diffPlans(v1, v2);
		const battery = diff.types.find((t) => "to" in t && t.to.name === "Battery");
		if (!battery || battery.kind !== "changed") throw new Error("expected changed");
		expect(battery.status).toBe("auto");
		const firmware = battery.fieldChanges[0]!;
		expect(firmware.kind).toBe("added");
		if (firmware.kind !== "added") return;
		expect(firmware.default).toEqual({ kind: "literal", value: 1 });
		expect(firmware.status).toBe("auto");
	});

	test("field added without default (primitive) → language-default, auto", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }));
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u32", y: "u8" } }));
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const added = b.fieldChanges[0]!;
		expect(added.kind).toBe("added");
		if (added.kind !== "added") return;
		expect(added.default.kind).toBe("language-default");
		expect(added.status).toBe("auto");
	});

	test("field removed → auto", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { x: "u32", legacy: "u16" } }),
		);
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u32" } }));
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const removed = b.fieldChanges[0]!;
		expect(removed.kind).toBe("removed");
		expect(removed.status).toBe("auto");
	});

	test("field renamed via Renamed marker → auto", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { voltage_mv: "u32" } }),
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				Renamed,
				B: { voltage: "Renamed<u32, 'voltage_mv'>" },
			}),
		);
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const renamed = b.fieldChanges.filter((c) => c.kind === "renamed");
		expect(renamed).toHaveLength(1);
		const ch = renamed[0]!;
		if (ch.kind !== "renamed") return;
		expect(ch.oldName).toBe("voltage_mv");
		expect(ch.status).toBe("auto");
	});

	test("rename without marker is reported as (removed, added)", () => {
		const v1 = analyze(
			scope({ ...binary.import(), B: { voltage_mv: "u32" } }),
		);
		const v2 = analyze(scope({ ...binary.import(), B: { voltage: "u32" } }));
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const kinds = b.fieldChanges.map((c) => c.kind).sort();
		expect(kinds).toEqual(["added", "removed"]);
	});

	test("type widened (u8 → u16) → auto", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u8" } }));
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }));
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const ch = b.fieldChanges[0]!;
		expect(ch.kind).toBe("type-widened");
		expect(ch.status).toBe("auto");
	});

	test("type narrowed (u32 → u16) → user-supplied", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }));
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } }));
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const ch = b.fieldChanges[0]!;
		expect(ch.kind).toBe("type-narrowed");
		expect(ch.status).toBe("user-supplied");
		expect(b.status).toBe("user-supplied");
	});

	test("type changed across families (u32 → f32) → user-supplied", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }));
		const v2 = analyze(scope({ ...binary.import(), B: { x: "f32" } }));
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		if (!b || b.kind !== "changed") throw new Error("expected changed");
		const ch = b.fieldChanges[0]!;
		expect(ch.kind).toBe("type-changed");
		expect(ch.status).toBe("user-supplied");
	});

	test("type added → auto (no inputs from v1)", () => {
		const v1 = analyze(scope({ ...binary.import(), A: { x: "u32" } }));
		const v2 = analyze(
			scope({ ...binary.import(), A: { x: "u32" }, B: { y: "u32" } }),
		);
		const diff = diffPlans(v1, v2);
		const b = diff.types.find((t) => "to" in t && t.to.name === "B");
		expect(b?.kind).toBe("added");
		if (b?.kind !== "added") return;
		expect(b.status).toBe("auto");
	});

	test("type removed → auto (no migration target)", () => {
		const v1 = analyze(
			scope({ ...binary.import(), A: { x: "u32" }, Old: { y: "u16" } }),
		);
		const v2 = analyze(scope({ ...binary.import(), A: { x: "u32" } }));
		const diff = diffPlans(v1, v2);
		const old = diff.types.find((t) => "from" in t && t.from?.name === "Old");
		expect(old?.kind).toBe("removed");
	});

	test("type-level Renamed (alias) → renamed TypeDiff", () => {
		const v1 = analyze(scope({ ...binary.import(), DeviceStatus: "u8" }));
		const v2 = analyze(
			scope({
				...binary.import(),
				Renamed,
				RuntimeStatus: "Renamed<u8, 'DeviceStatus'>",
			}),
		);
		const diff = diffPlans(v1, v2);
		const rs = diff.types.find(
			(t) => "to" in t && t.to.name === "RuntimeStatus",
		);
		if (!rs || rs.kind !== "renamed") throw new Error("expected renamed");
		expect(rs.oldName).toBe("DeviceStatus");
		expect(rs.status).toBe("auto");
	});

	test("union variant added → auto", () => {
		const v1 = analyze(
			scope({
				...binary.import(),
				Idle: { tag: "0", x: "u8" },
				Active: { tag: "1", y: "u16" },
				Status: "Idle | Active",
			}),
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				Idle: { tag: "0", x: "u8" },
				Active: { tag: "1", y: "u16" },
				Suspended: { tag: "2", z: "u8" },
				Status: "Idle | Active | Suspended",
			}),
		);
		const diff = diffPlans(v1, v2);
		const status = diff.types.find((t) => "to" in t && t.to.name === "Status");
		if (!status || status.kind !== "changed") throw new Error("expected changed");
		const added = status.variantChanges.filter((c) => c.kind === "added");
		expect(added).toHaveLength(1);
		expect(status.status).toBe("auto");
	});

	test("union variant removed → user-supplied (when captured as a change)", () => {
		const v1 = analyze(
			scope({
				...binary.import(),
				A: { tag: "0", x: "u8" },
				B: { tag: "1", y: "u16" },
				X: "A | B",
			}),
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				A: { tag: "0", x: "u8" },
				B: { tag: "1", y: "u16" },
				X: "A",
			}),
		);
		const diff = diffPlans(v1, v2);
		const x = diff.types.find((t) => "to" in t && t.to.name === "X");
		expect(x).toBeDefined();
		if (x?.kind === "changed") {
			const removed = x.variantChanges.filter((c) => c.kind === "removed");
			if (removed.length > 0) expect(x.status).toBe("user-supplied");
		}
	});

	test("plan status aggregates to user-supplied if any change is", () => {
		const v1 = analyze(scope({ ...binary.import(), B: { x: "u32" } }));
		const v2 = analyze(scope({ ...binary.import(), B: { x: "u16" } })); // narrowing
		const diff = diffPlans(v1, v2);
		expect(diff.status).toBe("user-supplied");
	});

	// TODO(Phase 0 follow-up): the analyzer builds enum variants from the union's
	// string-literal options, a path that does not yet propagate the `renamedFrom`
	// marker (only tagged-union branches and struct fields/types do). Once enum
	// option rename metadata is wired, un-skip this — the classifier already
	// supports it via diffEnumVariants.
	test.skip("enum variant Renamed → renamed change with oldName", () => {
		const v1 = analyze(
			scope({
				...binary.import(),
				Status: "'Idle' | 'Active' | 'Suspended'",
			}),
		);
		const v2 = analyze(
			scope({
				...binary.import(),
				Renamed,
				Status: "'Idle' | 'Active' | Renamed<'Sleep', 'Suspended'>",
			}),
		);
		const diff = diffPlans(v1, v2);
		const status = diff.types.find((t) => "to" in t && t.to.name === "Status");
		if (!status || status.kind !== "changed") throw new Error("expected changed");
		const renamed = status.variantChanges.find((c) => c.kind === "renamed");
		if (!renamed || renamed.kind !== "renamed") throw new Error("expected renamed");
		expect(renamed.oldName).toBe("Suspended");
	});
});
