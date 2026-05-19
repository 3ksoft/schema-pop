import type {
	BaseRoot,
	DomainNode,
	IntersectionNode,
	StructureNode,
	UnionNode,
	UnitNode,
} from "@ark/schema";
import type { ExtractionContext, PopModule } from "@schema-pop/schema";
import {
	Base,
	binary,
	PopSchema,
	PopSchemaSettings,
	PopType,
} from "@schema-pop/schema";
import { type } from "arktype";
import { getConstraints } from "./shared";

const ANY = PopType.assert({
	type: "any",
	description: "Could not resolve type",
});

function assertPopType(field: unknown, ctx: ExtractionContext): PopType {
	const valid = PopType(field);
	if (valid instanceof type.errors) {
		for (const k in valid.entries) {
			ctx.errors.push(k);
		}
		return { type: "any" };
	}
	return valid;
}

export function fromModule(
	module: PopModule,
	options?: PopSchemaSettings,
): ExtractionContext {
	const ctx: ExtractionContext = {
		warnings: [],
		errors: [],
		map: new Map(),
		module,
		schema: PopSchema.assert({
			...options,
			types: {},
			functions: {},
		}),
	};

	for (const [name, exType] of Object.entries(module)) {
		ctx.map.set(exType.expression, name);
	}

	for (const [name, exType] of Object.entries(module)) {
		ctx.schema.types[name] = extractBaseRoot(name, exType.internal, ctx);
	}

	return ctx;
}

function extractBaseRoot(
	label: string,
	root: BaseRoot,
	ctx: ExtractionContext,
): PopType {
	if (!root.kind) return ANY;
	const linkedName = ctx.map.get(root.expression);
	if (linkedName && label !== linkedName)
		return assertPopType({ type: "link", target: linkedName }, ctx);

	let popType: PopType | null = null;

	if (root.hasKind("domain")) popType = extractDomain(root, ctx);
	else if (root.hasKind("union")) popType = extractUnion(label, root, ctx);
	else if (root.hasKind("unit")) popType = extractUnit(root, ctx);
	else if (root.hasKind("intersection")) {
		// popType = extractIntersection(label, root, ctx);
		if (root.structure?.sequence) {
			popType = extractSequence(root, root.structure, ctx);
		} else if (root.structure?.props) {
			popType = extractObject(root, root.structure, ctx);
		} else {
			popType = extractConstrained(root, ctx);
		}
	}

	if (!popType) return ANY;

	return assertPopType({ ...popType, ...Base.assert(root.meta), label }, ctx);
}

function extractDomain(node: DomainNode, ctx: ExtractionContext): PopType {
	return assertPopType({ type: node.domain }, ctx);
}

function extractSequence(
	node: IntersectionNode,
	structure: StructureNode,
	ctx: ExtractionContext,
): PopType {
	if (structure?.sequence) {
		const elementNode = structure.sequence.inner.variadic;
		if (elementNode) {
			return assertPopType(
				{
					type: "array",
					...getConstraints(node),
					item: extractBaseRoot("Item", elementNode as BaseRoot, ctx),
				},
				ctx,
			);
		}
	}
	return ANY;
}

function extractObject(
	node: IntersectionNode,
	structure: StructureNode,
	ctx: ExtractionContext,
): PopType {
	const props = structure?.propsByKey;
	if (props) {
		const fields: Record<string, PopType> = {};
		for (const [key, exType] of Object.entries(props)) {
			const required = exType?.kind === "required";
			const value = exType?.inner.value;
			if (value) {
				const extracted = extractBaseRoot(key, value as BaseRoot, ctx);
				extracted.required = required;
				fields[key] = extracted;
			}
		}
		return assertPopType({ type: "object", fields }, ctx);
	}
	return ANY;
}

function extractConstrained(
	node: IntersectionNode,
	ctx: ExtractionContext,
): PopType {
	const i = node.inner;
	if (i.domain) {
		const result: any = { type: i.domain.domain };
		if (i.min) result.min = i.min.rule;
		if (i.max) result.max = i.max.rule;
		if (i.minLength) result.minLength = i.minLength.rule;
		if (i.maxLength) result.maxLength = i.maxLength.rule;
		if (i.pattern) result.pattern = i.pattern;
		if (i.divisor) result.step = i.divisor.rule;
		return assertPopType(result, ctx);
	}
	return ANY;
}

