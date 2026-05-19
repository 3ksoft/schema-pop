import type { LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

/**
 * Build the Go test harness — a small CLI binary that exposes the
 * generated types via the same `layout` / `roundtrip` interface the
 * rust / cpp / zig harnesses use, so the cross-language ABI suite can
 * compare outputs across all four.
 *
 * Files (assuming the schema lands at `<root>/schema/<name>.go`):
 *   ../cmd/harness/main.go — `package main` binary, separate dir so it
 *                            doesn't collide with the schema's package
 *   ../go.mod              — module + Go version pin (one level above
 *                            both schema/ and cmd/, so `harness/schema`
 *                            resolves to the generated package)
 *   ../package.json        — `build` / `clean` scripts the suite runner calls
 *
 * `versionPrefixed` mirrors the exporter's `versionNamespace` flag:
 * when true, types in the schema file are emitted as `V1Reading` etc.,
 * so the harness must reach for those names.
 */
export function goHarness(
	plans: LayoutPlan[],
	pkg: string,
	versionPrefixed: boolean,
): Record<string, string> {
	const { typeName, toSafeVersionIdentifier } = ExporterTools({
		typeNaming: "PascalCase",
	});

	function versionTag(plan: LayoutPlan): string {
		const safe = toSafeVersionIdentifier(plan.version);
		const m = safe.match(/(\d+(_\d+)*)$/);
		return `V${m ? m[1] : safe}`;
	}

	const layoutLines: string[] = [];
	const matchArms: string[] = [];

	for (const plan of plans) {
		const ver = toSafeVersionIdentifier(plan.version);
		const prefix = versionPrefixed ? versionTag(plan) : "";
		for (const t of plan.types) {
			if (t.kind !== "struct" && t.kind !== "union") continue;
			// Skip rich-tier — same filter the exporter applies, otherwise the
			// referenced symbol won't exist in the schema package.
			if ((t as any).size === 0 && (t as any).paddedSize === 0) continue;
			const tn = `${prefix}${typeName(t.name)}`;
			layoutLines.push(
				`\tfmt.Fprintf(out, "${ver},${tn},%d,%d\\n", unsafe.Sizeof(schema.${tn}{}), unsafe.Alignof(schema.${tn}{}))`,
			);
			matchArms.push(
				`\tcase version == "${ver}" && ty == "${tn}":\n\t\treturn rt[schema.${tn}](buf, out)`,
			);
		}
	}

	const mainGo = `package main

import (
\t"bufio"
\t"fmt"
\t"io"
\t"os"
\t"unsafe"

\tschema "harness/schema"
)

// rt is the cross-language roundtrip primitive: read N copies of T off
// the buffer, write the same bytes back. Any drift between
// unsafe.Sizeof(T) and the wire layout shows up as a length mismatch.
func rt[T any](buf []byte, out io.Writer) error {
\tvar zero T
\tsize := int(unsafe.Sizeof(zero))
\tif size == 0 || len(buf)%size != 0 {
\t\tfmt.Fprintf(os.Stderr, "invalid buffer length: %d not divisible by %d\\n", len(buf), size)
\t\tos.Exit(1)
\t}
\tcount := len(buf) / size
\tfor i := 0; i < count; i++ {
\t\tchunk := buf[i*size : (i+1)*size]
\t\tvar s T
\t\tdst := unsafe.Slice((*byte)(unsafe.Pointer(&s)), size)
\t\tcopy(dst, chunk)
\t\tif _, err := out.Write(dst); err != nil {
\t\t\treturn err
\t\t}
\t}
\treturn nil
}

func layout(out io.Writer) {
${layoutLines.join("\n")}
}

func roundtrip(version, ty string, out io.Writer) error {
\tbuf, err := io.ReadAll(os.Stdin)
\tif err != nil {
\t\treturn err
\t}
\tswitch {
${matchArms.join("\n")}
\t}
\tfmt.Fprintf(os.Stderr, "unknown type: %s/%s\\n", version, ty)
\tos.Exit(1)
\treturn nil
}

func main() {
\tcmd := "layout"
\tif len(os.Args) > 1 {
\t\tcmd = os.Args[1]
\t}
\tw := bufio.NewWriter(os.Stdout)
\tdefer w.Flush()

\tswitch cmd {
\tcase "layout":
\t\tlayout(w)
\tcase "roundtrip":
\t\tif len(os.Args) < 4 {
\t\t\tfmt.Fprintln(os.Stderr, "roundtrip needs <version> <type>")
\t\t\tos.Exit(1)
\t\t}
\t\tif err := roundtrip(os.Args[2], os.Args[3], w); err != nil {
\t\t\tfmt.Fprintln(os.Stderr, err)
\t\t\tos.Exit(1)
\t\t}
\tdefault:
\t\tfmt.Fprintf(os.Stderr, "unknown command: %s\\n", cmd)
\t\tos.Exit(1)
\t}
}
`;

	// `go.mod` lives one level above so `harness/schema` resolves to the
	// generated `*.go` file in the schema directory. The schema file ships
	// as its own package, kept at `./schema/<schemaName>.go`.
	const goMod = `module harness

go 1.22
`;

	const packageJson = `{
\t"name": "schema-harness-go",
\t"private": true,
\t"scripts": {
\t\t"build": "go build -o harness ./cmd/harness",
\t\t"clean": "rm -f harness"
\t}
}
`;

	// `pkg` is informational only — the import path is fixed at
	// `harness/schema` because that's the layout `go.mod` declares.
	void pkg;

	return {
		"../cmd/harness/main.go": mainGo,
		"../go.mod": goMod,
		"../package.json": packageJson,
	};
}
