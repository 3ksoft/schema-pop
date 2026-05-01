import type { LayoutPlan, TypePlan, Field } from "../schema/layout";

export class PopCodec {
	private textEncoder = new TextEncoder();
	private textDecoder = new TextDecoder();
	private le: boolean;
	private typesMap = new Map<string, TypePlan>();

	constructor(plan: LayoutPlan) {
		this.le = plan.endian === "le";
		for (const t of plan.types) {
			this.typesMap.set(t.name, t);
		}
	}

	public encode(typeName: string, data: any): Uint8Array {
		const typePlan = this.findType(typeName);
		const buffer = new ArrayBuffer(typePlan.size);
		const view = new DataView(buffer);
		try {
			this.writeType(view, 0, typePlan, data);
		} catch (e: any) {
			throw new Error(`Failed to encode ${typeName}: ${e.message}`);
		}
		return new Uint8Array(buffer);
	}

	public decode(typeName: string, buffer: Uint8Array): any {
		const typePlan = this.findType(typeName);
		if (buffer.length < typePlan.size) {
			throw new Error(
				`Buffer too small for ${typeName}. Expected at least ${typePlan.size} bytes, got ${buffer.length}`,
			);
		}
		const view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
		return this.readType(view, 0, typePlan);
	}

	private findType(name: string): TypePlan {
		const typePlan = this.typesMap.get(name);
		if (!typePlan) throw new Error(`Type ${name} not found in plan`);
		return typePlan;
	}

	private writeType(
		view: DataView,
		baseOffset: number,
		plan: TypePlan,
		data: any,
	) {
		if (plan.kind === "struct") {
			const safeData = data || {};
			for (const field of plan.fields) {
				this.writeField(
					view,
					baseOffset + field.offset,
					field.type,
					safeData[field.name],
				);
			}
		} else if (plan.kind === "enum") {
			const variant = plan.variants.find((v) => v.name === data);
			const val = variant ? variant.value : 0;
			if (plan.underlyingType === "u16")
				view.setUint16(baseOffset, val, this.le);
			else if (plan.underlyingType === "i32")
				view.setInt32(baseOffset, val, this.le);
			else view.setUint8(baseOffset, val);
		} else if (plan.kind === "union") {
			const variantName =
				typeof data === "string" ? data : data.kind || data.type;
			const variantIndex = plan.variants.findIndex(
				(v) => v.name === variantName,
			);
			if (variantIndex === -1)
				throw new Error(`Unknown union variant: ${variantName}`);
			const variant = plan.variants[variantIndex];

			view.setUint8(baseOffset + plan.tagOffset, variantIndex + 1);
			if (variant && variant.type.kind !== "unit") {
				// Payload offset respects alignment of the union payload
				const payloadOffset = baseOffset + plan.align;
				this.writeField(
					view,
					payloadOffset,
					variant!.type,
					typeof data === "string" ? data : data.value || data,
				);
			}
		} else if (plan.kind === "alias") {
			this.writeField(view, baseOffset, plan.type, data);
		}
	}

	private readType(view: DataView, baseOffset: number, plan: TypePlan): any {
		if (plan.kind === "struct") {
			const out: any = {};
			for (const field of plan.fields) {
				(out as any)[field.name] = this.readField(
					view,
					baseOffset + field.offset,
					field.type,
				);
			}
			return out;
		} else if (plan.kind === "enum") {
			let index = 0;
			if (plan.underlyingType === "u16")
				index = view.getUint16(baseOffset, this.le);
			else if (plan.underlyingType === "i32")
				index = view.getInt32(baseOffset, this.le);
			else index = view.getUint8(baseOffset);
			const variant = plan.variants.find((v) => v.value === index);
			return variant ? variant.name : "Unknown";
		} else if (plan.kind === "union") {
			const tag = view.getUint8(baseOffset + plan.tagOffset);
			if (tag === 0) return "Unknown";
			const variant = plan.variants[tag - 1];
			if (!variant) return `UnknownTag(${tag})`;
			if (variant.type.kind === "unit") return variant.name;
			const payload = this.readField(
				view,
				baseOffset + plan.align,
				variant.type,
			);
			return typeof payload === "object"
				? { kind: variant.name, ...payload }
				: { kind: variant.name, value: payload };
		} else if (plan.kind === "alias") {
			return this.readField(view, baseOffset, plan.type);
		}
	}

