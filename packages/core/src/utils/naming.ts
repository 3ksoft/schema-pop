import type { NamingStrategy } from "../schema";

export function toSnakeCase(str: string): string {
	return str
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[-\s]+/g, "_")
		.toLowerCase();
}

export function toCamelCase(str: string): string {
	if (!str) return str;
	const s = toPascalCase(str);
	return s.charAt(0).toLowerCase() + s.slice(1);
}

export function toPascalCase(str: string): string {
	if (!str) return str;
	return toSnakeCase(str)
		.split("_")
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
}

export function applyNaming(name: string, strategy: NamingStrategy): string {
	if (strategy === "original" || !name) return name;
	switch (strategy) {
		case "snake_case":
			return toSnakeCase(name);
		case "camelCase":
			return toCamelCase(name);
		case "PascalCase":
			return toPascalCase(name);
		default:
			return name;
	}
}