export function extractIntersection(
	name: string,
	node: IntersectionNode,
	ctx: ExtractionContext,
): PopType {
	const structure = node.structure;
	if (structure) {
		if (structure.sequence) {
			const elementNode = structure.sequence.inner.variadic;
			if (elementNode) {
				return assertPopType(
					{
						type: "array",
						...getConstraints(node),
						item: extractBaseRoot("Item", elementNode as BaseRoot, ctx),
					},
					ctx,
				);
			}
		}

		const props = structure?.propsByKey;
		if (props) {
			const fields: Record<string, PopType> = {};
			for (const [key, exType] of Object.entries(props)) {
				const required = exType?.kind === "required";
				const value = exType?.inner.value;
				if (value) {
					const extracted = extractBaseRoot(key, value as BaseRoot, ctx);
					extracted.required = required;
					fields[key] = extracted;
				}
			}
			return assertPopType({ type: "object", fields }, ctx);
		}
	}

	const i = node.inner;
	if (i.domain) {
		const result: any = { type: i.domain.domain };
		if (i.min) result.min = i.min.rule;
		if (i.max) result.max = i.max.rule;
		if (i.minLength) result.minLength = i.minLength.rule;
		if (i.maxLength) result.maxLength = i.maxLength.rule;
		if (i.pattern) result.pattern = i.pattern;
		if (i.divisor) result.step = i.divisor.rule;
		return assertPopType(result, ctx);
	}

	throw new Error(
		`Unhandled intersection structure for node: ${node.expression}`,
	);
}

function extractUnion(
	name: string,
	node: UnionNode,
	ctx: ExtractionContext,
): PopType {
	const branches = node.branches;
	const isBool =
		branches.length === 2 &&
		branches.every((b) => b.hasKind("unit") && typeof b.unit === "boolean");

	if (isBool) return assertPopType({ type: "boolean" }, ctx);

	const isEnum =
		branches.length > 0 && branches.every((b) => b.hasKind("unit"));
	if (isEnum) {
		return assertPopType(
			{
				type: "enum",
				options: branches.map((b) => {
					const val = (b as UnitNode).unit ?? (b as UnitNode).compiledValue;
					return typeof val === "string" || typeof val === "number"
						? val
						: String(val);
				}),
			},
			ctx,
		);
	}

	const variants: PopType[] = [];
	let i = 1;
	for (const branch of branches) {
		const variantName = name ? `${name}Variant${i}` : `Variant${i}`;
		variants.push(extractBaseRoot(variantName, branch as BaseRoot, ctx));
		i++;
	}

	return assertPopType(
		{
			type: "union",
			discriminant: node.discriminant ? node.discriminant.path.join(".") : "",
			variants: variants,
		},
		ctx,
	);
}

function extractUnit(node: UnitNode, ctx: ExtractionContext): PopType {
	return assertPopType(
		{
			type: "symbol",
			size: 1,
			binaryType: "u8",
			popKind: "binary",
			value: node.unit,
		},
		ctx,
	);
}

// export const $ = type.module({
// 	...binary.import(),
// 	Bodzio: {
// 		kin: "'Bodzio'",
// 		name: "string",
// 	},
// 	Franio: {
// 		kin: "'Franio'",
// 		nick: "string",
// 	},
// 	peps: "Bodzio | Franio",
// });

// const result = fromModule($);
// console.log(JSON.stringify(result, null, 2));

// import { SchemaAnalyzer } from "../";

// var analyzer = new SchemaAnalyzer();
// const ir = analyzer.analyze(result);
// console.log(JSON.stringify(ir, null, 2));

// import { tsCodec } from "../../../exporter/src/exporters/tsCodec";

// const exporter = tsCodec({});
// const rustCode = exporter.generate(ir);
// console.log(rustCode);
