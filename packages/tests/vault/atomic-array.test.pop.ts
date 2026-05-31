// Test: atomic attribute should be preserved in array items
// 
// This test demonstrates that when a type with atomic: true is used inside an array,
// the atomic attribute should be preserved on the array item, not lost during analysis.
//
// Expected behavior:
// - AtomicI32 has atomic: true
// - AtomicArray.values should have item with atomic: true
// - NestedAtomicArray.data should preserve atomic through nesting
import { schemaPop, scope, binary } from "@schema-pop/schema";
import { cpp, wgsl } from "@schema-pop/exporter";

export const $ = schemaPop(
	{
		layout: "std430",
		autoLayout: false,
		targets: [
			cpp({ dest: "./atomic-array.test.cpp" }),
			wgsl({ dest: "./atomic-array.test.wgsl" }),
		],
	},
	scope({
		// Define atomic<i32> type with atomic: true metadata
		AtomicI32: binary.type("i32").configure({
			description: "atomic<i32>",
			atomic: true,
			binaryType: "i32",
			size: 4,
			align: 4,
		}),

		// Array of atomic<i32> - this should preserve atomic on the item
		AtomicArray: {
			values: "AtomicI32[] == 4",
		},

		// Nested array - should also preserve atomic
		NestedAtomicArray: {
			data: "AtomicArray[] == 2",
		},
	}),
);
