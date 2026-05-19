import type {
	EnumPlan,
	Field,
	LayoutPlan,
	StructPlan,
	UnionPlan,
} from "@schema-pop/schema";

export interface MigrationPlan {
	typeName: string;
	kind: "struct" | "enum" | "union" | "alias";
	fields: {
		targetName: string;
		sourceName: string | null;
		targetType: Field;
		sourceType: Field | null;
	}[];
	variants: {
		targetName: string;
		sourceName: string | null;
		targetType?: Field;
		sourceType?: Field | null;
	}[];
}

export class MigrationEngine {
	public static analyzeMigration(
		planFrom: LayoutPlan,
		planTo: LayoutPlan,
	): MigrationPlan[] {
		const migrations: MigrationPlan[] = [];
		for (const toType of planTo.types) {
			if (toType.kind === "alias") continue;
			const fromType = planFrom.types.find((t) => t.name === toType.name);
			if (!fromType || fromType.kind !== toType.kind) continue;

			if (toType.kind === "struct") {
				const fFrom = fromType as StructPlan;
				const fields: MigrationPlan["fields"] = toType.fields.map((tf) => {
					const sf = fFrom.fields.find((f) => f.name === tf.name);
					return {
						targetName: tf.name,
						sourceName: sf ? sf.name : null,
						targetType: tf.type,
						sourceType: sf ? sf.type : null,
					};
				});
				migrations.push({
					typeName: toType.name,
					kind: "struct",
					fields,
					variants: [],
				});
			} else if (toType.kind === "enum") {
				const fFrom = fromType as EnumPlan;
				const variants: MigrationPlan["variants"] = toType.variants.map(
					(tv) => {
						const sv = fFrom.variants.find((v) => v.name === tv.name);
						return {
							targetName: tv.name,
							sourceName: sv ? sv.name : null,
						};
					},
				);
				migrations.push({
					typeName: toType.name,
					kind: "enum",
					fields: [],
					variants,
				});
			} else if (toType.kind === "union") {
				const fFrom = fromType as UnionPlan;
				const variants: MigrationPlan["variants"] = toType.variants.map(
					(tv) => {
						const sv = fFrom.variants.find((v) => v.name === tv.name);
						return {
							targetName: tv.name,
							sourceName: sv ? sv.name : null,
							targetType: tv.type,
							sourceType: sv ? sv.type : null,
						};
					},
				);
				migrations.push({
					typeName: toType.name,
					kind: "union",
					fields: [],
					variants,
				});
			}
		}
		return migrations;
	}
}
