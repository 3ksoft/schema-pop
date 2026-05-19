// Demo schema for the nuxt-ui exporter — a contact-form-ish shape
// covering every field kind that maps to a UI control: enum reference
// (USelectMenu), nested struct reference (child *Form.vue), array with
// add/remove, optional with set/unset toggle, bounded string, signed
// + unsigned integers (UInputNumber with bounds from binary),
// bool checkbox, and a deprecation marker.
//
// Generated files land in ./forms/ — open them to see the output.

import { schemaPop, scope, binary } from "@schema-pop/schema";
import { nuxtUi } from "@schema-pop/exporter";

export const $ = schemaPop(
	{
		// Forms operate on logical shape, not byte layout — `rich` mode
		// keeps unbounded strings, string arrays, maps, etc. as
		// first-class fields instead of collapsing them to padding.
		mode: "rich",
		targets: [nuxtUi({ dest: "./forms/" })],
	},
	scope({
		...binary.import(),

		Role: "'admin' | 'editor' | 'viewer'",

		Address: {
			street: "string <= 80",
			city: "string <= 40",
			zip: "string <= 12",
			country: "string <= 2",
		},

		Contact: {
			name: "string <= 60",
			age: "u8",
			role: "Role",
			active: "bool",
			address: "Address",
			tags: "string[] <= 10",
			"notes?": "string <= 500",
		},
	}),
);
