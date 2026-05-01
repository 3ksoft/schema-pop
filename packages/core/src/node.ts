/// <reference types="node" />

// Node-only entry. Re-exports everything from the browser-safe `./index`
// plus build-side APIs that need jiti / node:fs (`buildConfig`,
// `buildSchema`, `runBindings`, `bindFile`).
export * from "./index";
export * from "./builder";
export { bindFile, runBindings, isArktypeScope } from "./bind";
