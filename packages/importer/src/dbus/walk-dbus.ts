import type { PopType } from "@schema-pop/schema";
import { parseStringPromise } from "xml2js";
import { BaseImporter, type WalkResult } from "../toolkit";

export interface WalkDbusOptions {
	serviceName?: string;
	objectPath?: string;
}

const DBUS_PRIMITIVES: Record<
	string,
	{
		type: "number" | "boolean" | "string";
		binary: string;
		size: number;
		align: number;
	}
> = {
	y: { type: "number", binary: "u8", size: 1, align: 1 },
	b: { type: "boolean", binary: "bool", size: 4, align: 4 }, // D-Bus bool
	n: { type: "number", binary: "i16", size: 2, align: 2 },
	q: { type: "number", binary: "u16", size: 2, align: 2 },
	i: { type: "number", binary: "i32", size: 4, align: 4 },
	u: { type: "number", binary: "u32", size: 4, align: 4 },
	x: { type: "number", binary: "i64", size: 8, align: 8 },
	t: { type: "number", binary: "u64", size: 8, align: 8 },
	d: { type: "number", binary: "f64", size: 8, align: 8 },
	s: { type: "string", binary: "string", size: 4, align: 4 }, // string (offset)
	o: { type: "string", binary: "string", size: 4, align: 4 }, // object path
	g: { type: "string", binary: "string", size: 4, align: 4 }, // signature
};

export class DbusImporter extends BaseImporter {
	public async walkXml(
		xml: string,
		opts: WalkDbusOptions = {},
	): Promise<WalkResult> {
		const result = await parseStringPromise(xml);
		const rootNode = result.node;

		if (rootNode) {
			await this.visitNode(rootNode, opts.objectPath || "/");
		}

		return this.finalize();
	}

	private async visitNode(node: any, path: string): Promise<void> {
		// 1. Procesuj interfejsy w obecnym węźle
		if (node.interface) {
			for (const iface of node.interface) {
				const ifaceName = iface.$.name;
				if (ifaceName.startsWith("org.freedesktop.DBus")) continue; // pomiń standardowe

				const description = `D-Bus interface: ${ifaceName}\nPath: ${path}`;
				const fields: Record<string, PopType> = {};

				// Metody -> PopType.Function
				if (iface.method) {
					for (const m of iface.method) {
						const args = m.arg
							? m.arg.filter((a: any) => a.$.direction !== "out")
							: [];
						const returns = m.arg
							? m.arg.find((a: any) => a.$.direction === "out")
							: null;

						fields[m.$.name] = {
							type: "function",
							label: m.$.name,
							args: args.map((a: any) =>
								this.parseDbusSig(a.$.type, a.$.name || "arg"),
							),
							returns: this.parseDbusSig(
								returns ? returns.$.type : "",
								"return",
							),
							abi: "dbus",
						} as any;
					}
				}

				// Properties -> PopType.Number/String/etc
				if (iface.property) {
					for (const p of iface.property) {
						const propType = this.parseDbusSig(p.$.type, p.$.name);
						propType.description = `Access: ${p.$.access}`;
						fields[p.$.name] = propType;
					}
				}

				// Signals -> treat as functions
				if (iface.signal) {
					for (const s of iface.signal) {
						fields[`signal:${s.$.name}`] = {
							type: "function",
							label: s.$.name,
							args: (s.arg || []).map((a: any) =>
								this.parseDbusSig(a.$.type, a.$.name || "arg"),
							),
							returns: { type: "unit" },
							abi: "dbus_signal",
						} as any;
					}
				}

				// generate unique name
				const typeName = ifaceName.replace(/\./g, "_");

				this.addItem(
					typeName,
					{
						type: "object",
						typeString: ifaceName,
						fields,
						description: `D-Bus object at ${path}`,
					} as PopType,
					description,
				);
			}
		}

		// 2. Rekursja po sub-węzłach (jeśli XML zawiera definicje dzieci)
		if (node.node) {
			for (const child of node.node) {
				if (child.$ && child.$.name) {
					const childPath =
						path === "/" ? `/${child.$.name}` : `${path}/${child.$.name}`;
					await this.visitNode(child, childPath);
				}
			}
		}
	}

	private parseDbusSig(sig: string, name?: string): PopType {
		if (!sig) return { type: "unit", label: name } as any;

		// 1. Prymitywy
		const prim = DBUS_PRIMITIVES[sig];
		if (prim) {
			return {
				type: prim.type,
				binaryType: prim.binary,
				size: prim.size,
				align: prim.align,
				isBinary: true,
				popKind: "binary",
				label: name,
				originalType: sig,
			} as any;
		}

		// 2. Warianty (Any)
		if (sig === "v") {
			return { type: "any", label: name, originalType: "v" } as any;
		}

		// 3. Tablice (Array)
		if (sig.startsWith("a")) {
			const subSig = sig.substring(1);

			// Specyficzny przypadek: Słownik a{kv} -> Object
			if (subSig.startsWith("{")) {
				return {
					type: "object",
					label: name || "Dictionary",
					fields: {},
					additionalProperties: true,
					originalType: sig,
				} as any;
			}

			// Zwykła tablica
			return {
				type: "array",
				label: name || "Array",
				item: this.parseDbusSig(subSig, "item"),
				originalType: sig,
			} as any;
		}

		// 4. Struktury (...) -> Object
		if (sig.startsWith("(")) {
			return {
				type: "object",
				label: name || "Struct",
				fields: {}, // Introspekcja XML zazwyczaj nie rozbija struktur na nazwane pola
				originalType: sig,
				typeString: sig,
			} as any;
		}

		return { type: "any", label: name, originalType: sig } as any;
	}
}

/**
 * Główna funkcja wejściowa, analogiczna do walkGoFile.
 */
export async function walkDbusIntrospection(
	xml: string,
	sourcePath: string, // np. "org.kde.KWin"
	opts: { extraKnownNames?: readonly string[] } = {},
	xmlopts: WalkDbusOptions = {},
): Promise<WalkResult> {
	const importer = new DbusImporter(sourcePath, opts);
	return importer.walkXml(xml, xmlopts);
}
