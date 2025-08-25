#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';

// --- Utility Functions ---

/**
 * Converts a string from snake_case or camelCase to PascalCase.
 * @param {string} str The input string.
 * @returns {string} The PascalCased string.
 */
const toPascalCase = (str) =>
    str.replace(/(^\w|[-_](\w))/g, (match, p1, p2) => (p2 ? p2.toUpperCase() : p1.toUpperCase()));

/**
 * Naively pluralizes a word.
 * @param {string} str The input string.
 * @returns {string} The pluralized string.
 */
const pluralize = (str) => (str.endsWith('s') ? str : `${str}es`);

/**
 * Maps a Zod type definition string to a TypeScript type string.
 * @param {string} zodDef The Zod definition string.
 * @returns {string} The corresponding TypeScript type.
 */
const mapZodToTsType = (zodDef) => {
    if (zodDef.startsWith('z.string')) return 'string';
    if (zodDef.startsWith('z.number')) return 'number';
    if (zodDef.startsWith('z.boolean')) return 'boolean';
    if (zodDef.startsWith('z.date')) return 'Date';
    if (zodDef.includes('z.instanceof(Buffer)')) return 'Buffer';
    if (zodDef.startsWith('z.enum')) {
        const matches = zodDef.match(/z\.enum\(\[(.*?)\]\)/);
        if (matches) {
            return matches[1].replace(/,\s*/g, ' | ');
        }
    }
    return 'any';
};

// --- Core Logic ---

/**
 * Analyzes the content of a schema file to extract schema definitions.
 * Also extracts table names from the exported tables object.
 * @param {string} fileContent The content of the schema file.
 * @returns {Array<Object>} An array of analyzed schema objects.
 */
