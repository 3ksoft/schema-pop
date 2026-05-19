import type { LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export function rustHarness(
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
				`\twriteln!(out, "${ver},${tn},{},{}", std::mem::size_of::<schema::${ver}::${tn}>(), std::mem::align_of::<schema::${ver}::${tn}>())?;`,
			);
			matchArms.push(
				`\t\t("${ver}", "${tn}") => rt::<schema::${ver}::${tn}>(&buf, &mut out),`,
			);
		}
	}

	const cargoToml = `[package]
name = "schema-harness"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "harness"
path = "src/main.rs"

[profile.release]
opt-level = 1
`;

	const mainRs = `mod schema;

use std::io::{self, Read, Write};
use std::env;

fn main() -> io::Result<()> {
	let args: Vec<String> = env::args().collect();
	let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("layout");
	match cmd {
		"layout" => layout(),
		"roundtrip" => {
			let version = args.get(2).expect("version required");
			let ty = args.get(3).expect("type required");
			roundtrip(version, ty)
		}
		_ => {
			eprintln!("unknown command: {}", cmd);
			std::process::exit(1);
		}
	}
}

fn layout() -> io::Result<()> {
	let stdout = io::stdout();
	let mut out = stdout.lock();
${layoutLines.join("\n")}
	Ok(())
}

fn roundtrip(version: &str, ty: &str) -> io::Result<()> {
	let mut buf = Vec::new();
	io::stdin().read_to_end(&mut buf)?;
	let stdout = io::stdout();
	let mut out = stdout.lock();
	match (version, ty) {
${matchArms.join("\n")}
		_ => {
			eprintln!("unknown type: {}/{}", version, ty);
			std::process::exit(1);
		}
	}
}

fn rt<T: Copy>(buf: &[u8], out: &mut impl Write) -> io::Result<()> {
	let size = std::mem::size_of::<T>();
	if size == 0 || buf.len() % size != 0 {
		eprintln!("invalid buffer length: {} not divisible by {}", buf.len(), size);
		std::process::exit(1);
	}
	let count = buf.len() / size;
	for i in 0..count {
		let chunk = &buf[i * size..(i + 1) * size];
		let mut s: T = unsafe { std::mem::zeroed() };
		unsafe {
			std::ptr::copy_nonoverlapping(chunk.as_ptr(), &mut s as *mut T as *mut u8, size);
		}
		let out_bytes: &[u8] =
			unsafe { std::slice::from_raw_parts(&s as *const T as *const u8, size) };
		out.write_all(out_bytes)?;
	}
	Ok(())
}
`;

	const packageJson = `{
	"name": "schema-harness-rust",
	"private": true,
	"scripts": {
		"build": "cargo build --release && cp target/release/harness ./harness",
		"clean": "cargo clean && rm -f harness"
	}
}
`;

	return {
		"../Cargo.toml": cargoToml,
		"main.rs": mainRs,
		"../package.json": packageJson,
	};
}
