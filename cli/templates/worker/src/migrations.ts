import { SCHEMA_V1 } from "./schema";

export async function migrate(ctx: DurableObjectState): Promise<void> {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const { version } = sql
    .exec<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM _schema_migrations")
    .one();

  if (version < 1) {
    sql.exec(SCHEMA_V1);
    sql.exec("INSERT INTO _schema_migrations(version, applied_at) VALUES (?, ?)", 1, Date.now());
  }
}
