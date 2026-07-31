
export interface TypeCodec<T = any> {
    deserialize(view: DataView, offset?: number, outObj?: any): T;
    serialize(val: T, view: DataView, offset?: number): void;
    patch(path: (string | number)[], pathIdx: number, val: any, view: DataView, offset?: number): void;
}

export type ArkTypeLike<T = any> = {
    infer: T;
    expression?: string;
    name?: string;
};

export interface CodecSuite {
    codecs: Map<string, TypeCodec>;

    get<T>(type: ArkTypeLike<T>): TypeCodec<T>;
    get<T = any>(typeName: string): TypeCodec<T>;
}

export function resolveTypeName(typeOrName: string | ArkTypeLike | any): string {
    if (typeof typeOrName === "string") {
        return typeOrName;
    }
    if (typeOrName && typeof typeOrName === "object") {
        const name = typeOrName.expression || typeOrName.name || typeOrName.internal?.label;
        if (name) return name;
    }
    throw new Error(`Could not resolve type name from: ${typeOrName}`);
}