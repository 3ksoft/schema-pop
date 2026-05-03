import type { Tree } from "web-tree-sitter";
import { walkCLike, type WalkCOptions } from "./walk-c";
import type { SchemaPopIR } from "./ir";

/**
 * tree-sitter-cpp walker. Reuses the C walker with `allowClass: true` so
 * `class_specifier`, `namespace_definition`, and `alias_declaration` are
 * recognized.
 *
 * Templates are silently skipped — schema-pop's binary domain is
 * monomorphic, and a template type has no fixed layout.
 *
 * Only `public:` members are extracted from classes / structs (C++
 * `struct` defaults to public, `class` defaults to private — the walker
 * stops at the first `private:` or `protected:` access label).
 */
export function walkCppFile(
	tree: Tree,
	sourcePath: string,
	opts: WalkCOptions = {},
): SchemaPopIR {
	return walkCLike(tree, sourcePath, { allowClass: true, ...opts });
}
