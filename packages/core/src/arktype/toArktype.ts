import { type, type Type as ArkType } from "arktype";
import type { PopType } from "@schema-pop/schema";

/**
 * Encode a `PopType` descriptor as an ArkType schema.
 * Uses string expressions where possible for better performance and TS compatibility.
 */
export function toArktype(def: PopType): ArkType {
	if (!def) return type("unknown");

	let resType: ArkType;

	switch (def.type) {
		case "number": {
			let expr = "number";
			if (typeof def.min === "number" && typeof def.max === "number") {
				expr = `${def.min} <= number <= ${def.max}`;
			} else if (typeof def.min === "number") {
				expr = `number >= ${def.min}`;
			} else if (typeof def.max === "number") {
				expr = `number <= ${def.max}`;
			}
			let t = type(expr as any);

			if (typeof def.step === "number" && def.step > 0) {
				if (Number.isInteger(def.step)) {
					t = t.and(type(`number % ${def.step}` as any));
				} else {
					const step = def.step;
					t = t.narrow((n: number) => (n / step) % 1 === 0);
				}
			}
			resType = t;
			break;
		}
		case "boolean": {
			resType = type("boolean");
			break;
		}
		case "enum": {
			const values = (def.options ?? []).map((o) =>
				typeof o === "string"
					? o
					: typeof o === "object" && o !== null && "value" in o
						? (o as any).value
						: String(o),
			);
			resType =
				values.length === 0 ? type("string") : type.enumerated(...values);
			break;
		}
		case "array": {
			let t = def.item ? toArktype(def.item).array() : type("unknown[]");
			if (typeof def.minLength === "number")
				t = (t as any).atLeastLength(def.minLength);
			if (typeof def.maxLength === "number")
				t = (t as any).atMostLength(def.maxLength);
			resType = t as ArkType;
			break;
		}
		case "object": {
			const result: Record<string, unknown> = {};
			if (def.fields) {
				for (const [key, field] of Object.entries(def.fields)) {
					const f = field as any;
					const k = f.required === false ? `${key}?` : key;
					result[k] = toArktype(field as PopType);
				}
			}
			resType = type(result);
			break;
		}
		case "string": {
			let expr = "string";
			if (
				typeof def.minLength === "number" &&
				typeof def.maxLength === "number"
			) {
				expr = `${def.minLength} <= string <= ${def.maxLength}`;
			} else if (typeof def.minLength === "number") {
				expr = `string >= ${def.minLength}`;
			} else if (typeof def.maxLength === "number") {
				expr = `string <= ${def.maxLength}`;
			}
			let t = type(expr as any);

			if (typeof def.pattern === "string" && def.pattern.length > 0) {
				try {
					const re = new RegExp(def.pattern);
					t = t.narrow((s: string) => re.test(s));
				} catch {}
			}
			resType = t;
			break;
		}
		case "union": {
			const variants = ((def as any).variants ?? []).map((v: any) =>
				toArktype(v as PopType),
			);
			if (variants.length === 0) {
				resType = type("never");
				break;
			}
			resType = (variants as ArkType[]).reduce((acc, curr) => acc.or(curr));
			break;
		}
		case "any":
		default: {
			resType = type("unknown");
			break;
		}
	}

	const meta = def;
	if (Object.keys(meta).length > 0) resType = resType.configure(meta as any);

	return resType;
}
