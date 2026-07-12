import { scope } from "arktype";

export const gui = scope({
  BaseGuiMeta: {
    "ui?": "Ui",
    "table?": "Table",
    "filter?": "Filter",
  },

  Ui: {
    "hidden?": "boolean",
    "readonly?": "boolean",
    "disabled?": "boolean",

    "placeholder?": "string",
    "help?": "string",

    "group?": "string",
    "order?": "number",
    "width?": "number",
    "colSpan?": "number",

    "control?": "string",
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