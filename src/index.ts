/**
 * sqlite-zod-orm — Type-safe SQLite ORM for Bun with Zod schemas.
 *
 * @module sqlite-zod-orm
 */
export { Database } from './database';
export type { DatabaseType } from './database';

export type {
    SchemaMap, DatabaseOptions, Relationship,
    EntityAccessor, TypedAccessors, AugmentedEntity, UpdateBuilder,
    InferSchema, EntityData, IndexDef,
    ProxyColumns, ColumnRef,
} from './types';

export { z } from 'zod';

export { QueryBuilder } from './query-builder';
export { ColumnNode, type ProxyQueryResult } from './proxy-query';
export {
    type ASTNode, type WhereCallback, type SetCallback,
    type TypedColumnProxy, type FunctionProxy, type Operators,
    compileAST, wrapNode, createColumnProxy, createFunctionProxy, op,
} from './ast';
