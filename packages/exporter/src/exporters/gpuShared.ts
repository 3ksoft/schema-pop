import type { GpuBindingPlan, TypePlan } from "@schema-pop/schema";

/** True if a type plan is a GPU binding layout (produced by `Binding<...>` fields). */
export function isGpuBindingPlan(t: any): t is GpuBindingPlan {
	return t.kind === "gpu-binding-layout";
}

/**
 * Recursively detects whether a struct / alias contains any `atomic`-qualified
 * field — directly, through a reference, or through (possibly nested) array
 * elements. WGSL and TS-binding exporters use this to decide whether a type
 * stays a native WGSL struct: types with atomics can't be flattened to
 * `array<u32>` because the atomic qualifier is shader-observable.
 */
export function hasAtomics(
	t: TypePlan,
	typesMap: Map<string, TypePlan>,
	visited: Set<string> = new Set(),
): boolean {
	if (visited.has(t.name)) return false;
	visited.add(t.name);

	if (t.kind === "struct") {
		return t.fields.some((f) => {
			if ((f.type as any).atomic) return true;
			if (f.type.kind === "reference") {
				const ref = typesMap.get(f.type.name);
				return ref ? hasAtomics(ref, typesMap, visited) : false;
			}
			if (f.type.kind === "array") {
				let item = f.type.item;
				while (item.kind === "array") item = item.item;
				if (item.kind === "reference") {
					const ref = typesMap.get(item.name);
					return ref ? hasAtomics(ref, typesMap, visited) : false;
				}
				return !!(item as any).atomic;
			}
			return false;
		});
	}
	if (t.kind === "alias") {
		if ((t.type as any).atomic) return true;
		if (t.type.kind === "reference") {
			const ref = typesMap.get(t.type.name);
			return ref ? hasAtomics(ref, typesMap, visited) : false;
		}
		if (t.type.kind === "array") {
			let item = t.type.item;
			while (item.kind === "array") item = item.item;
			if (item.kind === "reference") {
				const ref = typesMap.get(item.name);
				return ref ? hasAtomics(ref, typesMap, visited) : false;
			}
			return !!(item as any).atomic;
		}
	}
	return false;
}
