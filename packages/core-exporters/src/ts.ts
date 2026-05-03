import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	TypePlan,
	Field,
	FieldChange,
	FieldPlan,
	StructPlan,
	TypeDiff,
} from "schema-pop";
import { diffPlans, ExporterTools } from "schema-pop";

export interface TsConfig extends Omit<BaseConfig, "commentStyle"> {
	commentStyle?: "slash";
	exportJsonPlan?: boolean;
	withCodec?: boolean;
	/**
	 * Path to the user's migrations module (relative to the generated file).
	 * Each export named `migrate_<TypeName>_<from>_to_<to>` will be consulted
	 * by the generated dispatcher and per-type migration functions. Use
	 * `defineMigration` from "schema-pop" for typed partial mappers.
	 */
	migrationsModule?: string;
	/**
	 * Emit an `index.ts` barrel next to the generated per-schema files
	 * that re-exports every one of them (`export * from "./<schemaName>"`),
	 * so consumers can `import { ... } from "./schemas"` instead of
	 * spelling out each schema file. Only meaningful when more than one
	 * schema lands in the same `destDir`.
	 */
	withIndex?: boolean;
	/**
	 * `false` drops the per-schema `export namespace <name> { ... }`
	 * wrapper so the emitted types are top-level (`export interface Foo`
	 * instead of `<name>.Foo`). Only safe for single-version schemas —
	 * multi-version output would collide on identical type names.
	 *
	 * Mirrors the rust / c exporters' option of the same name.
	 */
	versionNamespace?: false;
}

const PRIMITIVE_TS: Record<string, string> = {
	u8: "number",
	u16: "number",
	u32: "number",
	i8: "number",
	i16: "number",
	i32: "number",
	f32: "number",
	f64: "number",
	u64: "bigint",
	i64: "bigint",
	u128: "bigint",
	i128: "bigint",
	bool: "boolean",
	boolean: "boolean",
	// rich-tier primitives (popKind: 'rich')
	number: "number",
	bigint: "bigint",
	string: "string",
};

