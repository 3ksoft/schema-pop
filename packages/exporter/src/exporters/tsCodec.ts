import type { BaseConfig, ExporterPlugin } from "../api";
import type { Field, LayoutPlan } from "@schema-pop/schema";
import { ExporterTools, toSnakeCase } from "../exporterTools";

export interface TsCodecConfig extends Omit<BaseConfig, "commentStyle"> {
	importPath?: string;
	/**
	 * Inline reference reads/writes for non-recursive structs/aliases up to this
	 * many bytes. Small aliases (e.g. `Vec3 = f32[] == 3`) benefit greatly,
	 * but inlining whole structs into their callers can produce functions
	 * large enough that the JS engine refuses to JIT-optimize them — leading
	 * to *slower* code. Default 16 bytes, which catches Vec3-like aliases but
	 * keeps struct refs as function calls.
	 */
	inlineRefBytes?: number;
	/**
	 * Generates surgical patch functions (`patch[TypeName]`) to perform
	 * zero-allocation, byte-targeted updates directly on a DataView.
	 */
	generatePatches?: boolean;
}

export function tsCodec(config: TsCodecConfig): ExporterPlugin<TsCodecConfig, string> {
	const cfg = { fieldNaming: "original", typeNaming: "original", ...config };
	const { typeName, fieldName } = ExporterTools(cfg as any);

	return {
		name: "ts-codec",
		config: cfg as any,
		getFileHeader: () =>
			`const __textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;\n` +
			`const __textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;\n\n`,

		generate: (plan: LayoutPlan) => {
			let code = "";
			const isLE = plan.endian === "le" ? "true" : "false";
			const inlineBudget = config.inlineRefBytes ?? 16;

			// A field is bit-packed only when it occupies FEWER bits than its
			// storage unit. Every field carries `bitOffset` (0 for the common
			// case), so testing `bitOffset !== undefined` classified whole f32s
			// and struct references as bitfields and emitted shift/mask reads
			// for them. Same predicate as the runtime codecs in core.
			const isPackedField = (f: any): boolean =>
				(f.bitSize ?? 0) > 0 && (f.size ?? 0) > 0 && f.bitSize < f.size * 8;

			// Single-option synthesized enums (the per-variant `kind` discriminator
			// literals) don't exist on the original arktype Module. Inline their
			// read/write at the reference sites and skip emitting their ser/de.
			const singletonEnumByName = new Map<string, string>();
			for (const t of plan.types) {
				if (t.kind === "enum" && (t as any).variants?.length === 1) {
					singletonEnumByName.set(t.name, (t as any).variants[0].name);
				}
			}

			const typeByName = new Map(plan.types.map((t) => [t.name, t]));

			const getVariantDiscriminantValue = (v: any, t: any): string => {
				// Preserved raw discriminant literal (binary layouts strip the kind
				// field, so we can't re-derive it from the struct).
				if (v.discriminantValue != null) return v.discriminantValue;
				const disc = t.discriminant || "kind";
				if (v.type.kind === "reference") {
					const vStruct: any = typeByName.get(v.type.name);
					if (vStruct && vStruct.kind === "struct") {
						const f = vStruct.fields.find((field: any) => field.name === disc);
						if (f && f.type.kind === "reference") {
							const refType: any = typeByName.get(f.type.name);
							if (refType && refType.kind === "enum" && refType.variants && refType.variants.length > 0) {
								return refType.variants[0].name;
							}
						}
					}
				}
				return v.name;
			};

			const sizeOf = (t: any): number => t.paddedSize ?? t.size ?? 0;
			const inlineable = (name: string): boolean => {
				const t: any = typeByName.get(name);
				if (!t?.inlineSafe) return false;
				// The inline emitters below can only spell out a struct (object
				// literal over `fields`) or an alias (delegation). Enums and unions
				// have no `fields` and must keep going through their generated
				// deserialize/serialize functions, or emission throws on undefined.
				if (t.kind !== "struct" && t.kind !== "alias") return false;
				return sizeOf(t) <= inlineBudget;
			};
			const inlineEmittable = (t: any): boolean =>
				t?.kind === "struct" || t?.kind === "alias";

			const getPrim = (name: string) => {
				switch (name.toLowerCase()) {
					case "u8":
					case "uint8":
					case "boolean":
						return {
							r: "getUint8",
							w: "setUint8",
							b: 1,
							isBool: name === "boolean",
						};
					case "i8":
					case "int8":
						return { r: "getInt8", w: "setInt8", b: 1 };
					case "u16":
					case "uint16":
						return { r: "getUint16", w: "setUint16", b: 2 };
					case "i16":
					case "int16":
						return { r: "getInt16", w: "setInt16", b: 2 };
					case "u32":
					case "uint32":
						return { r: "getUint32", w: "setUint32", b: 4 };
					case "i32":
					case "int32":
						return { r: "getInt32", w: "setInt32", b: 4 };
					case "f32":
					case "float":
						return { r: "getFloat32", w: "setFloat32", b: 4 };
					case "f64":
					case "double":
						return { r: "getFloat64", w: "setFloat64", b: 8 };
					case "u64":
					case "uint64":
						return { r: "getBigUint64", w: "setBigUint64", b: 8 };
					case "i64":
					case "int64":
						return { r: "getBigInt64", w: "setBigInt64", b: 8 };
					case "usize":
						return plan.wordSize === "64"
							? { r: "getBigUint64", w: "setBigUint64", b: 8 }
							: { r: "getUint32", w: "setUint32", b: 4 };
					default:
						return { r: "getUint8", w: "setUint8", b: 1 };
				}
			};

			const getAccessors = (f: Field) => {
				if (f.kind !== "primitive")
					throw Error("Cannot extract accessor type from non-primitive");
				const tt = f.isFloat ? "Float" : f.unsigned ? "Uint" : "Int";
				var result = {
					r: `get${tt}${f.bitSize}`,
					w: `set${tt}${f.bitSize}`,
					b: 1,
					isBool: f.name === "boolean",
				};

				return result;
			};

			const getItemStep = (item: Field): number => {
				if ((item as any).paddedSize !== undefined)
					return (item as any).paddedSize;
				if ((item as any).size !== undefined) return (item as any).size;
				// Inline string elements (SharedString<N>): u32 length + N bytes.
				// Without this the per-element stride is 0 and every element of a
				// SharedVec<SharedString<N>, M> aliases the first one.
				if (item.kind === "string")
					return 4 + ((item as any).maxLength ?? 0);
				if (item.kind === "reference") {
					const ref = plan.types.find((t) => t.name === (item as any).name);
					if (ref) return (ref as any).paddedSize ?? (ref as any).size ?? 0;
				}
				return 0;
			};

			/**
			 * Collapses the arithmetic we build up while walking nested offsets:
			 * `offset + 12 + 4` → `offset + 16`, `offset + (2 * 4)` → `offset + 8`.
			 * Engines constant-fold this anyway, but folding at emit time keeps
			 * the generated source readable and keeps deeply nested reads from
			 * growing a chain of additions per level.
			 */
			const foldOffset = (expr: string): string => {
				const flat = expr.replace(/\((\d+)\s*\*\s*(\d+)\)/g, (_, a, b) =>
					String(Number(a) * Number(b)),
				);
				const m = flat.match(/^(.*?)((?:\s*\+\s*\d+)+)$/);
				if (!m) return flat;
				const sum = [...m[2]!.matchAll(/\+\s*(\d+)/g)].reduce(
					(acc, x) => acc + Number(x[1]),
					0,
				);
				const base = m[1]!.trim();
				return sum === 0 ? base : `${base} + ${sum}`;
			};

			// Set for exactly one `genRead` reference lookup, to inline a struct
			// element's fields into an array loop body regardless of
			// `inlineRefBytes`. Cleared on use so the inlining stays one level
			// deep and code size can't blow up on a nested graph.
			let inlineNextRef = false;

			const genRead = (
				f: Field,
				rawOff: string,
				visited: Set<string> = new Set(),
			): string => {
				const off = foldOffset(rawOff);
				switch (f.kind) {
					case "primitive": {
						const p = getPrim(f.name);
						const call =
							p.b === 1
								? `view.${p.r}(${off})`
								: `view.${p.r}(${off}, ${isLE})`;
						if (p.isBool) return `(${call} !== 0)`;
						// 64-bit ints come back as bigint from DataView; arktype's u64/i64
						// are typed as `number`, so cast back.
						if (p.b === 8 && (f.name === "u64" || f.name === "i64"))
							return `Number(${call})`;
						return call;
					}
					case "reference": {
						const lit = singletonEnumByName.get(f.name);
						if (lit !== undefined) return `"${lit}"`;
						const forced = inlineNextRef;
						inlineNextRef = false;
						if (
							!visited.has(f.name) &&
							(forced || inlineable(f.name)) &&
							inlineEmittable(typeByName.get(f.name))
						) {
							const t: any = typeByName.get(f.name)!;
							const sub = new Set(visited);
							sub.add(f.name);
							if (t.kind === "alias") return genRead(t.type, off, sub);
							// struct → emit object literal inline
							return `({ ${t.fields
								.map(
									(sf: any) =>
										`${fieldName(sf.name)}: ${genRead(sf.type, `${off} + ${sf.offset}`, sub)}`,
								)
								.join(", ")} })`;
						}
						return `deserialize${typeName(f.name)}(view, ${off})`;
					}
					case "string":
						return `((o) => { const l = view.getUint32(o, ${isLE}); return __textDecoder!.decode(new Uint8Array(view.buffer, view.byteOffset + o + 4, l)); })(${off})`;
					case "array": {
						const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
						if (isU8) {
							if (f.exactLength !== undefined)
								return `new Uint8Array(view.buffer, view.byteOffset + ${off}, ${f.exactLength})`;
							return `((o) => { const l = view.getUint32(o, ${isLE}); return new Uint8Array(view.buffer, view.byteOffset + o + 4, l); })(${off})`;
						}
						const step = getItemStep(f.item);
						// For tiny fixed arrays of primitives, the array literal form
						// `[a, b, c]` JITs best. For larger arrays, or arrays of
						// non-primitive items (struct refs, inline structs), prefer the
						// loop form — V8/JSC handles a single hot loop better than a
						// long literal full of repeated function calls / object inits.
						const itemIsTiny = f.item.kind === "primitive";
						if (
							f.exactLength !== undefined &&
							f.exactLength <= 16 &&
							itemIsTiny
						) {
							const items = Array.from({ length: f.exactLength }, (_, i) =>
								genRead(f.item, `${off} + (${i} * ${step})`, visited),
							);
							return `[${items.join(", ")}]`;
						}
						const readItem = genRead(f.item, `o + (i * ${step})`, visited);
						// Build with .push to keep the array packed; `new Array(N)`
						// produces a holey array that V8 deoptimizes.
						if (f.exactLength !== undefined)
							return `((o) => { const a: any[] = []; for(let i=0; i<${f.exactLength}; i++) a.push(${readItem}); return a; })(${off})`;
						return `((o) => { const l = view.getUint32(o, ${isLE}); const a: any[] = []; const start = o + 4; for(let i=0; i<l; i++) { const o = start; a.push(${readItem}); } return a; })(${off})`;
					}
					case "optional":
						return `(view.getUint8(${off}) === 1 ? ${genRead(f.inner, `${off} + 1`, visited)} : undefined)`;
					case "inlineStruct":
						return `({ ${f.fields.map((sf) => `${fieldName(sf.name)}: ${genRead(sf.type, `${off} + ${sf.offset}`, visited)}`).join(", ")} })`;
					case "unit": {
						const sz = (f as any).size ?? 0;
						return sz > 0
							? `new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz})`
							: `undefined`;
					}
					default:
						return "undefined";
				}
			};

			const genWrite = (
				f: Field,
				val: string,
				rawOff: string,
				visited: Set<string> = new Set(),
			): string => {
				const off = foldOffset(rawOff);
				switch (f.kind) {
					case "primitive": {
						const p = getPrim(f.name);
						let v: string;
						if (p.isBool) v = `(${val} ? 1 : 0)`;
						else if (p.b === 8 && (f.name === "u64" || f.name === "i64"))
							v = `BigInt(${val})`;
						else v = val;
						return p.b === 1
							? `view.${p.w}(${off}, ${v});`
							: `view.${p.w}(${off}, ${v}, ${isLE});`;
					}
					case "reference": {
						if (singletonEnumByName.has(f.name))
							return `view.setUint8(${off}, 0);`;
						const forcedW = inlineNextRef;
						inlineNextRef = false;
						if (
							!visited.has(f.name) &&
							(forcedW || inlineable(f.name)) &&
							inlineEmittable(typeByName.get(f.name))
						) {
							const t: any = typeByName.get(f.name)!;
							const sub = new Set(visited);
							sub.add(f.name);
							if (t.kind === "alias") return genWrite(t.type, val, off, sub);
							return `{ ${t.fields
								.map((sf: any) =>
									genWrite(
										sf.type,
										`${val}.${fieldName(sf.name)}`,
										`${off} + ${sf.offset}`,
										sub,
									),
								)
								.join(" ")} }`;
						}
						return `serialize${typeName(f.name)}(${val}, view, ${off});`;
					}
					case "string": {
						const maxLen = f.maxLength ?? 255;
						return `{ const bytes = __textEncoder!.encode(${val}); const len = Math.min(bytes.length, ${maxLen}); view.setUint32(${off}, len, ${isLE}); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, ${maxLen}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, len).set(bytes.subarray(0, len)); }`;
					}
					case "array": {
						const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
						if (isU8) {
							// arktype types `u8[]` as `number[]`; runtime may be either.
							// Coerce to Uint8Array so .subarray/.set work either way.
							if (f.exactLength !== undefined)
								return `{ const __src = ${val} instanceof Uint8Array ? ${val} : new Uint8Array(${val} as any); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${f.exactLength}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${f.exactLength}).set(__src.subarray(0, ${f.exactLength})); }`;
							return `{ const __src = ${val} instanceof Uint8Array ? ${val} : new Uint8Array(${val} as any); view.setUint32(${off}, __src.length, ${isLE}); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, __src.length).set(__src); }`;
						}
						const step = getItemStep(f.item);
						const itemIsTiny = f.item.kind === "primitive";
						if (
							f.exactLength !== undefined &&
							f.exactLength <= 16 &&
							itemIsTiny
						) {
							const writes = Array.from({ length: f.exactLength }, (_, i) =>
								genWrite(
									f.item,
									`${val}[${i}]!`,
									`${off} + (${i} * ${step})`,
									visited,
								),
							);
							return `{ ${writes.join(" ")} }`;
						}
						if (f.exactLength !== undefined) {
							// Mirror of the read path: carry the element offset in an
							// accumulator (no multiply per iteration) and inline a
							// struct element's field writes into the loop body.
							inlineNextRef = true;
							const inlinedItem = genWrite(f.item, `__e`, `__o`, visited);
							inlineNextRef = false;
							return `{ for (let i = 0, __o = ${off}; i < ${f.exactLength}; i++, __o += ${step}) { const __e = ${val}[i]!; ${inlinedItem} } }`;
						}
						const writeItem = genWrite(
							f.item,
							`${val}[i]!`,
							`o + (i * ${step})`,
							visited,
						);
						return `{ view.setUint32(${off}, ${val}.length, ${isLE}); let o = ${off} + 4; for(let i=0; i<${val}.length; i++) { ${writeItem} } }`;
					}
					case "optional":
						return `if (${val} !== undefined) { view.setUint8(${off}, 1); ${genWrite(f.inner, val, `${off} + 1`, visited)} } else { view.setUint8(${off}, 0); }`;
					case "inlineStruct":
						return f.fields
							.map((sf) =>
								genWrite(
									sf.type,
									`${val}.${fieldName(sf.name)}`,
									`${off} + ${sf.offset}`,
									visited,
								),
							)
							.join(" ");
					case "unit": {
						const sz = (f as any).size ?? 0;
						return sz > 0
							? `{ new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz}).set(${val}.subarray(0, ${sz})); }`
							: "";
					}
					default:
						return "";
				}
			};

			const genPatchField = (
				f: Field,
				val: string,
				off: string,
				pathIdx: string,
				isTopLevelArray: boolean = false,
				visited: Set<string> = new Set(),
			): string => {
				switch (f.kind) {
					case "primitive": {
						const p = getPrim(f.name);
						let v: string;
						if (p.isBool) v = `(${val} ? 1 : 0)`;
						else if (p.b === 8 && (f.name === "u64" || f.name === "i64"))
							v = `BigInt(${val})`;
						else v = val;
						return p.b === 1
							? `view.${p.w}(${off}, ${v});`
							: `view.${p.w}(${off}, ${v}, ${isLE});`;
					}
					case "reference": {
						if (singletonEnumByName.has(f.name))
							return `view.setUint8(${off}, 0);`;
						return `patch${typeName(f.name)}(path, ${pathIdx} + 1, ${val}, view, ${off});`;
					}
					case "string": {
						const maxLen = f.maxLength ?? 255;
						return `{ const bytes = __textEncoder!.encode(${val}); const len = Math.min(bytes.length, ${maxLen}); view.setUint32(${off}, len, ${isLE}); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, ${maxLen}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off} + 4, len).set(bytes.subarray(0, len)); }`;
					}
					case "array": {
						const isU8 = f.item.kind === "primitive" && f.item.name === "u8";
						const idxExpr = isTopLevelArray ? `${pathIdx}` : `${pathIdx} + 1`;

						let serializeWholeArrayCode = "";
						if (!isTopLevelArray) {
							serializeWholeArrayCode = `if (${pathIdx} + 1 >= path.length) { ${genWrite(f, val, off, visited)} return; } `;
						}

						if (isU8) {
							const itemOffset = f.exactLength !== undefined ? "" : "4 + ";
							return `${serializeWholeArrayCode}{ const idx = path[${idxExpr}] as number; view.setUint8(${off} + ${itemOffset}idx, ${val}); }`;
						}

						const step = getItemStep(f.item);
						const nextPathIdxExpr = isTopLevelArray ? `${pathIdx} + 1` : `${pathIdx} + 2`;

						if (f.item.kind === "primitive") {
							return `${serializeWholeArrayCode}{ const idx = path[${idxExpr}] as number; ${genPatchField(f.item, val, `${off} + (idx * ${step})`, `${pathIdx} + 1`, false, visited)} }`;
						} else if (f.item.kind === "reference") {
							return `${serializeWholeArrayCode}{ const idx = path[${idxExpr}] as number; patch${typeName((f.item as any).name)}(path, ${nextPathIdxExpr}, ${val}, view, ${off} + (idx * ${step})); }`;
						}
						return serializeWholeArrayCode;
					}
					case "optional":
						return `if (${val} !== undefined) { view.setUint8(${off}, 1); ${genPatchField(f.inner, val, `${off} + 1`, `${pathIdx} + 1`, false, visited)} } else { view.setUint8(${off}, 0); }`;
					case "inlineStruct":
						return `{ const subKey = path[${pathIdx} + 1]; switch(subKey) { ${f.fields.map((sf) => `case "${fieldName(sf.name)}": ${genPatchField(sf.type, val, `${off} + ${sf.offset}`, `${pathIdx} + 1`, false, visited)}; break;`).join(" ")} default: break; } }`;
					case "unit": {
						const sz = (f as any).size ?? 0;
						return sz > 0
							? `{ new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz}).fill(0); new Uint8Array(view.buffer, view.byteOffset + ${off}, ${sz}).set(${val}.subarray(0, ${sz})); }`
							: "";
					}
					default:
						return "";
				}
			};

			for (const t of plan.types) {
				if (t.kind === "enum") continue;
				const sz = (t as any).paddedSize ?? (t as any).size ?? 0;
				if (sz > 0) {
					code += `export const SIZEOF_${typeName(t.name)} = ${sz};\n`;
				}
				if (t.kind === "struct") {
					for (const f of t.fields) {
						if (f.type.kind === "array") {
							const len = f.type.exactLength ?? f.type.maxLength ?? 0;
							if (len > 0) {
								code += `export const ${toSnakeCase(t.name).toUpperCase()}_${fieldName(f.name).toUpperCase()}_LEN = ${len};\n`;
							}
						}
					}
				}
				if (t.kind === "alias") {
					if (t.type.kind === "array") {
						const len = t.type.exactLength ?? t.type.maxLength ?? 0;
						if (len > 0) {
							code += `export const ${toSnakeCase(t.name).toUpperCase()}_LEN = ${len};\n`;
						}
					}
				}
			}
			code += "\n";

			for (const t of plan.types) {
				const tName = typeName(t.name);
				if (t.kind === "enum" && singletonEnumByName.has(t.name)) continue;
				if (t.kind === "alias") {
					code += `export function deserialize${tName}(view: DataView, offset: number): ${tName} {\n`;
					code += `\treturn ${genRead(t.type, "offset")} as any;\n}\n\n`;
					code += `export function serialize${tName}(val: ${tName}, view: DataView, offset: number): void {\n`;
					code += `\t${genWrite(t.type, "val", "offset")}\n}\n\n`;

					if (cfg.generatePatches) {
						code += `export function patch${tName}(path: (string | number)[], pathIdx: number, val: any, view: DataView, offset: number): void {\n`;
						code += `\tif (pathIdx >= path.length) {\n`;
						code += `\t\tserialize${tName}(val, view, offset);\n`;
						code += `\t\treturn;\n`;
						code += `\t}\n`;
						code += `\t${genPatchField(t.type, "val", "offset", "pathIdx", t.type.kind === "array")}\n`;
						code += `}\n\n`;
					}
				}
				if (t.kind === "enum") {
					const p = getPrim(t.underlyingType);
					code += `export function deserialize${tName}(view: DataView, offset: number): ${tName} {\n`;
					code += `\tconst v = view.${p.r}(offset${p.b > 1 ? `, ${isLE}` : ""});\n\tswitch(v) {\n`;
					t.variants.forEach(
						(v) => (code += `\t\tcase ${v.value}: return "${v.name}";\n`),
					);
					code += `\t\tdefault: throw new Error("Unknown Enum value for ${tName}: " + v);\n\t}\n}\n\n`;
					code += `export function serialize${tName}(val: ${tName}, view: DataView, offset: number): void {\n`;
					t.variants.forEach(
						(v) =>
							(code += `\tif(val === "${v.name}") { view.${p.w}(offset, ${v.value}${p.b > 1 ? `, ${isLE}` : ""}); return; }\n`),
					);
					code += `}\n\n`;


					if (cfg.generatePatches) {
						code += `export function patch${tName}(path: (string | number)[], pathIdx: number, val: any, view: DataView, offset: number): void {\n`;
						code += `\tserialize${tName}(val, view, offset)\n`;
						code += `}\n\n`;
					}
				}
				if (t.kind === "struct") {
					const readField = (f: any): string => {
						if (isPackedField(f)) {
							const mask = Math.pow(2, f.bitSize) - 1;
							const size = f.size || 1;
							const rMethod = size === 4 ? `getUint32` : size === 2 ? `getUint16` : `getUint8`;
							const isLeParam = size > 1 ? `, ${isLE}` : ``;
							const raw = `(view.${rMethod}(offset + ${f.offset}${isLeParam}) >> ${f.bitOffset}) & ${mask}`;
							const primName = (f.type as any).name;
							if (primName === "boolean" || primName === "boolean") return `(${raw}) !== 0`;
							return raw;
						}
						return genRead(f.type, `offset + ${f.offset}`);
					};

					// Fixed-length arrays of non-u8 items are read through a
					// hoisted local instead of an IIFE inside the object literal.
					// The IIFE form allocated a closure per struct read and hid the
					// loop from the surrounding function; hoisting turns it into a
					// plain counted loop over a pre-sized array, with the element
					// offset carried in an accumulator so there is no multiply per
					// iteration. Struct elements get their fields inlined into the
					// loop body (one level) rather than going through a call.
					const hoistable = (f: any): boolean => {
						const ft: any = f.type;
						return (
							!isPackedField(f) &&
							ft.kind === "array" &&
							ft.exactLength !== undefined &&
							!(ft.item.kind === "primitive" && ft.item.name === "u8")
						);
					};
					const hoistLocal = (f: any) => `_arr_${fieldName(f.name)}`;
					const emitHoist = (f: any, indent: string): string => {
						const ft: any = f.type;
						const n = ft.exactLength as number;
						const step = getItemStep(ft.item);
						const a = hoistLocal(f);
						const cursor = `_off_${fieldName(f.name)}`;
						inlineNextRef = true;
						const item = genRead(ft.item, cursor);
						inlineNextRef = false;
						return (
							`${indent}const ${a} = new Array(${n});\n` +
							`${indent}for (let i = 0, ${cursor} = ${foldOffset(`offset + ${f.offset}`)}; i < ${n}; i++, ${cursor} += ${step}) {\n` +
							`${indent}\t${a}[i] = ${item};\n` +
							`${indent}}\n`
						);
					};
					const readOrLocal = (f: any): string =>
						hoistable(f) ? hoistLocal(f) : readField(f);

					const hoisted = t.fields.filter(hoistable);
					code += `export function deserialize${tName}(view: DataView, offset: number, outObj?: any): ${tName} {\n`;
					code += `\tif (!outObj) {\n`;
					for (const f of hoisted) code += emitHoist(f, "\t\t");
					code += `\t\treturn {\n`;
					t.fields.forEach((f) => (code += `\t\t\t${fieldName(f.name)}: ${readOrLocal(f)},\n`));
					code += `\t\t} as any;\n\t}\n`;
					for (const f of hoisted) code += emitHoist(f, "\t");
					t.fields.forEach((f) => (code += `\toutObj.${fieldName(f.name)} = ${readOrLocal(f)};\n`));
					code += `\treturn outObj;\n}\n\n`;
					code += `export function serialize${tName}(val: ${tName}, view: DataView, offset: number): void {\n`;
					const handledBitBytes = new Set<number>();
					for (const f of t.fields) {
						if (isPackedField(f)) {
							if (handledBitBytes.has(f.offset)) continue;
							handledBitBytes.add(f.offset);
							const sameBytes = t.fields.filter(
								(sf) => sf.offset === f.offset && isPackedField(sf),
							);
							const size = f.size || 1;
							const wMethod = size === 4 ? `setUint32` : size === 2 ? `setUint16` : `setUint8`;
							const isLeParam = size > 1 ? `, ${isLE}` : ``;
							let stmt = `let _b${f.offset} = 0;`;
							for (const bf of sameBytes) {
								const mask = Math.pow(2, (bf as any).bitSize) - 1;
								const primName = (bf.type as any).name;
								const src = (primName === "boolean" || primName === "boolean")
									? `(val.${fieldName(bf.name)} ? 1 : 0)`
									: `val.${fieldName(bf.name)}`;
								stmt += ` _b${f.offset} |= ((${src} & ${mask}) << ${(bf as any).bitOffset});`;
							}
							stmt += ` view.${wMethod}(offset + ${f.offset}, _b${f.offset}${isLeParam});`;
							code += `\t{ ${stmt} }\n`;
						} else {
							code += `\t${genWrite(f.type, `val.${fieldName(f.name)}`, `offset + ${f.offset}`)}\n`;
						}
					}
					code += `}\n\n`;

					if (cfg.generatePatches) {
						code += `export function patch${tName}(path: (string | number)[], pathIdx: number, val: any, view: DataView, offset: number): void {\n`;
						code += `\tif (pathIdx >= path.length) {\n`;
						code += `\t\tserialize${tName}(val, view, offset);\n`;
						code += `\t\treturn;\n`;
						code += `\t}\n`;
						code += `\tconst key = path[pathIdx];\n`;
						code += `\tswitch(key) {\n`;

						t.fields.forEach((f) => {
							code += `\t\tcase "${fieldName(f.name)}":\n`;
							if (isPackedField(f)) {
								const size = f.size || 1;
								const rMethod = size === 4 ? `getUint32` : size === 2 ? `getUint16` : `getUint8`;
								const wMethod = size === 4 ? `setUint32` : size === 2 ? `setUint16` : `setUint8`;
								const isLeParam = size > 1 ? `, ${isLE}` : ``;
								const mask = Math.pow(2, f.bitSize) - 1;
								const primName = (f.type as any).name;
								const src = (primName === "boolean" || primName === "boolean")
									? `(val ? 1 : 0)`
									: `val`;
								code += `\t\t\t{ let temp = view.${rMethod}(offset + ${f.offset}${isLeParam}); temp &= ~(${mask} << ${f.bitOffset}); temp |= ((${src} & ${mask}) << ${f.bitOffset}); view.${wMethod}(offset + ${f.offset}, temp${isLeParam}); }\n`;
							} else {
								code += `\t\t\t${genPatchField(f.type, "val", `offset + ${f.offset}`, "pathIdx", false)}\n`;
							}
							code += `\t\t\tbreak;\n`;
						});

						code += `\t\tdefault: break;\n`;
						code += `\t}\n`;
						code += `}\n\n`;
					}
				}
				if (t.kind === "union") {
					const p = getPrim(t.tagType);
					const align = t.align || 1;
					const payloadOffset =
						Math.ceil((t.tagOffset + t.tagSize) / align) * align;

					code += `export function deserialize${tName}(view: DataView, offset: number): ${tName} {\n`;
					code += `\tconst tag = view.${p.r}(offset + ${t.tagOffset}${p.b > 1 ? `, ${isLE}` : ""});\n\tswitch(tag) {\n`;
					t.variants.forEach((v, i) => {
						const tagVal = v.tag !== undefined ? v.tag : (v as any).tag ?? (i + 1);
						const discVal = getVariantDiscriminantValue(v, t);
						const r = genRead(v.type, `offset + ${payloadOffset}`);
						const isObj =
							v.type.kind === "inlineStruct" || v.type.kind === "reference";
						// Zero-allocation approach for references, but enforces 'kind' property addition for TS discrimination.
						const discField = t.discriminant || "kind";
						if (isObj) {
							code += `\t\tcase ${tagVal}: { const obj = ${r}; (obj as any).${discField} = "${discVal}"; return obj as any; }\n`;
						} else {
							code += `\t\tcase ${tagVal}: { return { ${discField}: "${discVal}", value: ${r} } as any; }\n`;
						}
					});
					code += `\t\tdefault: throw new Error("Unknown Union tag for ${tName}: " + tag);\n\t}\n}\n\n`;

					code += `export function serialize${tName}(val: ${tName}, view: DataView, offset: number): void {\n`;
					// Zero the whole union region first: variants have different sizes,
					// so leftover bytes from a previously-written (larger) variant would
					// otherwise leak into the payload / padding.
					const unionBytes = (t as any).paddedSize ?? (t as any).size ?? 0;
					if (unionBytes > 0)
						code += `\tfor(let i=0; i<${unionBytes}; i++) view.setUint8(offset + i, 0);\n`;
					const discField = t.discriminant || "kind";
					code += `\tswitch(val.${discField}) {\n`;
					t.variants.forEach((v, i) => {
						const tagVal = v.tag !== undefined ? v.tag : (v as any).tag ?? (i + 1);
						const discVal = getVariantDiscriminantValue(v, t);
						code += `\t\tcase "${discVal}": {\n\t\t\tview.${p.w}(offset + ${t.tagOffset}, ${tagVal}${p.b > 1 ? `, ${isLE}` : ""});\n`;
						const isObj =
							v.type.kind === "inlineStruct" || v.type.kind === "reference";
						code += `\t\t\t${genWrite(v.type, isObj ? "val" : "val.value", `offset + ${payloadOffset}`)}\n\t\t\tbreak;\n\t\t}\n`;
					});
					code += `\t}\n}\n\n`;

					if (cfg.generatePatches) {
						code += `export function patch${tName}(path: (string | number)[], pathIdx: number, val: any, view: DataView, offset: number): void {\n`;
						// W przypadku unii ze zmiennymi wariantami, bezpieczną domyślną operacją jest pełna serializacja unii
						code += `\tserialize${tName}(val, view, offset);\n`;
						code += `}\n\n`;
					}
				}
			}
			return code;
		},
		wrapVersion: (_version, code) => code,
	};
}