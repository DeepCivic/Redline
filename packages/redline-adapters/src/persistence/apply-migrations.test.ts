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
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "redline_chunks",
        "redline_graph_edges",
        "redline_graph_entities",
        "redline_money_spans",
      ]);
    } finally {
      await database.close();
    }
  });

  // Migrations are forward-only: 0000-0003 still create the Evaluation tables on
  // every boot and 0007 drops them, so a database first migrated before the pivot
  // and one first migrated after it must reach the same end state.
  it("leaves a money span standing once its evaluation parent is dropped", async () => {
    const database = new PGlite();
    try {
      await applyMigrations((sql) => database.exec(sql));
      await database.exec(
        `insert into redline_money_spans
           (id, evaluation_id, document_id, locus, text, value, negative, confidence)
         values ('span-1', 'corpus-1', 'hashA', 'narrative', '$80,000', 80000, false, 0.9)`,
      );

      const spans = await database.query<{ id: string }>("select id from redline_money_spans");

      expect(spans.rows.map((row) => row.id)).toEqual(["span-1"]);
    } finally {
      await database.close();
    }
  });

  // The boot *after* the one that dropped the Evaluation tables. 0000 recreates an
  // empty redline_evaluations and 0001 re-adds the money-span FK against it, so a
  // store holding spans re-validates orphan rows and raises foreign_key_violation.
  // Untrapped, that stops the service starting — which the plain re-apply test
  // above cannot catch, because it never loads a row before re-applying.
  it("re-applies over a loaded store, the boot after the Evaluation tables went", async () => {
    const database = new PGlite();
    try {
      await applyMigrations((sql) => database.exec(sql));
      await database.exec(
        `insert into redline_money_spans
           (id, evaluation_id, document_id, locus, text, value, negative, confidence)
         values ('span-1', 'corpus-1', 'hashA', 'narrative', '$80,000', 80000, false, 0.9)`,
      );

      await applyMigrations((sql) => database.exec(sql));

      const spans = await database.query<{ id: string }>("select id from redline_money_spans");
      expect(spans.rows.map((row) => row.id)).toEqual(["span-1"]);
    } finally {
      await database.close();
    }
  });
});
