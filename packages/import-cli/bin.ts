#!/usr/bin/env bun
// Thin alias so `bunx schema-pop-import` resolves on npm without the
// `@schema-pop/...` scope. The real CLI lives in `@schema-pop/importer`;
// this file just imports it so its top-level `main()` runs.
import "@schema-pop/importer/cli";
