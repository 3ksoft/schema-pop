import { scope } from "arktype";

/**
 * Self-contained arktype scope. The only runtime dep is
 * `arktype` itself — primitive bounds (u8, i32, …) are
 * inlined at the top of the scope, not imported from
 * `schema-pop`. Each named type is re-exported below as
 * `${Name}Schema` (a Type instance) plus a `type ${Name}`
 * inferred from it.
 */
export const $ = scope({
	bool: "boolean",
	u8: "0 <= number.integer <= 255",

	Role: "'admin' | 'editor' | 'viewer'",
	Address: {
		"city": "string <= 40",
		"country": "string <= 2",
		"street": "string <= 80",
		"zip": "string <= 12",
	},
	Contact: {
		"address": "Address",
		"name": "string <= 60",
		"notes?": "string <= 500",
		"active": "bool",
		"age": "u8",
		"role": "Role",
		"tags": "unknown",
	},
});

export const { Role: RoleSchema, Address: AddressSchema, Contact: ContactSchema } = $.export();

export type Role = typeof RoleSchema.infer;
export type Address = typeof AddressSchema.infer;
export type Contact = typeof ContactSchema.infer;

