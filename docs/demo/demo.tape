# schema-pop demo — scaffold from scratch, write a tiny schema, generate
# Rust + TS + Zig output.
#
# Render with:  vhs docs/demo/demo.tape

Output docs/demo/schema-pop-demo.gif

Set FontSize 14
Set Width 800
Set Height 600
Set Theme "Catppuccin Mocha"
Set Padding 18
Set TypingSpeed 25ms
Set PlaybackSpeed 1.0

# Land in /tmp and clean any previous demo.
Hide
Type "cd /tmp && rm -rf spop-demo && clear"
Enter
Show

# 1. Scaffold a fresh monorepo. No `--schemas` flag → schema-pop drops a
#    minimal `default.ts` for us instead of bundled fixtures.
Type "bun create schema-pop --name spop-demo --type monorepo --harnesses ts,rust,zig"
Enter
Sleep 2s
Type "cd spop-demo && bun install"
Enter
Sleep 2s

Type "clear"
Enter

# 3. Replace it with our own: two fields, u8 + bool.
Type "cat > packages/schema/src/schema/default.ts <<'EOF'"
Enter
Type '/** Demo schema **/'
Enter
Type 'import { schemaPop, scope } from "schema-pop";'
Enter
Enter
Type "export const $ = scope({"
Enter
Type "    ...schemaPop,"
Enter
Type "    Light: {"
Enter
Type '        brightness: "u8",'
Enter
Type '        on: "bool",'
Enter
Type "    },"
Enter
Type "});"
Enter
Type "EOF"
Enter
Sleep 1s
Type "clear"
Enter

Type "bat -r :25 packages/schema/src/schema/default.ts"
Enter
Sleep 3s

# 4. Codegen.
Type "clear"
Enter
Type "bun run generate"
Enter
Sleep 6s

# 5. Three languages, byte-identical layout.


Type "clear"
Enter
Type "bat -r :25 packages/ts/src/schema.ts"
Enter
Sleep 4s

Type "clear"
Enter
Type "bat -r :25 packages/rust/src/schema.rs"
Enter
Sleep 4s


Type "clear"
Enter
Type "bat -r :25 packages/zig/src/schema.zig"
Enter
Sleep 4s
