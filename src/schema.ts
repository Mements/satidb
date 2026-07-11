/**
 * schema.ts — Schema parsing, relationship detection, and DDL helpers
 */
import { z } from "zod";
import type { SchemaMap, ZodType, Relationship } from "./types";
import { asZodObject } from "./types";

/**
 * Parse declarative `relations` config into Relationship[] objects.
 *
 * Config format: `{ childTable: { fkColumn: 'parentTable' } }`
 * Example: `{ books: { author_id: 'authors' } }` produces:
 *   - books → authors  (belongs-to, FK = author_id, nav = author)
 *   - authors → books  (one-to-many, nav = books)
 */
export function parseRelationsConfig(
  relations: Record<string, Record<string, string>>,
  schemas: SchemaMap,
): Relationship[] {
  const relationships: Relationship[] = [];
  const added = new Set<string>();

  for (const [fromTable, rels] of Object.entries(relations)) {
    if (!schemas[fromTable]) {
      throw new Error(`relations: unknown table '${fromTable}'`);
    }
    for (const [fkColumn, toTable] of Object.entries(rels)) {
      if (!schemas[toTable]) {
        throw new Error(
          `relations: unknown target table '${toTable}' in ${fromTable}.${fkColumn}`,
        );
      }

      // Derive navigation name: author_id → author
      const navField = fkColumn.replace(/_id$/, "");

      // belongs-to: books.author_id → authors
      const btKey = `${fromTable}.${fkColumn}:belongs-to`;
      if (!added.has(btKey)) {
        relationships.push({
          type: "belongs-to",
          from: fromTable,
          to: toTable,
          relationshipField: navField,
          foreignKey: fkColumn,
        });
        added.add(btKey);
      }

      // auto-infer one-to-many inverse: authors.books → books[]
      const otmKey = `${toTable}.${fromTable}:one-to-many`;
      if (!added.has(otmKey)) {
        relationships.push({
          type: "one-to-many",
          from: toTable,
          to: fromTable,
          relationshipField: fromTable, // e.g. 'books'
          foreignKey: "",
        });
        added.add(otmKey);
      }
    }
  }

  return relationships;
}

/** Get storable (non-id) fields from a schema */
export function getStorableFields(
  schema: z.ZodType<any>,
): { name: string; type: ZodType }[] {
  return Object.entries(asZodObject(schema).shape)
    .filter(([key]) => key !== "id")
    .map(([name, type]) => ({ name, type: type as ZodType }));
}

/** Map a Zod type to its SQLite column type */
export function zodTypeToSqlType(zodType: ZodType): string {
  if (zodType instanceof z.ZodOptional) {
    zodType = zodType._def.innerType;
  }
  if (zodType instanceof z.ZodDefault) {
    zodType = zodType._def.innerType;
  }
  if (zodType instanceof z.ZodString || zodType instanceof z.ZodDate)
    return "TEXT";
  if (zodType instanceof z.ZodNumber || zodType instanceof z.ZodBoolean)
    return "INTEGER";
  if (zodType instanceof z.ZodEnum) return "TEXT";
  if (
    (zodType as any)._def.typeName === "ZodInstanceOf" &&
    (zodType as any)._def.type === Buffer
  )
    return "BLOB";
  // z.object(), z.array(), z.record() → stored as JSON TEXT
  return "TEXT";
}

/** Transform JS values to SQLite storage format */
export function transformForStorage(
  data: Record<string, any>,
): Record<string, any> {
  const transformed: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Date) {
      transformed[key] = value.toISOString();
    } else if (typeof value === "boolean") {
      transformed[key] = value ? 1 : 0;
    } else if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !(value instanceof Buffer)
    ) {
      // Auto-serialize objects and arrays to JSON
      transformed[key] = JSON.stringify(value);
    } else {
      transformed[key] = value;
    }
  }
  return transformed;
}

/** Transform SQLite row back to JS types based on schema */
export function transformFromStorage(
  row: Record<string, any>,
  schema: z.ZodType<any>,
): Record<string, any> {
  const transformed: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    let fieldSchema = asZodObject(schema).shape[key];
    if (fieldSchema instanceof z.ZodOptional) {
      fieldSchema = fieldSchema._def.innerType;
    }
    if (fieldSchema instanceof z.ZodDefault) {
      fieldSchema = fieldSchema._def.innerType;
    }
    if (fieldSchema instanceof z.ZodDate && typeof value === "string") {
      transformed[key] = new Date(value);
    } else if (
      fieldSchema instanceof z.ZodBoolean &&
      typeof value === "number"
    ) {
      transformed[key] = value === 1;
    } else if (isJsonSchema(fieldSchema) && typeof value === "string") {
      // Auto-parse JSON columns
      try {
        transformed[key] = JSON.parse(value);
      } catch {
        transformed[key] = value;
      }
    } else {
      transformed[key] = value;
    }
  }
  return transformed;
}

/** Check if a Zod schema represents a JSON-serializable type */
function isJsonSchema(schema: any): boolean {
  if (!schema) return false;
  return (
    schema instanceof z.ZodObject ||
    schema instanceof z.ZodArray ||
    schema instanceof z.ZodRecord ||
    schema instanceof z.ZodTuple ||
    schema instanceof z.ZodUnion ||
    schema instanceof z.ZodDiscriminatedUnion
  );
}
