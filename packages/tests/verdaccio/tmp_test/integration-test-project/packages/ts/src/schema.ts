export namespace v1_0_0 {
	export interface Telemetry {
		id: number;
		value: number;
		active: boolean;
	}
	
	export const LAYOUT_PLAN = {
		"schemaName": "Schema",
		"endian": "le",
		"wordSize": "64",
		"autoSort": false,
		"autoPack": false,
		"layout": "aligned",
		"mode": "binary",
		"version": "1.0.0",
		"types": [
			{
				"kind": "struct",
				"name": "Telemetry",
				"size": 12,
				"align": 4,
				"paddedSize": 12,
				"fields": [
					{
						"name": "id",
						"type": {
							"type": "number",
							"min": 0,
							"max": 4294967295,
							"size": 4,
							"align": 4,
							"bitSize": 32,
							"description": "unsigned 32-bit integer",
							"popKind": "binary",
							"isBinary": true,
							"binaryType": "u32",
							"label": "id",
							"required": true,
							"kind": "primitive",
							"name": "u32",
							"paddedSize": 4
						},
						"offset": 0,
						"bitOffset": 0,
						"bitSize": 32,
						"size": 4,
						"paddingAfter": 0
					},
					{
						"name": "value",
						"type": {
							"type": "number",
							"size": 4,
							"align": 4,
							"bitSize": 32,
							"description": "32-bit float",
							"popKind": "binary",
							"isBinary": true,
							"binaryType": "f32",
							"label": "value",
							"required": true,
							"kind": "primitive",
							"name": "f32",
							"paddedSize": 4
						},
						"offset": 4,
						"bitOffset": 0,
						"bitSize": 32,
						"size": 4,
						"paddingAfter": 0
					},
					{
						"name": "active",
						"type": {
							"kind": "primitive",
							"name": "boolean",
							"size": 1,
							"align": 1,
							"paddedSize": 1,
							"bitSize": 8,
							"unsigned": true,
							"type": "boolean",
							"label": "active",
							"required": true
						},
						"offset": 8,
						"bitOffset": 0,
						"bitSize": 8,
						"size": 1,
						"paddingAfter": 3
					}
				],
				"description": ""
			}
		]
	} as const;
	
	}