const analyzeSchemas = (fileContent) => {
    const schemaRegex = /export const (\w+?)Schema = z\.object\({([\s\S]+?)}\);/g;
    const schemas = [...fileContent.matchAll(schemaRegex)];
    // Extract table names from the tables export
    const tableRegex = /export const tables = ({[\s\S]*?});/;
    const tableMatch = fileContent.match(tableRegex);
    const tableMap = {};

    let tableNames: Record<string, string> = {};

    if (tableMatch) {
        const tableContent = tableMatch[1];
        // Match key-value pairs, handling both quoted and unquoted keys
        const pairRegex = /['"]?(\w+)['"]?\s*:\s*(\w+)Schema/g;
        let pairMatch;
        while ((pairMatch = pairRegex.exec(tableContent)) !== null) {
            const tableName = pairMatch[1]; // e.g., "personalities"
            const schemaName = pairMatch[2]; // e.g., "Personality"
            tableMap[schemaName] = tableName;
        }
    } else {
        throw 'missing tables export in source definition';
    }

    return schemas.map(match => {
        const schemaName = match[1]; // e.g., 'Personality'
        const schemaBody = match[2];
        // Use the table name from tables export if available, otherwise fallback to pluralize
        const accessorName = tableMap[schemaName] || pluralize(schemaName.charAt(0).toLowerCase() + schemaName.slice(1));

        const fieldRegex = /^\s*(\w+):\s*(.*?)(,)?\s*$/gm;
        const fields = [...schemaBody.matchAll(fieldRegex)];

        const parsedSchema = {
            name: schemaName,
            augmentedName: `Augmented${schemaName}`,
            dataName: `${schemaName}Data`,
            accessorName,
            primitives: [],
            belongsTo: [],
            oneToMany: [],
        };

        fields.forEach(fieldMatch => {
            const fieldName = fieldMatch[1];
            const zodDef = fieldMatch[2].trim();
            const isOptional = zodDef.includes('.optional()');

            // One-to-Many relationship: z.lazy(() => z.array(OtherSchema))
            const oneToManyMatch = zodDef.match(/z\.lazy\(\(\) => z\.array\((\w+?)Schema\)\)/);
            if (oneToManyMatch) {
                const relatedSchemaName = oneToManyMatch[1];
                parsedSchema.oneToMany.push({
                    fieldName,
                    isOptional,
                    relatedName: relatedSchemaName,
                });
                return;
            }

            // Belongs-To relationship: z.lazy(() => OtherSchema)
            const belongsToMatch = zodDef.match(/z\.lazy\(\(\) => (\w+?)Schema\)/);
            if (belongsToMatch) {
                const relatedSchemaName = belongsToMatch[1];
                parsedSchema.belongsTo.push({
                    fieldName,
                    isOptional,
                    relatedName: relatedSchemaName,
                    foreignKey: `${fieldName}Id`,
                });
                return;
            }

            // Primitive field
            const hasDefault = zodDef.includes('.default(');
            parsedSchema.primitives.push({
                name: fieldName,
                type: mapZodToTsType(zodDef),
                isOptionalOnCreate: isOptional || hasDefault,
                isOptionalOnEntity: isOptional,
            });
        });

        return parsedSchema;
    });
};

/**
 * Generates the TypeScript type definitions as a string.
 * @param {Array<Object>} analyzedSchemas The array of analyzed schema objects.
 * @returns {string} The full content for the types.ts file.
 */
const generateTypeFileContent = (analyzedSchemas) => {
    const preamble = `/**
 * This file is auto-generated by the SatiDB types generator.
 * Do not edit this file manually.
 */\n
import type { Buffer } from 'buffer';
\n`;

    const genericTypes = `// --- GENERIC & QUERY TYPES ---

/** Describes the standard methods attached to every SatiDB entity instance. */
export type AugmentedMethods<T, D> = {
  /**
   * Updates the current entity with new data.
   * @param data A partial object of the entity's data to update.
   * @returns The updated entity, or null if the update fails.
   */
  update: (data: Partial<D>) => T | null;
  /** Deletes the current entity from the database. */
  delete: () => void;
};

/** Operators for filtering on fields like numbers, strings, or dates. */
export type FilterOperators<T> = {
  /** Greater than */
  $gt?: T;
  /** Greater than or equal to */
  $gte?: T;
  /** Less than */
  $lt?: T;
  /** Less than or equal to */
  $lte?: T;
  /** Not equal to */
  $ne?: T;
  /** Value is in the given array */
  $in?: T[];
};

/**
 * Defines the query conditions for an entity.
 * Allows direct value matching (e.g., { name: 'John' }) or operator-based filtering (e.g., { age: { $gt: 30 } }).
 */
export type QueryConditions<D> = {
  [P in keyof D]?: D[P] | FilterOperators<D[P]>;
};

/** Options for controlling find queries, such as sorting, pagination, and including related data. */
export type FindOptions = {
    /** The maximum number of records to return. */
    $limit?: number;
    /** The number of records to skip for pagination. */
    $offset?: number;
    /** The field to sort by, with an optional direction. Example: 'createdAt:desc' */
    $sortBy?: string;
    /** A related entity or list of entities to eagerly load with the query. */
    $include?: string | string[];
};

/** The complete set of conditions for a find query, combining field filters and query options. */
export type FindQuery<D> = QueryConditions<D> & FindOptions;

/** Describes the accessor object for a one-to-many relationship (e.g., author.posts). */
export type OneToManyAccessor<T, D> = {
  /** Inserts a new related entity. */
  insert: (data: D) => T;
  /** Retrieves a single related entity matching the query. Returns null if not found. */
  get: (conditions: number | QueryConditions<D>) => T | null;
  /** An alias for get. Retrieves a single related entity matching the query. */
  findOne: (conditions: QueryConditions<D>) => T | null;
  /** Finds all related entities matching the query. */
  find: (query?: FindQuery<D>) => T[];
  /** Updates a related entity by its ID. */
  update: (id: number, data: Partial<D>) => T | null;
  /** Updates a related entity if it exists (based on query conditions), otherwise inserts a new one. */
  upsert: (conditions: QueryConditions<D>, data: Partial<D>) => T;
  /** Deletes a related entity by its ID, or all related entities if no ID is provided. */
  delete: (id?: number) => void;
  /** An alias for insert. */
  push: (data: D) => T;
};

/** Describes a top-level accessor on the DB object (e.g., db.authors). */
export type EntityAccessor<T, D> = {
    /** Inserts a new entity. */
    insert: (data: D) => T;
    /** Finds multiple entities using Prisma-like interface with where, orderBy, take. */
    findMany: (options: { where?: QueryConditions<D>; orderBy?: Record<keyof D, 'asc' | 'desc'>; take?: number }) => T[];
    /** Finds a unique entity using Prisma-like interface with where clause. */
    findUnique: (options: { where: QueryConditions<D> }) => T | null;
    /** Retrieves a single entity by its ID or by a set of query conditions. */
    get: (conditions: number | QueryConditions<D>) => T | null;
    /** An alias for get. Retrieves a single entity matching the query. */
    findOne: (conditions: QueryConditions<D>) => T | null;
    /** Finds all entities matching the query. */
    find: (query?: FindQuery<D>) => T[];
    /** Updates an entity by its ID. */
    update: (id: number, data: Partial<D>) => T | null;
    /** Updates an entity if it exists (based on query conditions), otherwise inserts a new one. */
    upsert: (conditions: QueryConditions<D>, data: Partial<D>) => T;
    /** Deletes an entity by its ID. */
    delete: (id: number) => void;
    /** Subscribes to database events ('insert', 'update', 'delete') for this entity type. */
    subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: T) => void) => void;
    /** Unsubscribes from database events ('insert', 'update', 'delete') for this entity type. */
    unsubscribe: (event: 'insert' | 'update' | 'delete', callback: (data: T) => void) => void;
};
\n`;

    let dataDefs = `// --- DATA TYPES FOR CREATION ---\n`;
    analyzedSchemas.forEach(schema => {
        dataDefs += `/** Data required to create a new \`${schema.name}\`. */\n`;
        dataDefs += `export type ${schema.dataName} = {\n`;
        schema.primitives.forEach(p => {
            dataDefs += `  ${p.name}${p.isOptionalOnCreate ? '?' : ''}: ${p.type};\n`;
        });
        // For creation, you can also specify related entities by their ID
        schema.belongsTo.forEach(r => {
            dataDefs += `  /** Can be a number (the ID of the related \`${r.relatedName}\`) or an object with an ID. */\n`
            dataDefs += `  ${r.fieldName}${r.isOptional ? '?' : ''}: { id: number } | number;\n`
        });
        dataDefs += '};\n\n';
    });

    let augmentedDefs = `// --- AUGMENTED ENTITY TYPES ---\n`;
    analyzedSchemas.forEach(schema => {
        augmentedDefs += `/** Represents a \`${schema.name}\` record from the database, including methods and relationship accessors. */\n`;
        const relatedDataName = `${schema.name}Data`;
        augmentedDefs += `export type ${schema.augmentedName} = {\n`;
        augmentedDefs += `  id: number;\n`;
        // Primitives
        schema.primitives.forEach(p => {
            augmentedDefs += `  ${p.name}${p.isOptionalOnEntity ? '?' : ''}: ${p.type};\n`;
        });
        // Belongs-To relationships (e.g., authorId and author())
        schema.belongsTo.forEach(r => {
            const relatedSchema = analyzedSchemas.find(s => s.name === r.relatedName);
            augmentedDefs += `  /** Foreign key for the related \`${r.relatedName}\`. */\n`
            augmentedDefs += `  ${r.foreignKey}${r.isOptional ? '?' : ''}: number | null;\n`;
            augmentedDefs += `  /** Fetches the related \`${r.relatedName}\`. */\n`
            augmentedDefs += `  ${r.fieldName}: () => ${relatedSchema.augmentedName} | null;\n`;
        });
        // One-to-Many relationships (e.g., posts)
        schema.oneToMany.forEach(r => {
            const relatedSchema = analyzedSchemas.find(s => s.name === r.relatedName);
            augmentedDefs += `  /** Accessor for managing related \`${r.relatedName}\` entities. */\n`
            augmentedDefs += `  ${r.fieldName}${r.isOptional ? '?' : ''}: OneToManyAccessor<${relatedSchema.augmentedName}, ${relatedSchema.dataName}>;\n`;
        });
        // Standard methods
        augmentedDefs += `} & AugmentedMethods<${schema.augmentedName}, ${relatedDataName}>;\n\n`;
    });

    // DB Type Definition
    let dbTypeDef = `// --- DATABASE CLIENT TYPE ---\n\n`;
    dbTypeDef += `/** The base SatiDB client, providing transaction support. */
export type SatiDBClient = {
  /**
   * Wraps a series of database operations in a transaction.
   * If the callback function throws an error, the transaction is rolled back.
   * Otherwise, the transaction is committed.
   * @param callback The function to execute within the transaction.
   * @returns The result of the callback function.
   */
  transaction<T>(callback: () => T): T;
};

/** The fully-typed DB client, combining the base client with all entity accessors. */
`;
    dbTypeDef += `export type DB = SatiDBClient & {\n`
    analyzedSchemas.forEach(schema => {
        dbTypeDef += `  /** Accessor for all \`${schema.name}\` entity operations. */\n`
        dbTypeDef += `  ${schema.accessorName}: EntityAccessor<${schema.augmentedName}, ${schema.dataName}>;\n`
    });
    dbTypeDef += `};\n`;

    return preamble + genericTypes + dataDefs + augmentedDefs + dbTypeDef;
};


// --- Main Execution ---

const main = () => {
    const inputFile = process.argv[2];
    const outputFile = process.argv[3];

    if (!inputFile || !outputFile) {
        console.error('Usage: bunx satidb-gen <path/to/schemas.ts> <path/to/output/types.ts>');
        process.exit(1);
    }

    try {
        const schemaFileContent = fs.readFileSync(inputFile, 'utf-8');
        const analyzed = analyzeSchemas(schemaFileContent);
        const typeFileContent = generateTypeFileContent(analyzed);
        fs.writeFileSync(outputFile, typeFileContent);

        console.log(`✅ Successfully generated types at ${outputFile}`);
    } catch (error) {
        console.error(`❌ Error generating types: ${error.message}`);
        process.exit(1);
    }
};

main();