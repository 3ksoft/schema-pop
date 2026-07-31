import type { Scope, Module } from "arktype";
import type { ExtractionContext, PopSchema, PopModule } from "@schema-pop/schema";

export type AnalyzableSchema =
    | Scope
    | Module
    | PopModule
    | PopSchema
    | ExtractionContext
    | { export(): PopModule }
    | Record<string, any>;