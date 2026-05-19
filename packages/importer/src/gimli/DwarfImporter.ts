import type { PopType } from "@schema-pop/schema";
import { BaseImporter, type WalkResult } from "../toolkit.js";

export interface DwarfMetadata {
	types: Record<string, DwarfType>;
}

export interface DwarfType {
	id: string;
	tag: string;
	name?: string;
	byte_size?: number;
	encoding?: number;
	target_type?: string;
	array_count?: number;
	fields: DwarfField[];
}

export interface DwarfField {
	name?: string;
	type_id?: string;
	offset?: number;
}

// Basic DWARF Encodings mapping to schema-pop binary types
const DWARF_ENCODINGS: Record<number, Record<number, string>> = {
	0x05: { 1: "i8", 2: "i16", 4: "i32", 8: "i64" }, // DW_ATE_signed
	0x07: { 1: "u8", 2: "u16", 4: "u32", 8: "u64" }, // DW_ATE_unsigned
	0x08: { 1: "i8", 2: "i16", 4: "i32", 8: "i64" }, // DW_ATE_unsigned_char (or signed based on compiler, usually u8)
	0x06: { 1: "i8" }, // DW_ATE_signed_char
	0x02: { 1: "bool" }, // DW_ATE_boolean
	0x04: { 4: "f32", 8: "f64" }, // DW_ATE_float
};

export class DwarfImporter extends BaseImporter {
	private metadata: DwarfMetadata;
	private typeCache = new Map<string, PopType>();
	private processedSet = new Set<string>();

	constructor(sourcePath: string, metadata: DwarfMetadata) {
		super(sourcePath);
		this.metadata = metadata;
	}

	public run(): WalkResult {
		// Extract only named types (Structs, Typedefs, Enums) to populate items
		for (const [id, dwarfType] of Object.entries(this.metadata.types)) {
			if (dwarfType.name && !dwarfType.name.includes("<unnamed>")) {
				try {
					const popType = this.resolveType(id, dwarfType.name);
					this.addItem(dwarfType.name, popType, `DWARF Type ID: ${id}`);
				} catch (e) {
					this.skip(dwarfType.name, String(e));
				}
			}
		}
		return this.finalize();
	}

	private resolveType(id: string, fallbackLabel?: string): PopType {
		// Check if we are currently resolving this type to prevent infinite recursion
		if (this.processedSet.has(id)) {
			const t = this.metadata.types[id];
			const target = t?.name || `Type_${id}`;
			return this.assertType(
				{ type: "link", target, popKind: "binary" },
				target,
			) as PopType;
		}

		if (this.typeCache.has(id)) {
			return this.typeCache.get(id)!;
		}

		this.processedSet.add(id);

		const dwarfType = this.metadata.types[id];
		const label = dwarfType?.name || fallbackLabel || `Type_${id}`;

		if (!dwarfType) {
			this.processedSet.delete(id);
			return this.assertType(
				{ type: "any", originalType: `Unknown_${id}`, popKind: "binary" },
				label,
			) as PopType;
		}

		let result: any;

		switch (dwarfType.tag) {
			case "DW_TAG_base_type": {
				const size = dwarfType.byte_size ?? 0;
				const enc = dwarfType.encoding ?? 0;
				const binType = DWARF_ENCODINGS[enc]?.[size] ?? null;
				if (binType === "bool") {
					result = {
						type: "boolean",
						binaryType: "bool",
						size,
						popKind: "binary",
					};
				} else if (binType) {
					result = {
						type: "number",
						binaryType: binType,
						size,
						popKind: "binary",
					};
				} else {
					result = {
						type: "any",
						originalType: dwarfType.name || "unknown",
						size,
						popKind: "binary",
					};
				}
				break;
			}
			case "DW_TAG_structure_type":
			case "DW_TAG_union_type": {
				const fields: Record<string, PopType> = {};
				for (const field of dwarfType.fields) {
					if (!field.name || !field.type_id) continue;
					const resolvedField = this.resolveType(field.type_id, field.name);
					const fieldType = { ...resolvedField };
					// Attach offset to the resolved type for schema-pop analyzer
					if (field.offset !== undefined) {
						(fieldType as any).addr = field.offset;
					}
					fields[field.name] = fieldType as PopType;
				}
				result = {
					type: "object",
					typeString: dwarfType.name,
					size: dwarfType.byte_size,
					fields,
					popKind: "binary",
				};
				break;
			}
			case "DW_TAG_pointer_type":
			case "DW_TAG_typedef": {
				if (dwarfType.target_type) {
					result = this.resolveType(dwarfType.target_type, label);
				} else {
					result = { type: "any", originalType: "void*", popKind: "binary" };
				}
				break;
			}
			case "DW_TAG_array_type": {
				if (dwarfType.target_type) {
					const itemType = this.resolveType(
						dwarfType.target_type,
						`${label}Item`,
					);
					const len = dwarfType.array_count ?? 0;
					result = {
						type: "array",
						item: itemType,
						minLength: len,
						maxLength: len,
						popKind: "binary",
					};
				} else {
					result = {
						type: "any",
						originalType: "UnknownArray",
						popKind: "binary",
					};
				}
				break;
			}
			default:
				result = {
					type: "any",
					originalType: dwarfType.name || dwarfType.tag,
					popKind: "binary",
				};
				break;
		}

		this.processedSet.delete(id);
		const validResult = this.assertType(result, label) as PopType;
		this.typeCache.set(id, validResult);
		return validResult;
	}
}
