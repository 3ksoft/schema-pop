import { scope } from "arktype";
import type { LayoutPlan } from "./layout";

export const $exporter = scope({
    NamingStrategy: "'snake_case' | 'camelCase' | 'PascalCase' | 'original'",
    CommentStyle: "'slash' | 'star' | 'xml' | 'hash' | 'none'",
    ExportStrategy: "'standalone' | 'inline' | 'barrel'",

    BaseConfig: {
        "dest?": "string",
        "fieldNaming?": "NamingStrategy",
        "typeNaming?": "NamingStrategy",
        "commentStyle?": "CommentStyle",
        "exportStrategy?": "ExportStrategy",
        "prependToFile?": "string",
        "appendToFile?": "string",
        "noHeader?": "boolean",
        "noWrap?": "boolean",
    }
});

export const { NamingStrategy, CommentStyle, ExportStrategy, BaseConfig } = $exporter.export();

export type NamingStrategy = typeof NamingStrategy.infer;
export type CommentStyle = typeof CommentStyle.infer;
export type ExportStrategy = typeof ExportStrategy.infer;
export type BaseConfig = typeof BaseConfig.infer;

export interface ExporterPlugin<TConfig extends BaseConfig = BaseConfig> {
    name: string;
    config: TConfig;
    generate: (plan: LayoutPlan) => string | Record<string, string>;
    wrapVersion?: (version: string, code: string) => string;
    getFileHeader?: () => string;
    getFileFooter?: () => string;
    generateMigration?: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => string;
    getHarness?: (plans: LayoutPlan[]) => Record<string, string>;
}