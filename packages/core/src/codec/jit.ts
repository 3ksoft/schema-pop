import type { LayoutPlan, Field } from "@schema-pop/schema";
import { type Type } from "arktype"
import { resolveTypeName, type ArkTypeLike, type TypeCodec } from "./common";

export interface RuntimeCodecOptions {
    inlineRefBytes?: number;
    endian?: "le" | "be";
}

export interface RuntimeCodecSuite {
    codecs: Map<string, TypeCodec>;
    get<T = any>(typeName: string): TypeCodec<T>;
}

export function createRuntimeCodec(
    plan: LayoutPlan,
    options: RuntimeCodecOptions = {}
): RuntimeCodecSuite {
    const isLE = (options.endian ?? plan.endian) === "le" ? "true" : "false";
    const inlineBudget = options.inlineRefBytes ?? 16;

    const singletonEnumByName = new Map<string, string>();
    for (const t of plan.types) {
        if (t.kind === "enum" && (t as any).variants?.length === 1) {
            singletonEnumByName.set(t.name, (t as any).variants[0].name);
        }
    }

    const typeByName = new Map(plan.types.map((t) => [t.name, t]));

    const sizeOf = (t: any): number => t.paddedSize ?? t.size ?? 0;
    const inlineable = (name: string): boolean => {
        const t: any = typeByName.get(name);
        if (!t) return false;
        if (t.kind !== "struct" && t.kind !== "alias") return false;
        if (t.kind === "struct" && t.fields?.some((f: any) => f.type?.popKind === "bitwise")) return false;
        return sizeOf(t) <= inlineBudget;
    };

    const getPrim = (name: string) => {
        switch (name.toLowerCase()) {
            case "u8": case "uint8": case "bool": return { r: "getUint8", w: "setUint8", b: 1, isBool: name === "bool" };
            case "i8": case "int8": return { r: "getInt8", w: "setInt8", b: 1 };
            case "u16": case "uint16": return { r: "getUint16", w: "setUint16", b: 2 };
            case "i16": case "int16": return { r: "getInt16", w: "setInt16", b: 2 };
            case "u32": case "uint32": return { r: "getUint32", w: "setUint32", b: 4 };
            case "i32": case "int32": return { r: "getInt32", w: "setInt32", b: 4 };
            case "f32": case "float": return { r: "getFloat32", w: "setFloat32", b: 4 };
            case "f64": case "double": return { r: "getFloat64", w: "setFloat64", b: 8 };
            case "u64": case "uint64": return { r: "getBigUint64", w: "setBigUint64", b: 8 };
            case "i64": case "int64": return { r: "getBigInt64", w: "setBigInt64", b: 8 };
            case "usize":
                return plan.wordSize === "64"
                    ? { r: "getBigUint64", w: "setBigUint64", b: 8 }
                    : { r: "getUint32", w: "setUint32", b: 4 };
            default: return { r: "getUint8", w: "setUint8", b: 1 };
        }
    };

    const getItemStep = (item: Field): number => {
        if ((item as any).paddedSize !== undefined) return (item as any).paddedSize;
        if ((item as any).size !== undefined) return (item as any).size;
        if (item.kind === "string") return 4 + ((item as any).maxLength ?? 0);
        if (item.kind === "reference") {
            const ref = plan.types.find((t) => t.name === (item as any).name);
            if (ref) return (ref as any).paddedSize ?? (ref as any).size ?? 0;
        }
        return 0;
    };

    const genRead = (f: Field, off: string, visited: Set<string> = new Set()): string => {
        switch (f.kind) {
            case "primitive": {
                const p = getPrim(f.name);
                const call = p.b === 1 ? `view.${p.r}(${off})` : `view.${p.r}(${off}, ${isLE})`;
                if (p.isBool) return `(${call} !== 0)`;
                if (p.b === 8 && (f.name === "u64" || f.name === "i64")) return `Number(${call})`;
                return call;
            }
            case "reference": {
                const lit = singletonEnumByName.get(f.name);
                if (lit !== undefined) return `"${lit}"`;
                if (!visited.has(f.name) && inlineable(f.name)) {
                    const t: any = typeByName.get(f.name)!;
                    const sub = new Set(visited);
                    sub.add(f.name);
                    if (t.kind === "alias") return genRead(t.type, off, sub);
                    return `({ ${t.fields.map((sf: any) => `${sf.name}: ${genRead(sf.type, `${off} + ${sf.offset}`, sub)}`).join(", ")} })`;
                }
                return `codecs.get("${f.name}").deserialize(view, ${off})`;
            }
            case "string":
                return `((o) => { const l = view.getUint32(o, ${isLE}); return __textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + o + 4, l)); })(${off})`;
            case "array": {
                const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
                if (isU8) {
                    if (f.exactLength !== undefined)
                        return `new Uint8Array(view.buffer, view.byteOffset + ${off}, ${f.exactLength})`;
                    return `((o) => { const l = view.getUint32(o, ${isLE}); return new Uint8Array(view.buffer, view.byteOffset + o + 4, l); })(${off})`;
                }
                const step = getItemStep(f.item);
                const itemIsTiny = f.item.kind === "primitive";
                if (f.exactLength !== undefined && f.exactLength <= 16 && itemIsTiny) {
                    const items = Array.from({ length: f.exactLength }, (_, i) =>
                        genRead(f.item, `${off} + (${i} * ${step})`, visited)
                    );
                    return `[${items.join(", ")}]`;
                }
                const readItem = genRead(f.item, `o + (i * ${step})`, visited);
                if (f.exactLength !== undefined)
                    return `((o) => { const a = []; for(let i=0; i<${f.exactLength}; i++) a.push(${readItem}); return a; })(${off})`;
                return `((o) => { const l = view.getUint32(o, ${isLE}); const a = []; const start = o + 4; for(let i=0; i<l; i++) { const o = start; a.push(${readItem}); } return a; })(${off})`;
            }
            case "optional":
                return `(view.getUint8(${off}) === 1 ? ${genRead(f.inner, `${off} + 1`, visited)} : undefined)`;
            case "inlineStruct":
                return `({ ${f.fields.map((sf) => `${sf.name}: ${genRead(sf.type, `${off} + ${sf.offset}`, visited)}`).join(", ")} })`;
            case "unit": {
                const sz = (f as any).size ?? 0;
                return sz > 0 ? `new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz})` : `undefined`;
            }
            default: return "undefined";
        }
    };

    const genWrite = (f: Field, val: string, off: string, visited: Set<string> = new Set()): string => {
        switch (f.kind) {
            case "primitive": {
                const p = getPrim(f.name);
                let v = p.isBool ? `(${val} ? 1 : 0)` : (p.b === 8 && (f.name === "u64" || f.name === "i64")) ? `BigInt(${val})` : val;
                return p.b === 1 ? `view.${p.w}(${off}, ${v});` : `view.${p.w}(${off}, ${v}, ${isLE});`;
            }
            case "reference": {
                if (singletonEnumByName.has(f.name)) return `view.setUint8(${off}, 0);`;
                if (!visited.has(f.name) && inlineable(f.name)) {
                    const t: any = typeByName.get(f.name)!;
                    const sub = new Set(visited);
                    sub.add(f.name);
                    if (t.kind === "alias") return genWrite(t.type, val, off, sub);
                    return `{ ${t.fields.map((sf: any) => genWrite(sf.type, `${val}.${sf.name}`, `${off} + ${sf.offset}`, sub)).join(" ")} }`;
                }
                return `codecs.get("${f.name}").serialize(${val}, view, ${off});`;
            }
            case "string": {
                const maxLen = f.maxLength ?? 255;
                return `{ const bytes = __textEncoder.encode(${val}); const len = Math.min(bytes.length, ${maxLen}); view.setUint32(${off}, len, ${isLE}); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, ${maxLen}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, len).set(bytes.subarray(0, len)); }`;
            }
            case "array": {
                const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
                if (isU8) {
                    if (f.exactLength !== undefined)
                        return `{ const __src = ${val} instanceof Uint8Array ? ${val} : new Uint8Array(${val}); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${f.exactLength}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${f.exactLength}).set(__src.subarray(0, ${f.exactLength})); }`;
                    return `{ const __src = ${val} instanceof Uint8Array ? ${val} : new Uint8Array(${val}); view.setUint32(${off}, __src.length, ${isLE}); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, __src.length).set(__src); }`;
                }
                const step = getItemStep(f.item);
                const itemIsTiny = f.item.kind === "primitive";
                if (f.exactLength !== undefined && f.exactLength <= 16 && itemIsTiny) {
                    const writes = Array.from({ length: f.exactLength }, (_, i) => genWrite(f.item, `${val}[${i}]`, `${off} + (${i} * ${step})`, visited));
                    return `{ ${writes.join(" ")} }`;
                }
                const writeItem = genWrite(f.item, `${val}[i]`, `o + (i * ${step})`, visited);
                if (f.exactLength !== undefined) return `{ const o = ${off}; for(let i=0; i<${f.exactLength}; i++) { ${writeItem} } }`;
                return `{ view.setUint32(${off}, ${val}.length, ${isLE}); let o = ${off} + 4; for(let i=0; i<${val}.length; i++) { ${writeItem} } }`;
            }
            case "optional":
                return `if (${val} !== undefined) { view.setUint8(${off}, 1); ${genWrite(f.inner, val, `${off} + 1`, visited)} } else { view.setUint8(${off}, 0); }`;
            case "inlineStruct":
                return f.fields.map((sf) => genWrite(sf.type, `${val}.${sf.name}`, `${off} + ${sf.offset}`, visited)).join(" ");
            case "unit": {
                const sz = (f as any).size ?? 0;
                return sz > 0 ? `{ new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz}).set(${val}.subarray(0, ${sz})); }` : "";
            }
            default: return "";
        }
    };

    const codecs = new Map<string, TypeCodec>();
    const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

    for (const t of plan.types) {
        if (t.kind === "enum" && singletonEnumByName.has(t.name)) continue;

        let body = "";
        if (t.kind === "alias") {
            body = `
				return {
					deserialize: function(view, offset = 0) {
						return ${genRead(t.type, "offset")};
					},
					serialize: function(val, view, offset = 0) {
						${genWrite(t.type, "val", "offset")}
					}
				};
			`;
        } else if (t.kind === "enum") {
            const p = getPrim(t.underlyingType);
            const cases = t.variants.map((v) => `case ${v.value}: return "${v.name}";`).join("\n");
            const writes = t.variants.map((v) => `if (val === "${v.name}") { view.${p.w}(offset, ${v.value}${p.b > 1 ? `, ${isLE}` : ""}); return; }`).join("\n");
            body = `
				return {
					deserialize: function(view, offset = 0) {
						const v = view.${p.r}(offset${p.b > 1 ? `, ${isLE}` : ""});
						switch(v) {
							${cases}
							default: throw new Error("Unknown Enum value for ${t.name}: " + v);
						}
					},
					serialize: function(val, view, offset = 0) {
						${writes}
					}
				};
			`;
        } else if (t.kind === "struct") {
            const readField = (f: any): string => {
                if ((f.type as any).popKind === "bitwise" && f.bitOffset !== undefined) {
                    const mask = Math.pow(2, f.bitSize) - 1;
                    const size = f.size || 1;
                    const rMethod = size === 4 ? `getUint32` : size === 2 ? `getUint16` : `getUint8`;
                    const isLeParam = size > 1 ? `, ${isLE}` : ``;
                    const raw = `(view.${rMethod}(offset + ${f.offset}${isLeParam}) >> ${f.bitOffset}) & ${mask}`;
                    const primName = (f.type as any).name;
                    if (primName === "bool" || primName === "boolean") return `(${raw}) !== 0`;
                    return raw;
                }
                return genRead(f.type, `offset + ${f.offset}`);
            };

            const desReads = t.fields.map((f) => `outObj.${f.name} = ${readField(f)};`).join("\n");
            const handledBitBytes = new Set<number>();
            let serWrites = "";
            for (const f of t.fields) {
                if ((f.type as any).popKind === "bitwise" && (f as any).bitOffset !== undefined) {
                    if (handledBitBytes.has(f.offset)) continue;
                    handledBitBytes.add(f.offset);
                    const sameBytes = t.fields.filter((sf) => (sf.type as any).popKind === "bitwise" && sf.offset === f.offset);
                    const size = f.size || 1;
                    const wMethod = size === 4 ? `setUint32` : size === 2 ? `setUint16` : `setUint8`;
                    const isLeParam = size > 1 ? `, ${isLE}` : ``;
                    let stmt = `let _b${f.offset} = 0;`;
                    for (const bf of sameBytes) {
                        const mask = Math.pow(2, (bf as any).bitSize) - 1;
                        const primName = (bf.type as any).name;
                        const src = (primName === "bool" || primName === "boolean") ? `(val.${bf.name} ? 1 : 0)` : `val.${bf.name}`;
                        stmt += ` _b${f.offset} |= ((${src} & ${mask}) << ${(bf as any).bitOffset});`;
                    }
                    stmt += ` view.${wMethod}(offset + ${f.offset}, _b${f.offset}${isLeParam});`;
                    serWrites += `{ ${stmt} }\n`;
                } else {
                    serWrites += `${genWrite(f.type, `val.${f.name}`, `offset + ${f.offset}`)}\n`;
                }
            }

            body = `
				return {
					deserialize: function(view, offset = 0, outObj) {
						if (!outObj) outObj = {};
						${desReads}
						return outObj;
					},
					serialize: function(val, view, offset = 0) {
						${serWrites}
					}
				};
			`;
        }

        if (body) {
            const fn = new Function("codecs", "__textDecoder", "__textEncoder", body);
            codecs.set(t.name, fn(codecs, textDecoder, textEncoder));
        }
    }

    return {
        codecs,
        get<T>(typeOrName: string | ArkTypeLike<T> | any): TypeCodec<T> {
            const typeName = resolveTypeName(typeOrName);
            const c = codecs.get(typeName);
            if (!c) {
                throw new Error(`Codec for type '${typeName}' not found in suite.`);
            }
            return c as TypeCodec<T>;
        },
    };
}