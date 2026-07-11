/**
 * migrator.ts — Interactive/data migration helpers for backup tables.
 *
 * Runtime schema sync intentionally keeps old data by renaming mismatched
 * tables to table_vN and creating a fresh current table. The migrator is the
 * deliberate follow-up tool: copy data from table_vN into the current table
 * with an explicit, reviewable column mapping.
 */

export type MigrationBackup = {
  /** Current table name, e.g. "users". */
  table: string;
  /** Backup table name, e.g. "users_v1". */
  backup: string;
  /** Numeric backup version parsed from _vN. */
  version: number;
  /** Rows currently in the backup table. */
  backupRows: number;
  /** Rows currently in the destination/current table. */
  currentRows: number;
};

export type MigrationColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

export type MigrationColumnMapping =
  | { source: string }
  | { literal: any }
  | { sql: string; params?: any[] }
  | { omit: true };

export type MigrationConflictStrategy = "abort" | "ignore" | "replace";

export type MigrationPlan = {
  from: string;
  to: string;
  columns: Record<string, MigrationColumnMapping>;
  conflicts: MigrationConflictStrategy;
};

export type MigrationPlanPreview = {
  sql: string;
  params: any[];
  fromRows: number;
  toRowsBefore: number;
};

export type MigrationApplyResult = MigrationPlanPreview & {
  toRowsAfter: number;
  insertedOrChangedRows: number;
};

type DatabaseLike = {
  tables(): string[];
  columns(tableName: string): MigrationColumnInfo[];
  raw<T = any>(sql: string, ...params: any[]): T[];
  exec(sql: string, ...params: any[]): void;
  transaction<T>(callback: () => T): T;
};

function q(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableExists(db: DatabaseLike, tableName: string): boolean {
  const row = db.raw<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    tableName,
  )[0];
  return !!row;
}

function rowCount(db: DatabaseLike, tableName: string): number {
  const row = db.raw<{ c: number }>(
    `SELECT COUNT(*) as c FROM ${q(tableName)}`,
  )[0];
  return Number(row?.c ?? 0);
}

function parseBackupName(
  name: string,
  knownTables: Set<string>,
): { table: string; version: number } | null {
  const match = /^(.*)_v(\d+)$/.exec(name);
  if (!match) return null;
  const table = match[1]!;
  const version = Number(match[2]);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!knownTables.has(table)) return null;
  return { table, version };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}

export class DatabaseMigrator {
  constructor(private readonly db: DatabaseLike) {}

  /** Find table_vN backups that correspond to currently registered tables. */
  findBackups(): MigrationBackup[] {
    const knownTables = new Set(this.db.tables());
    const rows = this.db.raw<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );

    const backups: MigrationBackup[] = [];
    for (const row of rows) {
      const parsed = parseBackupName(row.name, knownTables);
      if (!parsed) continue;
      if (!tableExists(this.db, parsed.table)) continue;
      backups.push({
        table: parsed.table,
        backup: row.name,
        version: parsed.version,
        backupRows: rowCount(this.db, row.name),
        currentRows: rowCount(this.db, parsed.table),
      });
    }

