import parseYaml from "yaml"; // lub js-yaml
import type { PopType } from "@schema-pop/schema";
import { BaseImporter, type WalkResult } from "./toolkit";

export interface WalkKaitaiOptions {
    extraKnownNames?: readonly string[];
}

export type KaitaiWalkResult = WalkResult & {
    rootType: string;
    settings: { endian?: "le" | "be"; bitEndian?: "le" | "be" };
};

// Słownik podstawowych typów Kaitai
const KAITAI_PRIMITIVE_ALIASES: Record<string, string> = {
    u1: "u8",
    u2: "u16", u2le: "u16", u2be: "u16",
    u4: "u32", u4le: "u32", u4be: "u32",
    u8: "u64", u8le: "u64", u8be: "u64",
    s1: "i8",
    s2: "i16", s2le: "i16", s2be: "i16",
    s4: "i32", s4le: "i32", s4be: "i32",
    s8: "i64", s8le: "i64", s8be: "i64",
    f4: "f32", f4le: "f32", f4be: "f32",
    f8: "f64", f8le: "f64", f8be: "f64",
};

export class KaitaiImporter extends BaseImporter {
    static readonly importerInfo = {
        name: "KaitaiStruct",
        supportedExtensions: [".ksy", ".yaml", ".yml"],
    };

    public parseAndWalk(yamlContent: string): KaitaiWalkResult {
        let parsed: any;
        try {
            parsed = parseYaml.parse(yamlContent);
        } catch (e) {
            throw new Error(`Failed to parse Kaitai YAML: ${(e as Error).message}`);
        }

        if (!parsed || typeof parsed !== "object") {
            return { ...this.finalize(), rootType: "Main", settings: {} };
        }

        // Główny typ pliku
        const mainId = parsed.meta?.id ?? "Main";
        const mainDoc = this.extractDoc(parsed);

        // 1. Obsłuż główne enumy i typy zagnieżdżone
        this.handleEnums(parsed.enums, "");
        this.handleTypes(parsed.types, mainId);

        // 2. Obsłuż główną strukturę (root sequence)
        this.handleStruct(mainId, parsed.seq, mainDoc, "");

        const result = this.finalize();
        const endian = parsed.meta?.endian === "le" || parsed.meta?.endian === "be" ? parsed.meta.endian : undefined;
        const bitEndian = parsed.meta?.["bit-endian"] === "le" || parsed.meta?.["bit-endian"] === "be"
            ? parsed.meta["bit-endian"]
            : undefined;
        return { ...result, rootType: mainId, settings: { endian, bitEndian } };
    }

    private handleTypes(typesDict: Record<string, any> | undefined, scopePrefix: string): void {
        if (!typesDict) return;

        for (const [typeName, typeDef] of Object.entries(typesDict)) {
            const qName = scopePrefix ? `${scopePrefix}::${typeName}` : typeName;
            const doc = this.extractDoc(typeDef);

            // Typy zagnieżdżone w typie
            if (typeDef.enums) {
                this.handleEnums(typeDef.enums, qName);
            }
            if (typeDef.types) {
                this.handleTypes(typeDef.types, qName);
            }

            this.handleStruct(typeName, typeDef.seq, doc, scopePrefix);
        }
    }

    private handleEnums(enumsDict: Record<string, any> | undefined, scopePrefix: string): void {
        if (!enumsDict) return;

        for (const [enumName, enumBody] of Object.entries(enumsDict)) {
            const qName = scopePrefix ? `${scopePrefix}::${enumName}` : enumName;
            const options: string[] = [];

            if (typeof enumBody === "object" && enumBody !== null) {
                for (const [val, detail] of Object.entries(enumBody)) {
                    if (typeof detail === "string") {
                        options.push(detail);
                    } else if (typeof detail === "object" && detail && (detail as any).id) {
                        options.push((detail as any).id);
                    } else {
                        options.push(`val_${val}`);
                    }
                }
            }

            this.addItem(qName, {
                type: "enum",
                typeString: enumName,
                options,
            } as PopType);
        }
    }

    private handleStruct(
        name: string,
        seq: any[] | undefined,
        description: string | undefined,
        scopePrefix: string,
    ): void {
        const qName = scopePrefix ? `${scopePrefix}::${name}` : name;
        const fields: Record<string, PopType> = {};

        if (Array.isArray(seq)) {
            for (const fieldDef of seq) {
                if (!fieldDef.id) continue;

                const fieldName = fieldDef.id;
                const fieldDoc = this.extractDoc(fieldDef);
                const parsedType = this.parseKaitaiType(fieldDef);

                if (fieldDoc) {
                    parsedType.description = fieldDoc;
                }

                fields[fieldName] = parsedType;
            }
        }

        this.addItem(
            qName,
            { type: "object", typeString: name, fields } as PopType,
            description,
        );
    }

    private parseKaitaiType(fieldDef: any): PopType {
        let baseType: PopType;

        // 1. Dopasowanie typu podstawowego
        const rawType = fieldDef.type;

        if (!rawType) {
            // W Kaitai jeśli nie podano typów, często oznacza to surowe bajty (rozmiar w `size`)
            if (fieldDef.size) {
                baseType = { type: "any", originalType: `bytes(${fieldDef.size})` } as PopType;
            } else {
                baseType = { type: "any" } as PopType;
            }
        } else if (typeof rawType === "string") {
            const prim = KAITAI_PRIMITIVE_ALIASES[rawType];
            if (prim) {
                baseType = { type: "number", binaryType: prim } as PopType;
            } else if (rawType === "str" || rawType === "strz") {
                baseType = { type: "string" } as PopType;
            } else if (rawType.startsWith("b")) {
                // Bit-fields np. b1, b4
                baseType = { type: "number", binaryType: "u32" } as PopType;
            } else {
                // Odsyłacz do innego typu/structa/enuma
                baseType = { type: "link", target: rawType } as PopType;
            }
        } else {
            baseType = { type: "any" } as PopType;
        }

        // 2. Obsługa powtórzeń (Tablice)
        if (fieldDef.repeat) {
            const exactLength = typeof fieldDef["repeat-expr"] === "number"
                ? fieldDef["repeat-expr"]
                : undefined;

            return {
                type: "array",
                item: baseType,
                ...(exactLength !== undefined ? { exactLength } : {}),
            } as PopType;
        }

        return baseType;
    }

    private extractDoc(node: any): string | undefined {
        if (!node || typeof node !== "object") return undefined;
        if (typeof node.doc === "string") return node.doc.trim();
        if (Array.isArray(node.doc)) return node.doc.join("\n").trim();
        return undefined;
    }
}

export function walkKaitaiFile(
    yamlContent: string,
    sourcePath: string,
    opts: WalkKaitaiOptions = {},
): KaitaiWalkResult {
    const importer = new KaitaiImporter(sourcePath, opts);
    return importer.parseAndWalk(yamlContent);
}