	private writeField(view: DataView, offset: number, type: Field, data: any) {
		switch (type.kind) {
			case "primitive":
				this.writePrimitive(view, offset, type.name, data);
				break;
			case "reference":
				this.writeType(view, offset, this.findType(type.name), data);
				break;
			case "optional": {
				if (data === undefined || data === null) {
					view.setUint8(offset, 0);
				} else {
					view.setUint8(offset, 1);
					const innerAlign = this.getLayout(type.inner).align;
					const payloadOffset =
						offset + 1 + ((innerAlign - (1 % innerAlign)) % innerAlign);
					this.writeField(view, payloadOffset, type.inner, data);
				}
				break;
			}
			case "string": {
				const bytes = this.textEncoder.encode(String(data || ""));
				const max = type.maxLength || 0;
				const len = Math.min(bytes.length, max);
				view.setUint32(offset, len, this.le);
				if (max > 0) {
					new Uint8Array(view.buffer, view.byteOffset + offset + 4, max)
						.fill(0)
						.set(bytes.slice(0, len));
				}
				break;
			}
			case "array": {
				const items = Array.isArray(data) ? data : [];
				const isFixed = type.exactLength !== undefined;
				const max = isFixed ? type.exactLength! : type.maxLength || 0;
				const len = Math.min(items.length, max);

				if (!isFixed) {
					view.setUint32(offset, len, this.le);
				}

				let currentIdxOffset = isFixed ? offset : offset + 4;
				const itemLayout = this.getLayout(type.item);
				const elementAlign = itemLayout.align;
				const alignedElemSize = itemLayout.paddedSize;

				for (let i = 0; i < len; i++) {
					const pad =
						(elementAlign - (currentIdxOffset % elementAlign)) % elementAlign;
					currentIdxOffset += pad;
					this.writeField(view, currentIdxOffset, type.item, items[i]);
					currentIdxOffset = currentIdxOffset - pad + alignedElemSize;
				}
				break;
			}
			case "inlineStruct": {
				for (const field of type.fields) {
					this.writeField(
						view,
						offset + field.offset,
						field.type,
						(data as any)[field.name],
					);
				}
				break;
			}
		}
	}

	private readField(view: DataView, offset: number, type: Field): any {
		switch (type.kind) {
			case "primitive":
				return this.readPrimitive(view, offset, type.name);
			case "reference":
				return this.readType(view, offset, this.findType(type.name));
			case "optional": {
				const hasValue = view.getUint8(offset) === 1;
				if (!hasValue) return undefined;
				const innerAlign = this.getLayout(type.inner).align;
				const payloadOffset =
					offset + 1 + ((innerAlign - (1 % innerAlign)) % innerAlign);
				return this.readField(view, payloadOffset, type.inner);
			}
			case "string": {
				const declaredLen = view.getUint32(offset, this.le);
				const max = type.maxLength || 0;
				const actualLen = max > 0 ? Math.min(declaredLen, max) : declaredLen;
				const safeLen = Math.min(actualLen, view.byteLength - (offset + 4));
				if (safeLen <= 0) return "";
				const bytes = new Uint8Array(
					view.buffer,
					view.byteOffset + offset + 4,
					safeLen,
				);
				return this.textDecoder.decode(bytes);
			}
			case "array": {
				const isFixed = type.exactLength !== undefined;
				const len = isFixed
					? type.exactLength!
					: view.getUint32(offset, this.le);
				const actualLen = Math.min(
					len,
					isFixed ? type.exactLength! : type.maxLength || 0,
				);
				const items = [];

				let currentIdxOffset = isFixed ? offset : offset + 4;
				const itemLayout = this.getLayout(type.item);
				const elementAlign = itemLayout.align;
				const alignedElemSize = itemLayout.paddedSize;

				for (let i = 0; i < actualLen; i++) {
					const pad =
						(elementAlign - (currentIdxOffset % elementAlign)) % elementAlign;
					currentIdxOffset += pad;
					items.push(this.readField(view, currentIdxOffset, type.item));
					currentIdxOffset = currentIdxOffset - pad + alignedElemSize;
				}
				return items;
			}
			case "inlineStruct": {
				const out: any = {};
				for (const field of type.fields) {
					out[field.name] = this.readField(
						view,
						offset + field.offset,
						field.type,
					);
				}
				return out;
			}
			case "unit":
				return undefined;
			default:
				return null;
		}
	}

