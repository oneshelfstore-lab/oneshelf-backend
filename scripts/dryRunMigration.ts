/**
 * Run a pending migration against the LIVE database inside a transaction that is always rolled
 * back, and report what each statement would do.
 *
 * Why this exists: `start` is `prisma migrate deploy && node dist/index.js`, so a migration that
 * fails does not fail a test — it fails a boot, on production, with the service already down. And a
 * migration carrying a backfill is writing to a money ledger sight-unseen. This runs the real SQL
 * against the real data, prints the real affected-row counts, and then throws so nothing lands.
 *
 * It also re-checks afterwards that the new columns genuinely do NOT exist on the live database, so
 * a rollback that silently did not happen cannot be mistaken for a clean dry run.
 *
 * ⚠️ DDL inside a transaction is a Postgres feature, not a universal one. This works here because
 * the database is Postgres; it would not on MySQL, where ALTER TABLE commits implicitly.
 *
 * Run: railway run --service Postgres bash -c 'npx tsx scripts/dryRunMigration.ts <migration-folder>'
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const MIGRATIONS = "prisma/migrations";
const ROLLBACK = "__ROLLBACK__";

function resolveMigration(arg?: string): string {
  const all = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
  if (!arg) {
    const latest = all[all.length - 1];
    console.log(`No migration named; using the newest: ${latest}\n`);
    return latest;
  }
  const hit = all.find((d) => d === arg || d.includes(arg));
  if (!hit) throw new Error(`No migration matching "${arg}". Have:\n  ${all.join("\n  ")}`);
  return hit;
}

async function main() {
  const dir = resolveMigration(process.argv[2]);
  const sql = readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("--")) // comments only; -- inside a string would break this
    .join("\n");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);

  console.log(`${dir}\n${statements.length} statements, inside a transaction that WILL roll back.\n`);

  try {
    await prisma.$transaction(async (tx) => {
      for (const [i, stmt] of statements.entries()) {
        const affected = await tx.$executeRawUnsafe(stmt);
        console.log(`  ${String(i + 1).padStart(2)}. ${stmt.replace(/\s+/g, " ").slice(0, 76)}…  → ${affected} row(s)`);
      }
      throw new Error(ROLLBACK);
    });
  } catch (e: any) {
    if (e?.message !== ROLLBACK) {
      console.error(`\n✗ THIS MIGRATION WOULD FAIL ON BOOT:\n  ${e?.message ?? e}`);
      process.exitCode = 1;
      return;
    }
    console.log("\n✓ Every statement ran, then the transaction rolled back.");
  }

  // Prove the rollback took. Any column this migration adds must still be absent.
  const added = [...sql.matchAll(/ALTER TABLE "(\w+)"([\s\S]*?)(?=;)/g)].flatMap(([, table, body]) =>
    [...body.matchAll(/ADD COLUMN\s+"(\w+)"/g)].map((m) => ({ table, column: m[1] })),
  );
  if (added.length) {
    const present = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE ${added
        .map((c) => `(table_name = '${c.table}' AND column_name = '${c.column}')`)
        .join(" OR ")}`,
    );
    const n = Number(present[0]?.n ?? 0);
    console.log(`  ${added.length} column(s) this migration adds; ${n} of them exist on the live database.`);
    if (n > 0) {
      console.error("✗ THE ROLLBACK DID NOT TAKE — the live schema has changed. Investigate before deploying.");
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
