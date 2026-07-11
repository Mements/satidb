#!/usr/bin/env bun
/**
 * cli.ts — sqlite-zod-orm command-line tools.
 *
 * Currently implements:
 *   sqlite-zod-orm migrate ./src/db.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createMigrator,
  type MigrationBackup,
  type MigrationColumnMapping,
  type MigrationConflictStrategy,
  type MigrationPlan,
} from "./migrator";

type CliDatabase = {
  tables(): string[];
  columns(
    tableName: string,
  ): {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  raw<T = any>(sql: string, ...params: any[]): T[];
  exec(sql: string, ...params: any[]): void;
  transaction<T>(callback: () => T): T;
  migrator?: () => ReturnType<typeof createMigrator>;
};

type ParsedArgs = {
  command: string | null;
  modulePath: string | null;
  from?: string;
  to?: string;
  table?: string;
  conflicts?: MigrationConflictStrategy;
  dryRun: boolean;
  yes: boolean;
  list: boolean;
  save?: string;
  apply?: string;
  help: boolean;
};

function printHelp(): void {
  console.log(`sqlite-zod-orm

Usage:
  sqlite-zod-orm migrate <db-module.ts> [options]

Options:
  --list                         List available backup tables and exit
  --from <table_vN>              Backup/source table to migrate from
  --to <table>                   Current/destination table to migrate into
  --table <table>                Pick newest backup for this current table
  --conflicts <abort|ignore|replace>
                                 Conflict strategy. Default: abort
  --dry-run                      Print migration SQL without applying
  --yes                          Apply without final confirmation
  --save <file.json>             Save the migration plan JSON
  --apply <file.json>            Apply a saved migration plan JSON
  -h, --help                     Show this help

Examples:
  sqlite-zod-orm migrate ./src/db.ts
  sqlite-zod-orm migrate ./src/db.ts --table users --dry-run
  sqlite-zod-orm migrate ./src/db.ts --from users_v1 --to users --conflicts ignore
  sqlite-zod-orm migrate ./src/db.ts --apply .sqlite-zod-orm/migrations/users_v1_to_users.json
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? null,
    modulePath: null,
    dryRun: false,
    yes: false,
    list: false,
    help: false,
  };

  const rest = argv.slice(1);
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--from") parsed.from = rest.shift();
    else if (arg === "--to") parsed.to = rest.shift();
    else if (arg === "--table") parsed.table = rest.shift();
    else if (arg === "--save") parsed.save = rest.shift();
    else if (arg === "--apply") parsed.apply = rest.shift();
    else if (arg === "--conflicts") {
      const value = rest.shift();
      if (value !== "abort" && value !== "ignore" && value !== "replace") {
        throw new Error(`Invalid --conflicts value: ${value}`);
      }
      parsed.conflicts = value;
    } else if (!parsed.modulePath) {
      parsed.modulePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function looksLikeDatabase(value: any): value is CliDatabase {
  return (
    !!value &&
    typeof value.tables === "function" &&
    typeof value.columns === "function" &&
    typeof value.raw === "function" &&
    typeof value.exec === "function" &&
    typeof value.transaction === "function"
  );
}

async function loadDatabase(modulePath: string): Promise<CliDatabase> {
  const url = pathToFileURL(resolve(modulePath)).href;
  const mod = await import(url);

  if (looksLikeDatabase(mod.default)) return mod.default;

  for (const value of Object.values(mod)) {
    if (looksLikeDatabase(value)) return value;
  }

  throw new Error(
    `Could not find a sqlite-zod-orm Database instance exported from ${modulePath}.\n` +
      `Export it as default or as a named export, for example: export const db = new Database(...).`,
  );
}

function formatBackups(backups: MigrationBackup[]): string {
  if (backups.length === 0) return "No backup tables found.";
  return backups
    .map(
      (b, i) =>
        `${String(i + 1).padStart(2)}. ${b.backup} -> ${b.table}  ` +
        `(backup rows: ${b.backupRows}, current rows: ${b.currentRows})`,
    )
    .join("\n");
}

function parseLiteral(input: string): any {
  const trimmed = input.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function mappingToLabel(mapping: MigrationColumnMapping): string {
  if ("source" in mapping) return mapping.source;
  if ("literal" in mapping) return JSON.stringify(mapping.literal);
  if ("sql" in mapping) return `sql:${mapping.sql}`;
  return "omit/default";
}

async function chooseBackup(
  rl: ReturnType<typeof createInterface>,
  backups: MigrationBackup[],
  args: ParsedArgs,
): Promise<MigrationBackup> {
  if (args.from && args.to) {
    const found = backups.find(
      (b) => b.backup === args.from && b.table === args.to,
    );
    if (found) return found;
    return {
      backup: args.from,
      table: args.to,
      version: Number(/_v(\d+)$/.exec(args.from)?.[1] ?? 0),
      backupRows: 0,
      currentRows: 0,
    };
  }

  const filtered = args.table
    ? backups.filter((b) => b.table === args.table)
    : backups;
  if (filtered.length === 0) {
    throw new Error(
      args.table
        ? `No backups found for table ${args.table}`
        : "No backup tables found.",
    );
  }

  if (filtered.length === 1) return filtered[0]!;

  console.log("\nFound backup tables:\n");
  console.log(formatBackups(filtered));
  console.log("");

  while (true) {
    const answer = await rl.question(
      `Which backup should be migrated? [1-${filtered.length}] `,
    );
    const idx = Number(answer.trim());
    if (Number.isInteger(idx) && idx >= 1 && idx <= filtered.length)
      return filtered[idx - 1]!;
  }
}

async function completePlanInteractively(
  rl: ReturnType<typeof createInterface>,
  db: CliDatabase,
  plan: MigrationPlan,
  args: ParsedArgs,
): Promise<MigrationPlan> {
  const migrator = db.migrator ? db.migrator() : createMigrator(db);
  const sourceColumns = new Set(db.columns(plan.from).map((c) => c.name));
  const targetColumns = db.columns(plan.to);

  console.log(`\nColumn mapping for ${plan.from} -> ${plan.to}:\n`);

  for (const col of targetColumns) {
    const current = plan.columns[col.name];
    if (current && "source" in current && sourceColumns.has(current.source)) {
      console.log(`  ${col.name} <- ${current.source}`);
      continue;
    }

    if (
      current &&
      "omit" in current &&
      (!col.notnull || col.dflt_value !== null || col.pk)
    ) {
      console.log(`  ${col.name} <- omit/default`);
      continue;
    }

    console.log(
      `\nColumn: ${col.name} ${col.type}${col.notnull ? " NOT NULL" : ""}${col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : ""}`,
    );
    const suggestions = migrator
      .suggestSources(plan.from, col.name)
      .filter((c) => sourceColumns.has(c));
    if (suggestions.length > 0) {
      console.log("Suggested sources:");
      suggestions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
    console.log("Other choices: null, omit, literal:<value>, sql:<expression>");

    while (true) {
      const answer = (await rl.question(`Map ${col.name} from? `)).trim();
      if (!answer && suggestions[0]) {
        plan.columns[col.name] = { source: suggestions[0] };
        break;
      }
      const numeric = Number(answer);
      if (
        Number.isInteger(numeric) &&
        numeric >= 1 &&
        numeric <= suggestions.length
      ) {
        plan.columns[col.name] = { source: suggestions[numeric - 1]! };
        break;
      }
      if (sourceColumns.has(answer)) {
        plan.columns[col.name] = { source: answer };
        break;
      }
      if (answer === "null") {
        plan.columns[col.name] = { literal: null };
        break;
      }
      if (answer === "omit") {
        if (col.notnull && col.dflt_value === null && !col.pk) {
          console.log(
            "This column is required and has no default; choose a source, null/literal, or sql expression.",
          );
          continue;
        }
        plan.columns[col.name] = { omit: true };
        break;
      }
      if (answer.startsWith("literal:")) {
        plan.columns[col.name] = {
          literal: parseLiteral(answer.slice("literal:".length)),
        };
        break;
      }
      if (answer.startsWith("sql:")) {
        plan.columns[col.name] = { sql: answer.slice("sql:".length).trim() };
        break;
      }
      console.log(
        "Unknown choice. Enter a source column name, number, null, omit, literal:<value>, or sql:<expression>.",
      );
    }
  }

  if (!args.conflicts) {
    const currentRows =
      db.raw<{ c: number }>(
        `SELECT COUNT(*) as c FROM "${plan.to.replace(/"/g, '""')}"`,
      )[0]?.c ?? 0;
    if (Number(currentRows) > 0) {
      console.log(`\nDestination ${plan.to} already has ${currentRows} rows.`);
      console.log("Conflict strategy: abort, ignore, replace");
      const answer =
        (await rl.question("Choose conflict strategy [abort] ")).trim() ||
        "abort";
      if (answer === "abort" || answer === "ignore" || answer === "replace")
        plan.conflicts = answer;
      else throw new Error(`Invalid conflict strategy: ${answer}`);
    }
  }

  return plan;
}

function printPlan(plan: MigrationPlan): void {
  console.log("\nMigration plan:\n");
  console.log(`from:      ${plan.from}`);
  console.log(`to:        ${plan.to}`);
  console.log(`conflicts: ${plan.conflicts}`);
  console.log("columns:");
  for (const [target, mapping] of Object.entries(plan.columns)) {
    console.log(`  ${target} <- ${mappingToLabel(mapping)}`);
  }
}

async function runMigrate(args: ParsedArgs): Promise<void> {
  if (!args.modulePath) throw new Error("Missing <db-module.ts>.");

  const db = await loadDatabase(args.modulePath);
  const migrator = db.migrator ? db.migrator() : createMigrator(db);
  const backups = migrator.findBackups();

  if (args.list) {
    console.log(formatBackups(backups));
    return;
  }

  if (args.apply) {
    const plan = JSON.parse(
      readFileSync(resolve(args.apply), "utf8"),
    ) as MigrationPlan;
    console.log(migrator.explain(plan));
    if (args.dryRun) return;
    const result = migrator.apply(plan);
    console.log(`\nMigrated ${plan.from} -> ${plan.to}`);
    console.log(`Rows read:     ${result.fromRows}`);
    console.log(`Rows before:   ${result.toRowsBefore}`);
    console.log(`Rows after:    ${result.toRowsAfter}`);
    console.log(`Backup kept:   ${plan.from}`);
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const backup = await chooseBackup(rl, backups, args);
    let plan = migrator.createAutoPlan({
      from: backup.backup,
      to: backup.table,
      conflicts: args.conflicts ?? "abort",
    });
    plan = await completePlanInteractively(rl, db, plan, args);

    printPlan(plan);
    console.log("\nSQL preview:\n");
    console.log(migrator.explain(plan));

    if (args.save) {
      writeFileSync(resolve(args.save), JSON.stringify(plan, null, 2) + "\n");
      console.log(`\nSaved plan: ${args.save}`);
    }

    if (args.dryRun) return;

    const confirmed =
      args.yes ||
      /^(y|yes)$/i.test(await rl.question("\nApply migration? [y/N] "));
    if (!confirmed) {
      console.log("Migration cancelled.");
      return;
    }

    const result = migrator.apply(plan);
    console.log(`\nMigrated ${plan.from} -> ${plan.to}`);
    console.log(`Rows read:     ${result.fromRows}`);
    console.log(`Rows before:   ${result.toRowsBefore}`);
    console.log(`Rows after:    ${result.toRowsAfter}`);
    console.log(`Backup kept:   ${plan.from}`);
  } finally {
    rl.close();
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    printHelp();
    return;
  }

  if (args.command !== "migrate") {
    throw new Error(`Unknown command: ${args.command}`);
  }

  await runMigrate(args);
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