export function ts(config: TsConfig): ExporterPlugin<TsConfig> {
	const cfg: TsConfig = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		...config,
	};
	const {
		typeName,
		fieldName,
		indent,
		mapScalarField,
		wrapNamespace,
		toSafeVersionIdentifier,
	} = ExporterTools(cfg);

	function fieldType(field: Field): string {
		// Pointer indirection from C imports — TS doesn't have raw
		// pointers, so model as nullable: `Foo | null`. This communicates
		// intent (the slot can be empty) without breaking on self-ref
		// structs (which would otherwise be recursive value types).
		// Pointer-to-primitive routes through the primitive map.
		if (field.kind === "reference") {
			if (field.indirection === "pointer" || field.indirection === "reference") {
				const inner = PRIMITIVE_TS[field.name] ?? typeName(field.name);
				return `${inner} | null`;
			}
		}
		const scalar = mapScalarField(field, PRIMITIVE_TS, typeName);
		if (scalar !== undefined) return scalar;
		switch (field.kind) {
			case "optional":
				return `${fieldType(field.inner)} | undefined`;
			case "string":
				return "string";
			case "array":
				return `${fieldType(field.item)}[]`;
			case "map": {
				const keyT = field.keyKind === "number" ? "number" : "string";
				return `Record<${keyT}, ${fieldType(field.value)}>`;
			}
			case "any":
				return "unknown";
			case "inlineStruct": {
				const parts = field.fields
					.filter((f) => f.type.kind !== "unit")
					.map((f) => `${fieldName(f.name)}: ${fieldType(f.type)}`);
				return `{ ${parts.join("; ")} }`;
			}
			case "unit":
				return "undefined";
			default:
				return "unknown";
		}
	}

	function jsdoc(
		t: { obsolete?: boolean; obsoleteReason?: string; description?: string },
		pad = "",
	): string {
		const lines: string[] = [];
		if (t.description) lines.push(t.description);
		if (t.obsolete)
			lines.push(
				`@deprecated${t.obsoleteReason ? ` ${t.obsoleteReason}` : ""}`,
			);
		if (lines.length === 0) return "";
		if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`;
		return `${pad}/**\n${lines.map((l) => `${pad} * ${l}`).join("\n")}\n${pad} */\n`;
	}

	function renderStruct(t: TypePlan & { kind: "struct" }): string {
		const name = typeName(t.name);
		let s = jsdoc(t as any);
		s += `export interface ${name} {\n`;
		for (const f of t.fields) {
			if (f.type.kind === "unit") continue;
			s += jsdoc(f as any, indent());
			const optional = f.type.kind === "optional";
			const inner = optional
				? fieldType((f.type as any).inner)
				: fieldType(f.type);
			s += `${indent()}${fieldName(f.name)}${optional ? "?" : ""}: ${inner};\n`;
		}
		s += `}\n`;
		return s;
	}

	function renderEnum(t: TypePlan & { kind: "enum" }): string {
		const name = typeName(t.name);
		const namesUnion = t.variants.map((v) => `"${v.name}"`).join(" | ");
		let s = jsdoc(t as any);
		s += `export const ${name} = {\n`;
		for (const v of t.variants) {
			const key = /^[A-Za-z_$][\w$]*$/.test(v.name)
				? v.name
				: JSON.stringify(v.name);
			s += `${indent()}${key}: ${v.value},\n`;
		}
		s += `} as const;\n`;
		s += `export type ${name} = ${namesUnion};\n`;
		return s;
	}

	function renderUnion(t: TypePlan & { kind: "union" }): string {
		const name = typeName(t.name);
		const branches = t.variants.map((v) => {
			if (v.type.kind === "unit") return `"${v.name}"`;
			if (v.type.kind === "reference" || v.type.kind === "inlineStruct") {
				return `({ kind: "${v.name}" } & ${fieldType(v.type)})`;
			}
			return `{ kind: "${v.name}"; value: ${fieldType(v.type)} }`;
		});
		return `${jsdoc(t as any)}export type ${name} = ${branches.join(" | ")};\n`;
	}

	function renderAlias(t: TypePlan & { kind: "alias" }): string {
		return `${jsdoc(t as any)}export type ${typeName(t.name)} = ${fieldType(t.type)};\n`;
	}

	function renderType(t: TypePlan): string {
		if (t.kind === "struct") return renderStruct(t);
		if (t.kind === "enum") return renderEnum(t);
		if (t.kind === "union") return renderUnion(t);
		if (t.kind === "alias") return renderAlias(t);
		return "";
	}

	function renderCodec(plan: LayoutPlan): string {
		const names = plan.types.map((t) => typeName(t.name));
		let s = `const _codec = new PopCodec(LAYOUT_PLAN as any);\n\n`;
		for (let i = 0; i < plan.types.length; i++) {
			const t = plan.types[i]!;
			const n = names[i]!;
			s += `export const ${n}Codec = {\n`;
			s += `${indent()}encode: (data: ${n}): Uint8Array => _codec.encode("${t.name}", data),\n`;
			s += `${indent()}decode: (buf: Uint8Array): ${n} => _codec.decode("${t.name}", buf) as ${n},\n`;
			s += `};\n`;
		}
		return s;
	}

	function tsLiteral(value: unknown): string {
		if (typeof value === "bigint") return `${value}n`;
		return JSON.stringify(value);
	}

	function languageDefault(field: Field): string {
		if (field.kind === "primitive") {
			const name = (field as any).name;
			if (
				name === "u64" ||
				name === "i64" ||
				name === "u128" ||
				name === "i128" ||
				name === "bigint"
			)
				return "0n";
			if (name === "bool" || name === "boolean") return "false";
			if (name === "string") return '""';
			return "0";
		}
		if (field.kind === "string") return '""';
		if (field.kind === "array") return "[]";
		if (field.kind === "optional") return "undefined";
		if (field.kind === "map") return "{}";
		return "undefined as any";
	}

	function autoFieldExpr(
		change: FieldChange | undefined,
		toField: FieldPlan,
		fromVar: string,
	): string | null {
		// 1. Renamed: pull from old field name.
		if (change?.kind === "renamed") {
			if (change.status === "user-supplied") return null;
			return `${fromVar}.${fieldName(change.from.name)}`;
		}
		// 2. Type widened — same data, possible cast (TS: just pass through).
		if (change?.kind === "type-widened") {
			return `${fromVar}.${fieldName(change.from.name)}`;
		}
		// 3. Added with literal default (ArkType "T = value").
		if (change?.kind === "added" && change.default.kind === "literal") {
			return tsLiteral(change.default.value);
		}
		// 4. Added with language-default fallback.
		if (change?.kind === "added" && change.default.kind === "language-default") {
			return languageDefault(toField.type);
		}
		// 5. Added user-supplied / type-narrowed / type-changed → no auto.
		if (
			change?.kind === "added" ||
			change?.kind === "type-narrowed" ||
			change?.kind === "type-changed"
		) {
			return null;
		}
		// 6. Pass-through for unchanged fields (default case).
		if (toField.migrationMeta?.defaultValue !== undefined) {
			return tsLiteral(toField.migrationMeta.defaultValue);
		}
		return `${fromVar}.${fieldName(toField.name)}`;
	}

	function fieldRequiredReason(
		change: FieldChange | undefined,
		toField: FieldPlan,
	): string {
		if (!change) return `field '${toField.name}': user-supplied required`;
		switch (change.kind) {
			case "type-narrowed":
				return `field '${change.to.name}': narrowing — provide u.${fieldName(change.to.name)}`;
			case "type-changed":
				return `field '${change.to.name}': type changed — provide u.${fieldName(change.to.name)}`;
			case "added":
				return `field '${change.field.name}': new field with no auto default — provide u.${fieldName(change.field.name)}`;
			case "renamed":
				return `field '${change.to.name}': renamed AND type changed — provide u.${fieldName(change.to.name)}`;
			default:
				return `field '${toField.name}': user-supplied required`;
		}
	}

	function emitFieldExprWithUser(
		change: FieldChange | undefined,
		toField: FieldPlan,
		fromVar: string,
		moduleConfigured: boolean,
	): string {
		const auto = autoFieldExpr(change, toField, fromVar);
		const fName = fieldName(toField.name);
		if (!moduleConfigured) {
			// Without configured module: per-field expression is just auto. If
			// auto is impossible, emit a runtime throw so individual fields
			// fail loudly (function-level throw still applies via aggregate
			// status path — see renderMigrationFn).
			if (auto !== null) return auto;
			const reason = fieldRequiredReason(change, toField);
			return `(((): never => { throw new Error(${JSON.stringify(`schema-pop: ${reason}`)}); })())`;
		}
		// migrationsModule configured: prefer user mapper, fall back to auto
		// (or throw if no auto available).
		if (auto !== null) {
			return `u.${fName} ? u.${fName}(${fromVar}) : (${auto})`;
		}
		const reason = fieldRequiredReason(change, toField);
		return `u.${fName} ? u.${fName}(${fromVar}) : (((): never => { throw new Error(${JSON.stringify(`schema-pop: ${reason}`)}); })())`;
	}

	function renderStructMigrationBody(
		td: TypeDiff & { kind: "changed" | "renamed" },
		moduleConfigured: boolean,
	): string {
		const toType = td.to as StructPlan;
		const fieldChangeByToName = new Map<string, FieldChange>();
		for (const c of td.fieldChanges) {
			if (c.kind === "added") {
				fieldChangeByToName.set(c.field.name, c);
			} else if (c.kind === "renamed") {
				fieldChangeByToName.set(c.to.name, c);
			} else if (
				c.kind === "type-widened" ||
				c.kind === "type-narrowed" ||
				c.kind === "type-changed" ||
				c.kind === "reordered"
			) {
				fieldChangeByToName.set(c.to.name, c);
			}
		}
		let body = `${indent()}${indent()}return {\n`;
		for (const f of toType.fields) {
			if (f.type.kind === "unit") continue;
			const ch = fieldChangeByToName.get(f.name);
			const expr = emitFieldExprWithUser(ch, f, "v1", moduleConfigured);
			body += `${indent()}${indent()}${indent()}${fieldName(f.name)}: ${expr},\n`;
		}
		body += `${indent()}${indent()}};\n`;
		return body;
	}

	function renderMigrationFn(
		td: TypeDiff,
		fromNs: string,
		toNs: string,
		moduleConfigured: boolean,
	): string {
		if (
			td.kind !== "changed" &&
			td.kind !== "renamed"
		) {
			return "";
		}
		const fromType = (td as any).from;
		const toType = (td as any).to;
		const fnName = `migrate_${typeName(toType.name)}_${fromNs}_to_${toNs}`;
		const argType = `${fromNs}.${typeName(fromType.name)}`;
		const retType = `${toNs}.${typeName(toType.name)}`;
		let s = "";
		// status comment for clarity in generated output
		s += `${indent()}// status: ${td.status}\n`;
		if (td.kind === "renamed") {
			s += `${indent()}// renamed from "${td.oldName}"\n`;
		}
		s += `${indent()}export function ${fnName}(v1: ${argType}): ${retType} {\n`;

		// Without a configured user module, user-supplied required types throw
		// at function level (no way to plug in an impl).
		if (!moduleConfigured && td.status === "user-supplied") {
			const reason = td.fieldChanges
				.filter((c) => c.status === "user-supplied")
				.map((c) => {
					switch (c.kind) {
						case "type-narrowed":
							return `field '${c.to.name}': narrowing ${(c.from.type as any).name ?? c.from.type.kind} → ${(c.to.type as any).name ?? c.to.type.kind}`;
						case "type-changed":
							return `field '${c.to.name}': structural type change`;
						case "added":
							return `field '${c.field.name}': new field with no default`;
						case "renamed":
							return `field '${c.to.name}': renamed AND type changed`;
						default:
							return c.kind;
					}
				})
				.join("; ");
			s += `${indent()}${indent()}throw new Error(\n`;
			s += `${indent()}${indent()}${indent()}\`schema-pop: ${fnName} requires a user-supplied impl. Reason: ${reason || "see build summary"}. Configure migrationsModule in pop.config.ts and add a defineMigration entry.\`,\n`;
			s += `${indent()}${indent()});\n`;
			s += `${indent()}}\n`;
			return s;
		}

		if (moduleConfigured) {
			// Bind user mapper once at the top of the function body. Looked up
			// by the function's own name on the user module's namespace.
			s += `${indent()}${indent()}const u = ((__popUserMigrations as any).${fnName} ?? {}) as any;\n`;
		}

		if (toType.kind === "struct") {
			s += renderStructMigrationBody(td as any, moduleConfigured);
		} else if (toType.kind === "alias") {
			// Alias migration: identity passthrough (cast).
			s += `${indent()}${indent()}return v1 as unknown as ${retType};\n`;
		} else if (toType.kind === "enum") {
			// Per-variant Renamed → switch with explicit string mapping.
			const renamedVariants = (td as any).variantChanges?.filter?.(
				(c: any) => c.kind === "renamed",
			) ?? [];
			if (renamedVariants.length > 0) {
				s += `${indent()}${indent()}switch (v1) {\n`;
				for (const r of renamedVariants) {
					s += `${indent()}${indent()}${indent()}case ${JSON.stringify(r.from.name)}: return ${JSON.stringify(r.to.name)};\n`;
				}
				s += `${indent()}${indent()}${indent()}default: return v1 as unknown as ${retType};\n`;
				s += `${indent()}${indent()}}\n`;
			} else {
				s += `${indent()}${indent()}return v1 as unknown as ${retType};\n`;
			}
		} else if (toType.kind === "union") {
			// Discriminated unions key on tag value, not type-reference name —
			// per-variant rename is binary-stable, identity cast is correct.
			s += `${indent()}${indent()}return v1 as unknown as ${retType};\n`;
		}
		s += `${indent()}}\n`;
		return s;
	}

	// Closure-state: every (from, to) migration call accumulates a record so
	// getFileFooter can emit a single dispatcher covering all pairs.
	type DispatchEntry = {
		typeName: string; // v1 name (the dispatcher key)
		fromNs: string;
		toNs: string;
		fnName: string; // generated migration function name
		fromTypeRef: string; // fully-qualified v1 type — e.g., "v1.Battery"
		toTypeRef: string; // fully-qualified v2 type — e.g., "v2.Battery"
		alsoUnderName?: string; // for renamed types: also dispatch under v2 name
	};
	const dispatchEntries: DispatchEntry[] = [];

	const moduleConfigured = !!cfg.migrationsModule;

	return {
		name: "ts",
		extension: "ts",
		config: cfg,
		getFileHeader: () => {
			let h = "";
			if (cfg.withCodec) h += `import { PopCodec } from "schema-pop";\n`;
			if (moduleConfigured) {
				h += `import * as __popUserMigrations from ${JSON.stringify(cfg.migrationsModule!)};\n`;
			}
			return h;
		},
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) code += renderType(t) + "\n";
			if (cfg.exportJsonPlan || cfg.withCodec) {
				code += `export const LAYOUT_PLAN = ${JSON.stringify(plan, null, "\t")} as const;\n\n`;
			}
			if (cfg.withCodec) code += renderCodec(plan);
			return code;
		},
		wrapVersion: (version, code) => {
			if (cfg.versionNamespace === false) return code;
			return wrapNamespace(version, code, {
				open: (mod) => `export namespace ${mod} {`,
				close: "}",
			});
		},
		generateMigration: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => {
			const diff = diffPlans(fromPlan, toPlan);
			// Match the identifier produced by `wrapVersion`'s namespace —
			// raw versions like `1.0` / `test-schema_2.0` are not valid TS
			// identifiers and break `migrations_X_to_Y` namespaces.
			const fromNs = toSafeVersionIdentifier(fromPlan.version);
			const toNs = toSafeVersionIdentifier(toPlan.version);
			const fns: string[] = [];
			for (const td of diff.types) {
				const code = renderMigrationFn(td, fromNs, toNs, moduleConfigured);
				if (!code) continue;
				fns.push(code);
				const fromType = (td as any).from;
				const toType = (td as any).to;
				const tn = typeName(toType.name);
				const fnName = `migrate_${tn}_${fromNs}_to_${toNs}`;
				dispatchEntries.push({
					typeName:
						td.kind === "renamed" ? td.oldName : toType.name,
					fromNs,
					toNs,
					fnName,
					fromTypeRef: `${fromNs}.${typeName(fromType.name)}`,
					toTypeRef: `${toNs}.${tn}`,
					alsoUnderName:
						td.kind === "renamed" && toType.name !== td.oldName
							? toType.name
							: undefined,
				});
			}
			if (fns.length === 0) return "";
			let out = `\nexport namespace migrations_${fromNs}_to_${toNs} {\n`;
			for (const f of fns) out += f;
			out += `}\n`;
			return out;
		},
		getIndex: cfg.withIndex
			? (files) => {
					const lines = files
						.map((f) => f.dest.replace(/\.[^./]+$/, ""))
						.map((base) => {
							const seg = base.includes("/")
								? base.slice(base.lastIndexOf("/") + 1)
								: base;
							return `export * from "./${seg}";`;
						});
					return { "index.ts": lines.join("\n") + "\n" };
				}
			: undefined,
		getFileFooter: () => {
			if (dispatchEntries.length === 0) return "";
			let s = "\n";
			s += `// schema-pop: type-narrowed dispatcher across every (typeName, from, to) pair.\n`;
			// Overload signatures for type narrowing.
			for (const e of dispatchEntries) {
				s += `export function migrate(typeName: ${JSON.stringify(e.typeName)}, from: ${JSON.stringify(e.fromNs)}, to: ${JSON.stringify(e.toNs)}, value: ${e.fromTypeRef}): ${e.toTypeRef};\n`;
				if (e.alsoUnderName) {
					s += `export function migrate(typeName: ${JSON.stringify(e.alsoUnderName)}, from: ${JSON.stringify(e.fromNs)}, to: ${JSON.stringify(e.toNs)}, value: ${e.fromTypeRef}): ${e.toTypeRef};\n`;
				}
			}
			// Implementation signature.
			s += `export function migrate(typeName: string, from: string, to: string, value: unknown): unknown {\n`;
			for (const e of dispatchEntries) {
				const cond = `from === ${JSON.stringify(e.fromNs)} && to === ${JSON.stringify(e.toNs)}`;
				const matchTypes = e.alsoUnderName
					? `(typeName === ${JSON.stringify(e.typeName)} || typeName === ${JSON.stringify(e.alsoUnderName)})`
					: `typeName === ${JSON.stringify(e.typeName)}`;
				s += `${indent()}if (${matchTypes} && ${cond}) return migrations_${e.fromNs}_to_${e.toNs}.${e.fnName}(value as ${e.fromTypeRef});\n`;
			}
			s += `${indent()}throw new Error(\`schema-pop: no migration registered for \${typeName} \${from} → \${to}\`);\n`;
			s += `}\n`;
			return s;
		},
	};
}
