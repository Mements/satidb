/**
 * sqlite-zod-orm — Type-safe SQLite ORM for Bun with Zod schemas.
 *
 * @module sqlite-zod-orm
 */
export { Database } from "./database";
export type { DatabaseType } from "./database";

export type {
  SchemaMap,
  DatabaseOptions,
  Relationship,
  EntityAccessor,
  TypedAccessors,
  AugmentedEntity,
  UpdateBuilder,
  DeleteBuilder,
  InferSchema,
  EntityData,
  IndexDef,
  ChangeEvent,
  ProxyColumns,
  ColumnRef,
  ViewDefinition,
  ViewDefinitions,
  ReadonlyEntity,
  ReadonlyEntityAccessor,
  TypedReadonlyAccessors,
  ConflictMergeHelpers,
  ConflictExpression,
  ConflictColumn,
} from "./types";
export { defineView } from "./types";

export { z } from "zod";

export {
  QueryBuilder,
  ColumnNode,
  compileIQO,
  type ProxyQueryResult,
  type QueryCacheOptions,
} from "./query";
export {
  type ASTNode,
  type WhereCallback,
  type SetCallback,
  type TypedColumnProxy,
  type FunctionProxy,
  type Operators,
  compileAST,
  wrapNode,
  createColumnProxy,
  createFunctionProxy,
  op,
} from "./ast";
export { ConflictMergeHelpers as ConflictMergeHelperRuntime } from "./conflict";

export { createMigrator, DatabaseMigrator } from "./migrator";
export type {
  MigrationBackup,
  MigrationColumnInfo,
  MigrationColumnMapping,
  MigrationConflictStrategy,
  MigrationPlan,
  MigrationPlanPreview,
  MigrationApplyResult,
} from "./migrator";
export { runCli } from "./cli";
