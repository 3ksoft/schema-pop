import type { CommentStyle } from "../schema";

export interface CommentOptions {
    isDoc?: boolean;
    indent?: string;
}

/**
 * Renders a string as a comment block based on the language style.
 * Handles multi-line strings automatically.
 */
export function renderComment(style: CommentStyle, text: string, opts: CommentOptions = {}): string {
    if (style === "none" || !text.trim()) return "";

    const lines = text.trim().split("\n");
    const indent = opts.indent || "";

    switch (style) {
        case "slash": {
            const prefix = opts.isDoc ? "/// " : "// ";
            return lines.map(l => `${indent}${prefix}${l}`).join("\n");
        }
        case "star": {
            if (lines.length === 1 && !opts.isDoc) {
                return `${indent}/* ${lines[0]} */`;
            }
            const start = opts.isDoc ? "/**" : "/*";
            const body = lines.map(l => `${indent} * ${l}`).join("\n");
            return `${indent}${start}\n${body}\n${indent} */`;
        }
        case "hash": {
            return lines.map(l => `${indent}# ${l}`).join("\n");
        }
        case "xml": {
            if (lines.length === 1) return `${indent}<!-- ${lines[0]} -->`;
            return `${indent}<!--\n${lines.map(l => `${indent}  ${l}`).join("\n")}\n${indent}-->`;
        }
        default:
            return "";
    }
}
