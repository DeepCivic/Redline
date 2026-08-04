import { describe, it, expect } from "vitest";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, MIGRATION_FILES } from "./apply-migrations";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");

describe("the migration set", () => {
  // MIGRATION_FILES is hand-maintained. A migration added to the directory but
  // not to the list applies nowhere and fails at runtime as a missing table,
  // which reads like a code fault rather than a packaging one.
  it("registers every .sql file in the migrations directory, in order", async () => {
    const onDisk = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();

    expect([...MIGRATION_FILES]).toEqual(onDisk);
  });

  it("applies twice without error, and the second run is a no-op", async () => {
    const database = new PGlite();
    try {
      await applyMigrations((sql) => database.exec(sql));
      await applyMigrations((sql) => database.exec(sql));

      const tables = await database.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_name like 'redline\\_%' order by table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toContain("redline_evaluations");
      expect(tables.rows.map((row) => row.table_name)).toContain("redline_lenses");
    } finally {
      await database.close();
    }
  });
});
