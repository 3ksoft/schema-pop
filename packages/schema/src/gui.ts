import { scope } from "arktype";

export const gui = scope({
  GuiMeta: {
    "ui?": "Ui",
    "table?": "Table",
    "filter?": "Filter",
  },

  Ui: {
    "hidden?": "boolean",
    "readonly?": "boolean",
    "disabled?": "boolean",

    "min?": "number",
    "max?": "number",
    "step?": "number",
    "category?": "string",

    "editor?": "string",

    "placeholder?": "string",
    "help?": "string",

    "group?": "string",
    "order?": "number",
    "width?": "number",
    "colSpan?": "number",

    "control?": "string",
    // Options for the chosen control (shape defined by the control's own
    // optionsSchema at the UI layer — loose here on purpose).
    "props?": { "[string]": "unknown.any" },
  },

  Table: {
    "visible?": "boolean",
    "label?": "string",

    "sortable?": "boolean",
    "searchable?": "boolean",

    "width?": "number",
    "minWidth?": "number",
    "maxWidth?": "number",

    "align?": "'start' | 'center' | 'end'",
    "format?": "string",

    "priority?": "number",
    "mobile?": "'show' | 'hide' | 'summary'",
  },

  Filter: {
    "enabled?": "boolean",
    "type?":
      "'text' | 'select' | 'multiSelect' | 'boolean' | 'range' | 'date' | 'dateRange' | 'exists'",
    "label?": "string",

    "facet?": "boolean",
    "searchable?": "boolean",
    "multiple?": "boolean",

    "operator?":
      "'equals' | 'contains' | 'startsWith' | 'in' | 'between' | 'gte' | 'lte'",
  },
});

const _gui = gui.export();
export const GuiMeta = _gui.GuiMeta;

// ─── GUI overlay: sidecar presentation meta for a compiled scope ──────────────
// Keeps type-definition strings free of GUI concerns: structural schemas stay
// as they are, and presentation (labels, grouping, control choice) lives in a
// plain object next to them, keyed by "TypeName.field[.sub]" paths. Paths are
// typed against the module (autocomplete + typo errors), values use the
// Ui/Table/Filter vocabulary above.



// export type GuiMeta = typeof _gui.BaseGuiMeta.infer & {
//   label?: string;
//   description?: string;
//   min?: number;
//   max?: number;
//   step?: number;
//   category?: string;
// };

// type InferOf<T> = T extends { infer: infer t } ? t : never;
// export type GuiPaths<M> = {
//   [K in Extract<keyof M, string>]: InferOf<M[K]> extends object
//   ?
//   | K
//   | `${K}.${Extract<keyof InferOf<M[K]>, string>}`
//   | `${K}.${Extract<keyof InferOf<M[K]>, string>}.${string}`
//   : K;
// }[Extract<keyof M, string>];

// export type GuiOverlay<M> = Partial<Record<GuiPaths<M>, GuiMeta>>;

// /** Identity with typed keys: `defineGui($.export(), {...})`. */
// export const defineGui = <M>(_module: M, overlay: GuiOverlay<M>): GuiOverlay<M> =>
//   overlay;

// /**
//  * Merge an overlay into a record of Field-tree roots (nodes with optional
//  * `fields` children / `item` array element — the shape pira's `fromArktype`
//  * produces). Mutates `roots` in place and returns it. Scalar meta lands as
//  * node props; ui/table/filter merge shallowly (overlay wins per key). Paths
//  * with no matching node are ignored (schema drift must not crash an editor).
//  */
// export function mergeGuiOverlay<T extends Record<string, any>>(
//   roots: T,
//   overlay: Record<string, GuiMeta | undefined>,
// ): T {
//   for (const [path, meta] of Object.entries(overlay)) {
//     if (!meta) continue;
//     const segs = path.split(".");
//     let node: any = roots[segs[0]];
//     for (let i = 1; node && i < segs.length; i++) {
//       node = node.fields?.[segs[i]] ?? (segs[i] === "item" ? node.item : undefined);
//     }
//     if (!node) continue;
//     const { ui, table, filter, ...plain } = meta;
//     Object.assign(node, plain);
//     if (ui) node.ui = { ...node.ui, ...ui };
//     if (table) node.table = { ...node.table, ...table };
//     if (filter) node.filter = { ...node.filter, ...filter };
//   }
//   return roots;
// }