import { scope } from "arktype";

export const ast = scope({
    SymbolUse: {
        fileId: "string",
        nodeId: "string"
    },
    Modifier: "'public' | 'private' | 'protected' | 'static' | 'readonly' | 'async' | 'abstract' | 'override' | 'accessor' | 'decorator' | 'const' | 'in' | 'out'",

    TypeDefinition: "PrimitiveType | ComplexType | ConditionalType | MappedType | IndexedAccessType",

    PrimitiveType: {
        id: "string",
        text: "string",
        category: "'primitive' | 'any' | 'unknown' | 'never' | 'void' | 'null' | 'undefined'",
    },

    ComplexType: {
        id: "string",
        text: "string",
        category: "'union' | 'intersection' | 'object' | 'function' | 'tuple' | 'array' | 'literal' | 'reference'",
        "properties?": "Record<string, string>",
        "typeArguments?": "string[]",
        "types?": "string[]",
        "returnType?": "string",
        "parameters?": "Record<string, string>"
    },

    ConditionalType: {
        id: "string",
        text: "string",
        category: "'conditional'",
        checkType: "string",
        extendsType: "string",
        trueType: "string",
        falseType: "string"
    },

    MappedType: {
        id: "string",
        text: "string",
        category: "'mapped'",
        parameter: "string",
        constraint: "string",
        template: "string",
        "readonly?": "'+' | '-' | boolean",
        "optional?": "'+' | '-' | boolean"
    },

    IndexedAccessType: {
        id: "string",
        text: "string",
        category: "'indexed_access'",
        objectType: "string",
        indexType: "string"
    },

    ASTNode: {
        id: "string",
        type: "string",
        "typeRef?": "string",
        "file?": "string",
        loc: ["number", "number"],
        "line_start?": "number",
        "line_end?": "number",
        "col_start?": "number",
        "col_end?": "number",
        "parent?": "string",
        "children?": "string[]",
        "props?": "Record<string, unknown>",
        "rels?": "Record<string, string[] | string>",
        "kind?": "'const' | 'let' | 'var'"
    },
    Diagnostic: {
        node: "string",
        severity: "'error'|'warning'|'info'",
        message: "string",
        source: "string",
    },
    DiagnosticsFacet: {
        errors: "number",
        warnings: "number",
        list: "Diagnostic[]",
    },
    FileFacet: {
        size: "number",
        mtime: "number",
        mode: "number",
        "mime?": "string",
    },
    AnalysisFacet: "Record<string, unknown>",
    Metadata: {
        diagnostics: "DiagnosticsFacet",
        analysis: "AnalysisFacet",
        file: "FileFacet",
    },
    FileNode: {
        id: "string",
        path: "string",
        lang: "string",
        size: "number",
        ast: "string",
        metadata: "Metadata",
        "deps?": "string[]",
        "externalDeps?": "string[]"
    },
    Symbol: {
        id: "string",
        name: "string",
        nodes: "string[]",
        uses: "string[]",
        "scope?": "string",
        "origin?": "string",
        "typeRef?": "string",
        "members?": "string[]",
        "isExported?": "boolean",
        "isUsed?": "boolean",
        "documentation?": "string",
        "modifiers?": "Modifier[]"
    },
    CodeStructureMeta: {
        name: "string",
        timestamp: "string",
        langs: "string[]",
        "project?": "Record<string, unknown>"
    },
    CodeStructure: {
        version: "string",
        meta: "CodeStructureMeta",
        files: "Record<string, FileNode>",
        nodes: "Record<string, ASTNode>",
        symbols: "Record<string, Symbol>",
        types: "Record<string, TypeDefinition>"
    }
});