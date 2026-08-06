import type { LayoutPlan, Field } from "@schema-pop/schema";
import type { TypeCodec } from "./common";

export interface InterpretedSuite {
    codecs: Map<string, TypeCodec>;
    get<T = any>(typeName: string): TypeCodec<T>;
}

type PrimReader = (view: DataView, off: number, isLE: boolean) => any;
type PrimWriter = (view: DataView, val: any, off: number, isLE: boolean) => void;

const createPrimReaders = (wordSize: string): Record<string, PrimReader> => {
    const readers: Record<string, PrimReader> = {
        u8: (v, o) => v.getUint8(o),
        uint8: (v, o) => v.getUint8(o),
        boolean: (v, o) => v.getUint8(o) !== 0,
        i8: (v, o) => v.getInt8(o),
        int8: (v, o) => v.getInt8(o),
        u16: (v, o, le) => v.getUint16(o, le),
        uint16: (v, o, le) => v.getUint16(o, le),
        i16: (v, o, le) => v.getInt16(o, le),
        int16: (v, o, le) => v.getInt16(o, le),
        u32: (v, o, le) => v.getUint32(o, le),
        uint32: (v, o, le) => v.getUint32(o, le),
        i32: (v, o, le) => v.getInt32(o, le),
        int32: (v, o, le) => v.getInt32(o, le),
        f32: (v, o, le) => v.getFloat32(o, le),
        float: (v, o, le) => v.getFloat32(o, le),
        f64: (v, o, le) => v.getFloat64(o, le),
        double: (v, o, le) => v.getFloat64(o, le),
        u64: (v, o, le) => Number(v.getBigUint64(o, le)),
        uint64: (v, o, le) => Number(v.getBigUint64(o, le)),
        i64: (v, o, le) => Number(v.getBigInt64(o, le)),
        int64: (v, o, le) => Number(v.getBigInt64(o, le)),
        usize: wordSize === "64"
            ? (v, o, le) => Number(v.getBigUint64(o, le))
            : (v, o, le) => v.getUint32(o, le),
    };
    return readers;
};

const createPrimWriters = (wordSize: string): Record<string, PrimWriter> => {
    const writers: Record<string, PrimWriter> = {
        u8: (v, x, o) => v.setUint8(o, x),
        uint8: (v, x, o) => v.setUint8(o, x),
        boolean: (v, x, o) => v.setUint8(o, x ? 1 : 0),
        i8: (v, x, o) => v.setInt8(o, x),
        int8: (v, x, o) => v.setInt8(o, x),
        u16: (v, x, o, le) => v.setUint16(o, x, le),
        uint16: (v, x, o, le) => v.setUint16(o, x, le),
        i16: (v, x, o, le) => v.setInt16(o, x, le),
        int16: (v, x, o, le) => v.setInt16(o, x, le),
        u32: (v, x, o, le) => v.setUint32(o, x, le),
        uint32: (v, x, o, le) => v.setUint32(o, x, le),
        i32: (v, x, o, le) => v.setInt32(o, x, le),
        int32: (v, x, o, le) => v.setInt32(o, x, le),
        f32: (v, x, o, le) => v.setFloat32(o, x, le),
        float: (v, x, o, le) => v.setFloat32(o, x, le),
        f64: (v, x, o, le) => v.setFloat64(o, x, le),
        double: (v, x, o, le) => v.setFloat64(o, x, le),
        u64: (v, x, o, le) => v.setBigUint64(o, BigInt(x), le),
        uint64: (v, x, o, le) => v.setBigUint64(o, BigInt(x), le),
        i64: (v, x, o, le) => v.setBigInt64(o, BigInt(x), le),
        int64: (v, x, o, le) => v.setBigInt64(o, BigInt(x), le),
        usize: wordSize === "64"
            ? (v, x, o, le) => v.setBigUint64(o, BigInt(x), le)
            : (v, x, o, le) => v.setUint32(o, x, le),
    };
    return writers;
};

