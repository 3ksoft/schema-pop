import type { LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export function zigHarness(
	plans: LayoutPlan[],
	typeNaming: "PascalCase" = "PascalCase",
): Record<string, string> {
	const { typeName, toSafeVersionIdentifier } = ExporterTools({ typeNaming });

	const layoutLines: string[] = [];
	const matchArms: string[] = [];

	for (const plan of plans) {
		const ver = toSafeVersionIdentifier(plan.version);
		for (const t of plan.types) {
			const tn = typeName(t.name);
			layoutLines.push(
				`\ttry stdout.print("${ver},${tn},{d},{d}\\n", .{ @sizeOf(schema.${ver}.${tn}), @alignOf(schema.${ver}.${tn}) });`,
			);
			matchArms.push(
				`\tif (std.mem.eql(u8, version, "${ver}") and std.mem.eql(u8, ty, "${tn}")) return rt(schema.${ver}.${tn}, buf, stdout);`,
			);
		}
	}

	const mainZig = `const std = @import("std");
const schema = @import("schema.zig");

fn rt(comptime T: type, buf: []const u8, writer: anytype) !void {
\tconst size = @sizeOf(T);
\tif (size == 0 or buf.len % size != 0) {
\t\tstd.debug.print("invalid buffer length: {d} not divisible by {d}\\n", .{ buf.len, size });
\t\tstd.process.exit(1);
\t}
\tconst count = buf.len / size;
\tvar i: usize = 0;
\twhile (i < count) : (i += 1) {
\t\tvar s: T = undefined;
\t\t@memcpy(std.mem.asBytes(&s), buf[i * size .. (i + 1) * size]);
\t\ttry writer.writeAll(std.mem.asBytes(&s));
\t}
}

fn layout(stdout: anytype) !void {
${layoutLines.join("\n")}
}

fn roundtrip(version: []const u8, ty: []const u8, allocator: std.mem.Allocator, stdout: anytype) !void {
\tconst buf = try std.io.getStdIn().readToEndAlloc(allocator, 16 * 1024 * 1024);
\tdefer allocator.free(buf);
${matchArms.join("\n")}
\tstd.debug.print("unknown type: {s}/{s}\\n", .{ version, ty });
\tstd.process.exit(1);
}

pub fn main() !void {
\tvar gpa = std.heap.GeneralPurposeAllocator(.{}){};
\tdefer _ = gpa.deinit();
\tconst allocator = gpa.allocator();

\tconst args = try std.process.argsAlloc(allocator);
\tdefer std.process.argsFree(allocator, args);

\tvar buffered = std.io.bufferedWriter(std.io.getStdOut().writer());
\tconst stdout = buffered.writer();

\tconst cmd = if (args.len > 1) args[1] else "layout";

\tif (std.mem.eql(u8, cmd, "layout")) {
\t\ttry layout(stdout);
\t} else if (std.mem.eql(u8, cmd, "roundtrip")) {
\t\tif (args.len < 4) {
\t\t\tstd.debug.print("roundtrip needs <version> <type>\\n", .{});
\t\t\tstd.process.exit(1);
\t\t}
\t\ttry roundtrip(args[2], args[3], allocator, stdout);
\t} else {
\t\tstd.debug.print("unknown command: {s}\\n", .{cmd});
\t\tstd.process.exit(1);
\t}

\ttry buffered.flush();
}
`;

	const packageJson = `{
	"name": "schema-harness-zig",
	"private": true,
	"scripts": {
		"build": "zig build-exe src/main.zig -O ReleaseSafe --name harness && rm -f harness.o",
		"clean": "rm -f harness harness.o"
	}
}
`;

	return {
		"main.zig": mainZig,
		"../package.json": packageJson,
	};
}
