import type { DbSettings } from "./api";
import type { DbProfile } from "./desktop";

/** A saved "insert into database" profile, in the shape the backend expects. */
export function profileToDb(p: DbProfile): DbSettings {
  return {
    db_type: p.dbType,
    connection_string: p.connectionString,
    sql: p.sql,
    pre_sql: p.preSql,
    mode: p.mode,
    chunk_seconds: Math.max(1, Math.round(p.chunkSeconds || 10)),
    variables: Object.fromEntries(p.variables.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value])),
  };
}

/** Saved profiles that can run without further input (have a connection string and SQL). */
export async function loadUsableProfiles(): Promise<DbProfile[]> {
  const list = (await window.desktop?.loadDbProfiles?.()) ?? [];
  return list.filter((p) => p.connectionString.trim() && p.sql.trim());
}