    backups.sort(
      (a, b) => a.table.localeCompare(b.table) || b.version - a.version,
    );
    return backups;
  }

  /** Suggest source columns for a destination column using exact and fuzzy name matching. */
  suggestSources(from: string, toColumn: string, limit = 5): string[] {
    const sourceColumns = this.db.columns(from).map((c) => c.name);
    if (sourceColumns.includes(toColumn)) return [toColumn];

    const targetNorm = normalizeName(toColumn);
    return sourceColumns
      .map((source) => {
        const sourceNorm = normalizeName(source);
        let score = levenshtein(targetNorm, sourceNorm);
        if (sourceNorm.includes(targetNorm) || targetNorm.includes(sourceNorm))
          score -= 2;
        return { source, score };
      })
      .sort((a, b) => a.score - b.score || a.source.localeCompare(b.source))
      .slice(0, limit)
      .map((x) => x.source);
  }

  /** Create a best-effort plan: same-named columns are mapped, nullable/defaulted new columns are omitted. */
  createAutoPlan(options: {
    from: string;
    to: string;
    conflicts?: MigrationConflictStrategy;
  }): MigrationPlan {
    if (!tableExists(this.db, options.from))
      throw new Error(`Source table does not exist: ${options.from}`);
    if (!tableExists(this.db, options.to))
      throw new Error(`Destination table does not exist: ${options.to}`);

    const sourceNames = new Set(
      this.db.columns(options.from).map((c) => c.name),
    );
    const targetColumns = this.db.columns(options.to);
    const columns: Record<string, MigrationColumnMapping> = {};

    for (const col of targetColumns) {
      if (sourceNames.has(col.name)) {
        columns[col.name] = { source: col.name };
      } else if (col.pk) {
        columns[col.name] = { omit: true };
      } else if (!col.notnull || col.dflt_value !== null) {
        columns[col.name] = { omit: true };
      } else {
        // Required and no default: user/CLI must decide before apply.
        columns[col.name] = { omit: true };
      }
    }

    return {
      from: options.from,
      to: options.to,
      columns,
      conflicts: options.conflicts ?? "abort",
    };
  }

  /** Compile a migration plan to one INSERT ... SELECT statement. */
  preview(plan: MigrationPlan): MigrationPlanPreview {
    if (!tableExists(this.db, plan.from))
      throw new Error(`Source table does not exist: ${plan.from}`);
    if (!tableExists(this.db, plan.to))
      throw new Error(`Destination table does not exist: ${plan.to}`);

    const sourceNames = new Set(this.db.columns(plan.from).map((c) => c.name));
    const targetNames = new Set(this.db.columns(plan.to).map((c) => c.name));
    const targetCols: string[] = [];
    const selectExprs: string[] = [];
    const params: any[] = [];

    for (const [target, mapping] of Object.entries(plan.columns)) {
      if ("omit" in mapping) continue;
      if (!targetNames.has(target))
        throw new Error(
          `Destination column does not exist: ${plan.to}.${target}`,
        );

      targetCols.push(q(target));
      if ("source" in mapping) {
        if (!sourceNames.has(mapping.source))
          throw new Error(
            `Source column does not exist: ${plan.from}.${mapping.source}`,
          );
        selectExprs.push(q(mapping.source));
      } else if ("literal" in mapping) {
        selectExprs.push("?");
        params.push(mapping.literal);
      } else if ("sql" in mapping) {
        selectExprs.push(mapping.sql);
        params.push(...(mapping.params ?? []));
      } else {
        throw new Error(`Invalid mapping for ${target}`);
      }
    }

    if (targetCols.length === 0)
      throw new Error("Migration plan has no columns to insert.");

    const conflict =
      plan.conflicts === "ignore"
        ? "OR IGNORE "
        : plan.conflicts === "replace"
          ? "OR REPLACE "
          : "";

    const sql =
      `INSERT ${conflict}INTO ${q(plan.to)} (${targetCols.join(", ")})\n` +
      `SELECT ${selectExprs.join(", ")} FROM ${q(plan.from)}`;

    return {
      sql,
      params,
      fromRows: rowCount(this.db, plan.from),
      toRowsBefore: rowCount(this.db, plan.to),
    };
  }

  /** Apply a migration plan in one transaction. Backup tables are never dropped. */
  apply(plan: MigrationPlan): MigrationApplyResult {
    const preview = this.preview(plan);
    const before = preview.toRowsBefore;
    this.db.transaction(() => {
      this.db.exec(preview.sql, ...preview.params);
    });
    const after = rowCount(this.db, plan.to);
    return {
      ...preview,
      toRowsAfter: after,
      insertedOrChangedRows: Math.max(0, after - before),
    };
  }

  /** Convenience helper for a human-readable SQL preview with bound params commented. */
  explain(plan: MigrationPlan): string {
    const preview = this.preview(plan);
    const lines = [preview.sql];
    if (preview.params.length > 0) {
      lines.push("", `-- params: ${JSON.stringify(preview.params)}`);
    }
    lines.push("", `-- rows in ${plan.from}: ${preview.fromRows}`);
    lines.push(`-- rows in ${plan.to} before: ${preview.toRowsBefore}`);
    return lines.join("\n");
  }
}

export function createMigrator(db: DatabaseLike): DatabaseMigrator {
  return new DatabaseMigrator(db);
}
