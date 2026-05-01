export default {
	schemas: [
		{
			name: "ws_message",
			versions: [{ version: "1.0", source: "./src/schema/ws_message.ts" }],
			targets: [{ target: "rs", dest: "../firmware/src/ws_message.rs" }],
		},
	],
};