	private writePrimitive(
		view: DataView,
		offset: number,
		name: string,
		val: any,
	) {
		const le = this.le;
		const numVal = Number(val ?? 0);

		if (name === "u8") view.setUint8(offset, numVal);
		else if (name === "u16") view.setUint16(offset, numVal, le);
		else if (name === "u32") view.setUint32(offset, numVal, le);
		else if (name === "u64") view.setBigUint64(offset, BigInt(val ?? 0), le);
		else if (name === "u128") {
			const b = BigInt(val ?? 0);
			view.setBigUint64(offset + (le ? 0 : 8), BigInt.asUintN(64, b), le);
			view.setBigUint64(
				offset + (le ? 8 : 0),
				BigInt.asUintN(64, b >> 64n),
				le,
			);
		} else if (name === "i8") view.setInt8(offset, numVal);
		else if (name === "i16") view.setInt16(offset, numVal, le);
		else if (name === "i32") view.setInt32(offset, numVal, le);
		else if (name === "i64") view.setBigInt64(offset, BigInt(val ?? 0), le);
		else if (name === "i128") {
			const b = BigInt(val ?? 0);
			view.setBigUint64(offset + (le ? 0 : 8), BigInt.asUintN(64, b), le);
			view.setBigInt64(offset + (le ? 8 : 0), BigInt.asIntN(64, b >> 64n), le);
		} else if (name === "f32") view.setFloat32(offset, numVal, le);
		else if (name === "f64") view.setFloat64(offset, numVal, le);
		else if (name === "boolean" || name === "bool")
			view.setUint8(offset, val ? 1 : 0);
	}

	private readPrimitive(view: DataView, offset: number, name: string): any {
		const le = this.le;
		if (name === "u8") return view.getUint8(offset);
		if (name === "u16") return view.getUint16(offset, le);
		if (name === "u32") return view.getUint32(offset, le);
		if (name === "u64") return view.getBigUint64(offset, le);
		if (name === "u128") {
			const low = view.getBigUint64(offset + (le ? 0 : 8), le);
			const high = view.getBigUint64(offset + (le ? 8 : 0), le);
			return (high << 64n) | low;
		}
		if (name === "i8") return view.getInt8(offset);
		if (name === "i16") return view.getInt16(offset, le);
		if (name === "i32") return view.getInt32(offset, le);
		if (name === "i64") return view.getBigInt64(offset, le);
		if (name === "i128") {
			const low = view.getBigUint64(offset + (le ? 0 : 8), le);
			const high = view.getBigInt64(offset + (le ? 8 : 0), le);
			return (high << 64n) | low;
		}
		if (name === "f32") return view.getFloat32(offset, le);
		if (name === "f64") return view.getFloat64(offset, le);
		if (name === "boolean" || name === "bool")
			return view.getUint8(offset) !== 0;
	}

	private getLayout(field: Field): {
		size: number;
		align: number;
		paddedSize: number;
	} {
		if (field.kind === "unit") return { size: 0, align: 1, paddedSize: 0 };
		if (field.kind === "primitive") {
			const aligns: Record<string, number> = {
				u8: 1,
				i8: 1,
				bool: 1,
				boolean: 1,
				u16: 2,
				i16: 2,
				u32: 4,
				i32: 4,
				f32: 4,
				f64: 8,
				u64: 8,
				i64: 8,
				u128: 8,
				i128: 8,
			};
			const sizes: Record<string, number> = {
				u8: 1,
				i8: 1,
				bool: 1,
				boolean: 1,
				u16: 2,
				i16: 2,
				u32: 4,
				i32: 4,
				f32: 4,
				f64: 8,
				u64: 8,
				i64: 8,
				u128: 16,
				i128: 16,
			};
			const align = aligns[field.name] || 4;
			const size = sizes[field.name] || 4;
			return { size, align, paddedSize: Math.ceil(size / align) * align };
		}
		if (field.kind === "reference") {
			const plan = this.findType(field.name);
			return {
				size: plan.size,
				align: plan.align,
				paddedSize: (plan as any).paddedSize ?? plan.size,
			};
		}
		if (field.kind === "optional") {
			const inner = this.getLayout(field.inner);
			const align = inner.align;
			const total = 1 + ((align - (1 % align)) % align) + inner.size;
			return {
				size: total,
				align,
				paddedSize: Math.ceil(total / align) * align,
			};
		}
		if (field.kind === "string") {
			const size = 4 + (field.maxLength || 0);
			return { size, align: 4, paddedSize: Math.ceil(size / 4) * 4 };
		}
		if (field.kind === "array") {
			const isFixed = field.exactLength !== undefined;
			const max = isFixed ? field.exactLength! : field.maxLength || 0;
			const itemLayout = this.getLayout(field.item);
			const baseSize = (isFixed ? 0 : 4) + max * itemLayout.paddedSize;
			const align = isFixed ? itemLayout.align : Math.max(4, itemLayout.align);
			return {
				size: baseSize,
				align,
				paddedSize: Math.ceil(baseSize / align) * align,
			};
		}
		if (field.kind === "inlineStruct") {
			return {
				size: field.size,
				align: field.align,
				paddedSize: (field as any).paddedSize ?? field.size,
			};
		}
		return { size: 0, align: 1, paddedSize: 0 };
	}
}
