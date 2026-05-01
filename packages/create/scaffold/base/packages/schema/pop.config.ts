export default {
    endian: "le",
    wordSize: 64,
    autoLayout: true,
    schemas: [
        {
            name: "test-schema",
            versions: [
                { version: "1.0", source: "./src/schema/test-schema.ts" },
                { version: "2.0", source: "./src/schema/test-schemaV2.ts" },
                { version: "3.0", source: "./src/schema/test-schemaV3.ts" },
            ],
            targets: [
// TARGETS_PLACEHOLDER
            ]
        }
    ]
};
