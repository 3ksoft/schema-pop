import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
	TypePlan,
} from "schema-pop";
import { ExporterTools } from "schema-pop";

export interface TsCodecConfig extends BaseConfig {}
export interface TsCodecConfig
	extends Omit<BaseConfig, "commentStyle, exportStrategy"> {}

export function tsCodec(config: TsCodecConfig): ExporterPlugin<TsCodecConfig> {
	const cfg: TsCodecConfig = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		...config,
	};
	const { typeName, fieldName, indent } = ExporterTools(cfg);

	return {
		name: "ts-codec",
		config: cfg,
		getFileHeader: () => {
			let header = `
			header += `;
			header += `const __textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;\n`;
			header += `const __textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;\n\n`;
			return header;
		},

		generate: (plan: LayoutPlan) => {
			let code = "";
			const isLE = plan.endian === "le" ? "true" : "false";

			const resolveType = (name: string): TypePlan | undefined =>
				plan.types.find((t) => t.name === name);

			const getDataViewMethods = (primitiveName: string) => {
				switch (primitiveName) {
					case "u8":
						return { read: "getUint8", write: "setUint8", bytes: 1 };
					case "i8":
						return { read: "getInt8", write: "setInt8", bytes: 1 };
					case "u16":
						return { read: "getUint16", write: "setUint16", bytes: 2 };
					case "i16":
						return { read: "getInt16", write: "setInt16", bytes: 2 };
					case "u32":
						return { read: "getUint32", write: "setUint32", bytes: 4 };
					case "i32":
						return { read: "getInt32", write: "setInt32", bytes: 4 };
					case "f32":
						return { read: "getFloat32", write: "setFloat32", bytes: 4 };
					case "f64":
						return { read: "getFloat64", write: "setFloat64", bytes: 8 };
					default:
						return { read: "getUint8", write: "setUint8", bytes: 1 };
				}
			};

			const genReadExpr = (f: Field, offsetExpr: string): string => {
				switch (f.kind) {
					case "primitive":
						const dm = getDataViewMethods(f.name);
						return dm.bytes === 1
							? `view.${dm.read}(${offsetExpr})`
							: `view.${dm.read}(${offsetExpr}, ${isLE})`;

					case "reference":
						return `deserialize${typeName(f.name)}(view, ${offsetExpr})`;

					case "array":
						const itemStr = genReadExpr(f.item, `itemOffset`);
						let itemStride = 0;
						if (f.item.kind === "primitive") {
							itemStride = getDataViewMethods(f.item.name).bytes;
						} else if (f.item.kind === "reference") {
							itemStride = resolveType(f.item.name)?.paddedSize ?? 0;
						}

						return `((o) => {
\t\t\tconst len = view.getUint32(o, ${isLE});
\t\t\tconst arr = new Array(len);
\t\t\tfor (let i = 0; i < len; i++) {
\t\t\t\tconst itemOffset = o + 4 + (i * ${itemStride});
\t\t\t\tarr[i] = ${itemStr};
\t\t\t}
\t\t\treturn arr;
\t\t})(${offsetExpr})`;

					case "string":
						return `((o) => {
\t\t\tconst len = view.getUint32(o, ${isLE});
\t\t\tconst bytes = new Uint8Array(view.buffer, view.byteOffset + o + 4, len);
\t\t\treturn __textDecoder!.decode(bytes);
\t\t})(${offsetExpr})`;

					default:
						return `null as any /* unsupported field kind: ${f.kind} */`;
				}
			};

			const genWriteStmt = (
				f: Field,
				valExpr: string,
				offsetExpr: string,
			): string => {
				switch (f.kind) {
					case "primitive":
						const dm = getDataViewMethods(f.name);
						return dm.bytes === 1
							? `view.${dm.write}(${offsetExpr}, ${valExpr});`
							: `view.${dm.write}(${offsetExpr}, ${valExpr}, ${isLE});`;

					case "reference":
						return `serialize${typeName(f.name)}(${valExpr}, view, ${offsetExpr});`;

					case "array":
						let itemStride = 0;
						let itemWrite = "";
						if (f.item.kind === "primitive") {
							itemStride = getDataViewMethods(f.item.name).bytes;
							itemWrite = genWriteStmt(f.item, `${valExpr}[i]`, `itemOffset`);
						} else if (f.item.kind === "reference") {
							itemStride = resolveType(f.item.name)?.paddedSize ?? 0;
							itemWrite = genWriteStmt(f.item, `${valExpr}[i]`, `itemOffset`);
						}

						return `{
\t\t\tview.setUint32(${offsetExpr}, ${valExpr}.length, ${isLE});
\t\t\tfor (let i = 0; i < ${valExpr}.length; i++) {
\t\t\t\tconst itemOffset = ${offsetExpr} + 4 + (i * ${itemStride});
\t\t\t\t${itemWrite}
\t\t\t}
\t\t}`;

					case "string":
						const maxLen = f.maxLength ?? 255;
						return `{
\t\t\tconst bytes = __textEncoder!.encode(${valExpr});
\t\t\tconst len = Math.min(bytes.length, ${maxLen});
\t\t\tview.setUint32(${offsetExpr}, len, ${isLE});
\t\t\tnew Uint8Array(view.buffer, view.byteOffset + ${offsetExpr} + 4, ${maxLen}).fill(0); 
\t\t\tnew Uint8Array(view.buffer, view.byteOffset + ${offsetExpr} + 4, len).set(bytes.subarray(0, len));
\t\t}`;

					default:
						return `/* unsupported field kind: ${f.kind} */`;
				}
			};

			for (const t of plan.types) {
				if (t.kind === "struct") {
					code += `export function deserialize${typeName(t.name)}(view: DataView, offset: number): ${typeName(t.name)} {\n`;
					code += `\treturn {\n`;
					for (const f of t.fields) {
						code += `\t\t${fieldName(f.name)}: ${genReadExpr(f.type, `offset + ${f.offset}`)},\n`;
					}
					code += `\t};\n}\n\n`;

					code += `export function serialize${typeName(t.name)}(val: ${typeName(t.name)}, view: DataView, offset: number): void {\n`;
					for (const f of t.fields) {
						const stmt = genWriteStmt(
							f.type,
							`val.${fieldName(f.name)}`,
							`offset + ${f.offset}`,
						);

						code += `\t${stmt.replace(/\n/g, "\n\t")}\n`;
					}
					code += `}\n\n`;
				}

				if (t.kind === "union") {
					const tagMethod = getDataViewMethods(t.tagType);
					const readTag =
						tagMethod.bytes === 1
							? `view.${tagMethod.read}(offset + ${t.tagOffset})`
							: `view.${tagMethod.read}(offset + ${t.tagOffset}, ${isLE})`;

					const payloadOffset = t.align;

					code += `export function deserialize${typeName(t.name)}(view: DataView, offset: number): ${typeName(t.name)} {\n`;
					code += `\tconst tag = ${readTag};\n`;
					code += `\tswitch (tag) {\n`;
					for (const v of t.variants) {
						if (v.type.kind === "reference") {
							code += `\t\tcase ${t.variants.indexOf(v)}:\n`;
							code += `\t\t\treturn { kind: "${v.name}", ...deserialize${typeName(v.type.name)}(view, offset + ${payloadOffset}) };\n`;
						}
					}
					code += `\t\tdefault: throw new Error("Unknown union tag: " + tag);\n`;
					code += `\t}\n}\n\n`;

					code += `export function serialize${typeName(t.name)}(val: ${typeName(t.name)}, view: DataView, offset: number): void {\n`;
					code += `\tswitch (val.kind) {\n`;
					for (const v of t.variants) {
						if (v.type.kind === "reference") {
							const tagValue = t.variants.indexOf(v);
							code += `\t\tcase "${v.name}":\n`;
							const writeTag =
								tagMethod.bytes === 1
									? `view.${tagMethod.write}(offset + ${t.tagOffset}, ${tagValue});`
									: `view.${tagMethod.write}(offset + ${t.tagOffset}, ${tagValue}, ${isLE});`;

							code += `\t\t\t${writeTag}\n`;
							code += `\t\t\tserialize${typeName(v.type.name)}(val as any, view, offset + ${payloadOffset});\n`;
							code += `\t\t\tbreak;\n`;
						}
					}
					code += `\t}\n}\n\n`;
				}

				if (t.kind === "enum") {
					const underlying = getDataViewMethods(t.underlyingType);

					code += `export function deserialize${typeName(t.name)}(view: DataView, offset: number): ${typeName(t.name)} {\n`;
					const readEnum =
						underlying.bytes === 1
							? `view.${underlying.read}(offset)`
							: `view.${underlying.read}(offset, ${isLE})`;

					code += `\tconst val = ${readEnum};\n`;
					code += `\tswitch (val) {\n`;
					for (const v of t.variants) {
						code += `\t\tcase ${v.value}: return "${v.name}";\n`;
					}
					code += `\t\tdefault: throw new Error("Unknown enum val: " + val);\n`;
					code += `\t}\n}\n\n`;

					code += `export function serialize${typeName(t.name)}(val: ${typeName(t.name)}, view: DataView, offset: number): void {\n`;
					code += `\tlet num = 0;\n`;
					code += `\tswitch (val) {\n`;
					for (const v of t.variants) {
						code += `\t\tcase "${v.name}": num = ${v.value}; break;\n`;
					}
					code += `\t}\n`;
					const writeEnum =
						underlying.bytes === 1
							? `view.${underlying.write}(offset, num);`
							: `view.${underlying.write}(offset, num, ${isLE});`;
					code += `\t${writeEnum}\n}\n\n`;
				}
			}

			return code;
		},

		wrapVersion: (version, code) => {
			return `export namespace ${version} {\n${indent(code)}\n}\n`;
		},
	};
}
