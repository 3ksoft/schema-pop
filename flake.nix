{
  description = "schema-pop — dev shell with the cross-language toolchains the ABI e2e needs";

  inputs.nixpkgs.url = "nixpkgs";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Everything `packages/create/scaffold/.../build.ts` shells out to
          # while compiling the generated harnesses (rust / cpp / zig / bf),
          # plus the JS runtime. `gcc` provides both `gcc` and `g++`.
          packages = with pkgs; [
            bun
            nodejs
            cargo
            rustc
            gcc
            # zigHarness emits pre-0.15 std APIs (GeneralPurposeAllocator,
            # std.io writers); pin a matching zig so the ABI harness compiles
            # reproducibly instead of chasing zig-nightly std churn.
            zig_0_14
          ];
        };
      });
    };
}