export function createInterpretedCodec(
    plan: LayoutPlan,
    options: { endian?: "le" | "be" } = {}
): InterpretedSuite {
    const isLE = (options.endian ?? plan.endian) === "le";
    const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

    const primReaders = createPrimReaders(plan.wordSize || "32");
    const primWriters = createPrimWriters(plan.wordSize || "32");

    // Wyciągnięcie jedno-elementowych enumów wygenerowanych przez ArkType
    const singletonEnumByName = new Map<string, string>();
    for (const t of plan.types) {
        if (t.kind === "enum" && (t as any).variants?.length === 1) {
            singletonEnumByName.set(t.name, (t as any).variants[0].name);
        }
    }

    const readPrim = (name: string, view: DataView, off: number): any => {
        const r = primReaders[name.toLowerCase()] || primReaders.u8;
        return r(view, off, isLE);
    };

    const writePrim = (name: string, val: any, view: DataView, off: number): void => {
        const w = primWriters[name.toLowerCase()] || primWriters.u8;
        w(view, val, off, isLE);
    };

    const getItemStep = (item: Field): number => {
        if ((item as any).paddedSize !== undefined) return (item as any).paddedSize;
        if ((item as any).size !== undefined) return (item as any).size;
        if (item.kind === "string") return 4 + ((item as any).maxLength ?? 0);
        if (item.kind === "reference") {
            const ref = plan.types.find((t) => t.name === (item as any).name);
            return (ref as any)?.paddedSize ?? (ref as any)?.size ?? 0;
        }
        return 0;
    };

    // --- Odczyt, zapis i patch pól ---

    const readField = (f: Field, view: DataView, off: number): any => {
        switch (f.kind) {
            case "primitive":
                return readPrim(f.name, view, off);

            case "reference": {
                const lit = singletonEnumByName.get(f.name);
                if (lit !== undefined) return lit;
                const codec = codecs.get(f.name);
                if (!codec) throw new Error(`Unknown type reference: ${f.name}`);
                return codec.deserialize(view, off);
            }

            case "string": {
                const len = view.getUint32(off, isLE);
                return textDecoder!.decode(new Uint8Array(view.buffer, view.byteOffset + off + 4, len));
            }

            case "array": {
                const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
                if (isU8) {
                    if (f.exactLength !== undefined) {
                        return new Uint8Array(view.buffer, view.byteOffset + off, f.exactLength);
                    }
                    const len = view.getUint32(off, isLE);
                    return new Uint8Array(view.buffer, view.byteOffset + off + 4, len);
                }

                const step = getItemStep(f.item);
                const len = f.exactLength !== undefined ? f.exactLength : view.getUint32(off, isLE);
                const start = f.exactLength !== undefined ? off : off + 4;

                const res: any[] = [];
                for (let i = 0; i < len; i++) {
                    res.push(readField(f.item, view, start + i * step));
                }
                return res;
            }

            case "optional": {
                return view.getUint8(off) === 1 ? readField(f.inner, view, off + 1) : undefined;
            }

            case "inlineStruct": {
                const obj: any = {};
                for (const sf of f.fields) {
                    obj[sf.name] = readField(sf.type, view, off + sf.offset);
                }
                return obj;
            }

            case "unit": {
                const sz = (f as any).size ?? 0;
                return sz > 0 ? new Uint8Array(view.buffer, view.byteOffset + off, sz) : undefined;
            }

            default:
                return undefined;
        }
    };

    const writeField = (f: Field, val: any, view: DataView, off: number): void => {
        switch (f.kind) {
            case "primitive":
                writePrim(f.name, val, view, off);
                break;

            case "reference":
                if (singletonEnumByName.has(f.name)) {
                    view.setUint8(off, 0);
                    return;
                }
                codecs.get(f.name)!.serialize(val, view, off);
                break;

            case "string": {
                const maxLen = f.maxLength ?? 255;
                const bytes = textEncoder!.encode(val);
                const len = Math.min(bytes.length, maxLen);
                view.setUint32(off, len, isLE);
                const target = new Uint8Array(view.buffer, view.byteOffset + off + 4, maxLen);
                target.fill(0);
                target.set(bytes.subarray(0, len));
                break;
            }

            case "array": {
                const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
                if (isU8) {
                    const src = val instanceof Uint8Array ? val : new Uint8Array(val);
                    if (f.exactLength !== undefined) {
                        const target = new Uint8Array(view.buffer, view.byteOffset + off, f.exactLength);
                        target.fill(0);
                        target.set(src.subarray(0, f.exactLength));
                    } else {
                        view.setUint32(off, src.length, isLE);
                        new Uint8Array(view.buffer, view.byteOffset + off + 4, src.length).set(src);
                    }
                    return;
                }

                const step = getItemStep(f.item);
                if (f.exactLength !== undefined) {
                    for (let i = 0; i < f.exactLength; i++) {
                        writeField(f.item, val[i], view, off + i * step);
                    }
                } else {
                    view.setUint32(off, val.length, isLE);
                    const start = off + 4;
                    for (let i = 0; i < val.length; i++) {
                        writeField(f.item, val[i], view, start + i * step);
                    }
                }
                break;
            }

            case "optional":
                if (val !== undefined) {
                    view.setUint8(off, 1);
                    writeField(f.inner, val, view, off + 1);
                } else {
                    view.setUint8(off, 0);
                }
                break;

            case "inlineStruct":
                for (const sf of f.fields) {
                    writeField(sf.type, val[sf.name], view, off + sf.offset);
                }
                break;

            case "unit": {
                const sz = (f as any).size ?? 0;
                if (sz > 0) {
                    const target = new Uint8Array(view.buffer, view.byteOffset + off, sz);
                    target.fill(0);
                    target.set(val.subarray(0, sz));
                }
                break;
            }
        }
    };

    const patchField = (
        f: Field,
        path: (string | number)[],
        pathIdx: number,
        val: any,
        view: DataView,
        off: number
    ): void => {
        switch (f.kind) {
            case "primitive":
                writePrim(f.name, val, view, off);
                break;

            case "reference":
                if (singletonEnumByName.has(f.name)) {
                    view.setUint8(off, 0);
                    return;
                }
                codecs.get(f.name)!.patch(path, pathIdx + 1, val, view, off);
                break;

            case "string":
                writeField(f, val, view, off);
                break;

            case "array": {
                const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
                const idxExpr = path[pathIdx] as number;
                if (pathIdx >= path.length) {
                    writeField(f, val, view, off);
                    return;
                }
                if (isU8) {
                    const itemOffset = f.exactLength !== undefined ? 0 : 4;
                    view.setUint8(off + itemOffset + idxExpr, val);
                    return;
                }
                const step = getItemStep(f.item);
                const itemOff = off + (f.exactLength !== undefined ? 0 : 4) + idxExpr * step;
                if (f.item.kind === "primitive") {
                    patchField(f.item, path, pathIdx + 1, val, view, itemOff);
                } else if (f.item.kind === "reference") {
                    codecs.get((f.item as any).name)!.patch(path, pathIdx + 1, val, view, itemOff);
                }
                break;
            }

            case "optional":
                if (val !== undefined) {
                    view.setUint8(off, 1);
                    patchField(f.inner, path, pathIdx + 1, val, view, off + 1);
                } else {
                    view.setUint8(off, 0);
                }
                break;

            case "inlineStruct": {
                const subKey = path[pathIdx + 1];
                const sf = f.fields.find((field) => field.name === subKey);
                if (sf) {
                    patchField(sf.type, path, pathIdx + 1, val, view, off + sf.offset);
                }
                break;
            }

            case "unit":
                writeField(f, val, view, off);
                break;
        }
    };

    const codecs = new Map<string, TypeCodec>();

    for (const t of plan.types) {
        if (t.kind === "enum" && singletonEnumByName.has(t.name)) continue;

        if (t.kind === "alias") {
            codecs.set(t.name, {
                deserialize: (view, offset = 0) => readField(t.type, view, offset),
                serialize: (val, view, offset = 0) => writeField(t.type, val, view, offset),
                patch: (path, pathIdx, val, view, offset = 0) => {
                    if (pathIdx >= path.length) {
                        writeField(t.type, val, view, offset);
                        return;
                    }
                    patchField(t.type, path, pathIdx, val, view, offset);
                },
            });
        } else if (t.kind === "enum") {
            codecs.set(t.name, {
                deserialize: (view, offset = 0) => {
                    const v = readPrim(t.underlyingType, view, offset);
                    const variant = t.variants.find((varItem: any) => varItem.value === v);
                    if (!variant) throw new Error(`Unknown Enum value for ${t.name}: ${v}`);
                    return variant.name;
                },
                serialize: (val, view, offset = 0) => {
                    const variant = t.variants.find((varItem: any) => varItem.name === val);
                    if (variant) writePrim(t.underlyingType, variant.value, view, offset);
                },
                patch: (path, pathIdx, val, view, offset = 0) => {
                    const variant = t.variants.find((varItem: any) => varItem.name === val);
                    if (variant) writePrim(t.underlyingType, variant.value, view, offset);
                },
            });
        } else if (t.kind === "struct") {
            codecs.set(t.name, {
                deserialize: (view, offset = 0, outObj) => {
                    const target = outObj || {};
                    for (const f of t.fields) {
                        if ((f as any).bitOffset !== undefined) {
                            const bitSize = (f as any).bitSize;
                            const bitOffset = (f as any).bitOffset;
                            const mask = Math.pow(2, bitSize) - 1;
                            const size = f.size || 1;
                            const primName = size === 4 ? "u32" : size === 2 ? "u16" : "u8";
                            const raw = (readPrim(primName, view, offset + f.offset) >> bitOffset) & mask;
                            const isBool = (f.type as any).name === "boolean" || (f.type as any).name === "boolean";
                            target[f.name] = isBool ? raw !== 0 : raw;
                        } else {
                            target[f.name] = readField(f.type, view, offset + f.offset);
                        }
                    }
                    return target;
                },

                serialize: (val, view, offset = 0) => {
                    const handledBitBytes = new Set<number>();
                    for (const f of t.fields) {
                        if ((f as any).bitOffset !== undefined) {
                            if (handledBitBytes.has(f.offset)) continue;
                            handledBitBytes.add(f.offset);
                            const sameBytes = t.fields.filter(
                                (sf: any) => sf.offset === f.offset
                            );
                            let word = 0;
                            const size = f.size || 1;
                            for (const bf of sameBytes) {
                                const mask = Math.pow(2, (bf as any).bitSize) - 1;
                                const primName = (bf.type as any).name;
                                const isBool = primName === "boolean";
                                const srcVal = isBool ? (val[bf.name] ? 1 : 0) : val[bf.name];
                                word |= (srcVal & mask) << (bf as any).bitOffset;
                            }
                            const wPrim = size === 4 ? "u32" : size === 2 ? "u16" : "u8";
                            writePrim(wPrim, word, view, offset + f.offset);
                        } else {
                            writeField(f.type, val[f.name], view, offset + f.offset);
                        }
                    }
                },

                patch: (path, pathIdx, val, view, offset = 0) => {
                    if (pathIdx >= path.length) {
                        codecs.get(t.name)!.serialize(val, view, offset);
                        return;
                    }
                    const key = path[pathIdx];
                    const f = t.fields.find((field: any) => field.name === key);
                    if (!f) return;

                    if ((f as any).bitOffset !== undefined) {
                        const size = f.size || 1;
                        const rPrim = size === 4 ? "u32" : size === 2 ? "u16" : "u8";
                        const mask = Math.pow(2, (f as any).bitSize) - 1;
                        const isBool = (f.type as any).name === "boolean" || (f.type as any).name === "boolean";
                        const src = isBool ? (val ? 1 : 0) : val;

                        let temp = readPrim(rPrim, view, offset + f.offset);
                        temp &= ~((mask << (f as any).bitOffset) >>> 0);
                        temp |= (src & mask) << (f as any).bitOffset;
                        writePrim(rPrim, temp >>> 0, view, offset + f.offset);
                    } else {
                        patchField(f.type, path, pathIdx + 1, val, view, offset + f.offset);
                    }
                },
            });
        } else if (t.kind === "union") {
            const align = t.align || 1;
            const payloadOffset = Math.ceil((t.tagOffset + t.tagSize) / align) * align;
            const discField = t.discriminant || "kind";

            codecs.set(t.name, {
                deserialize: (view, offset = 0) => {
                    const tag = readPrim(t.tagType, view, offset + t.tagOffset);
                    const variantIdx = t.variants.findIndex(
                        (v: any, i: number) => (v.tag ?? i + 1) === tag
                    );
                    if (variantIdx === -1) throw new Error(`Unknown Union tag for ${t.name}: ${tag}`);

                    const v: any = t.variants[variantIdx];
                    const payload = readField(v.type, view, offset + payloadOffset);
                    const discVal = v.discriminantValue ?? v.name;

                    if (v.type.kind === "inlineStruct" || v.type.kind === "reference") {
                        payload[discField] = discVal;
                        return payload;
                    }
                    return { [discField]: discVal, value: payload };
                },

                serialize: (val, view, offset = 0) => {
                    const unionBytes = (t as any).paddedSize ?? (t as any).size ?? 0;
                    if (unionBytes > 0) {
                        new Uint8Array(view.buffer, view.byteOffset + offset, unionBytes).fill(0);
                    }

                    const discVal = val[discField];
                    const variantIdx = t.variants.findIndex(
                        (v: any) => (v.discriminantValue ?? v.name) === discVal
                    );

                    if (variantIdx !== -1) {
                        const v: any = t.variants[variantIdx];
                        const tagVal = v.tag ?? variantIdx + 1;
                        writePrim(t.tagType, tagVal, view, offset + t.tagOffset);
                        const isObj = v.type.kind === "inlineStruct" || v.type.kind === "reference";
                        writeField(v.type, isObj ? val : val.value, view, offset + payloadOffset);
                    }
                },

                patch: (path, pathIdx, val, view, offset = 0) => {
                    codecs.get(t.name)!.serialize(val, view, offset);
                },
            });
        }
    }

    return {
        codecs,
        get<T = any>(typeName: string): TypeCodec<T> {
            const c = codecs.get(typeName);
            if (!c) throw new Error(`Codec for type '${typeName}' not found.`);
            return c as TypeCodec<T>;
        },
    };
}