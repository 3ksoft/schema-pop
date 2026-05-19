import type { LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export function cppHarness(
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
				`\tstd::cout << "${ver},${tn}," << sizeof(${ver}::${tn}) << "," << alignof(${ver}::${tn}) << "\\n";`,
			);
			matchArms.push(
				`\tif (version == "${ver}" && ty == "${tn}") return rt<${ver}::${tn}>(buf);`,
			);
		}
	}

	const mainCpp = `#include <iostream>
#include <vector>
#include <string>
#include <cstring>
#include <cstdint>
#include "schema.hpp"

template <typename T>
int rt(const std::vector<uint8_t>& buf) {
\tsize_t size = sizeof(T);
\tif (size == 0 || buf.size() % size != 0) {
\t\tstd::cerr << "invalid buffer length: " << buf.size() << " not divisible by " << size << "\\n";
\t\treturn 1;
\t}
\tsize_t count = buf.size() / size;
\tstd::vector<uint8_t> out(buf.size());
\tfor (size_t i = 0; i < count; i++) {
\t\tT s{};
\t\tstd::memcpy(&s, buf.data() + i * size, size);
\t\tstd::memcpy(out.data() + i * size, &s, size);
\t}
\tstd::cout.write(reinterpret_cast<const char*>(out.data()), out.size());
\treturn 0;
}

int layout() {
${layoutLines.join("\n")}
\treturn 0;
}

int roundtrip(const std::string& version, const std::string& ty) {
\tstd::vector<uint8_t> buf((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
${matchArms.join("\n")}
\tstd::cerr << "unknown type: " << version << "/" << ty << "\\n";
\treturn 1;
}

int main(int argc, char** argv) {
\tstd::ios_base::sync_with_stdio(false);
\tstd::string cmd = argc > 1 ? argv[1] : "layout";
\tif (cmd == "layout") return layout();
\tif (cmd == "roundtrip") {
\t\tif (argc < 4) { std::cerr << "roundtrip needs <version> <type>\\n"; return 1; }
\t\treturn roundtrip(argv[2], argv[3]);
\t}
\tstd::cerr << "unknown command: " << cmd << "\\n";
\treturn 1;
}
`;

	const packageJson = `{
	"name": "schema-harness-cpp",
	"private": true,
	"scripts": {
		"build": "g++ -std=c++17 -O1 -o harness src/main.cpp",
		"clean": "rm -f harness"
	}
}
`;

	return {
		"main.cpp": mainCpp,
		"../package.json": packageJson,
	};
}
