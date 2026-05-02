# schema-pop-import

Top-level alias for [`@schema-pop/importer`](https://www.npmjs.com/package/@schema-pop/importer)'s CLI so `bunx schema-pop-import` resolves on npm without the scope. All logic lives in `@schema-pop/importer` — this package is a single-line shim.

## Install + run

```sh
# zero-install (one-shot)
bunx schema-pop-import esp_now.h -o gen/esp.ts

# glob → directory
bunx schema-pop-import 'src/**/*.{h,hpp}' -l c++ -e clang -o gen/

# install in a project
bun add -D schema-pop-import
```

See the [`@schema-pop/importer` README](https://www.npmjs.com/package/@schema-pop/importer) for the full flag reference (`-l/--lang`, `-e/--engine`, `-t/--type`, `-x/--extras`, `--clang`, …).
