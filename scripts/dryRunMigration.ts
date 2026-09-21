/**
 * Run every PENDING migration against the LIVE database, in the order `migrate deploy` would run
 * them, inside a single transaction that is always rolled back — then report what each statement
 * would do.
 *
 * Why this exists: `start` is `prisma migrate deploy && node dist/index.js`, so a migration that
 * fails is not a failed test. It is a failed boot, on production, with the service already down.
 * And a migration carrying a backfill is writing to a money ledger sight-unseen. This runs the real
 * SQL against the real data, prints the real affected-row counts, and then throws so nothing lands.
 *
 * It reads `_prisma_migrations` to decide what is pending, so it exercises the same set, in the same
 * order, as the boot that follows — including the case this session created, where two unshipped
 * migrations have to compose with each other and not just with the live schema.
 *
 * Afterwards it re-checks that every column and table the run would add is genuinely still absent,
 * so a rollback that silently did not happen cannot be mistaken for a clean dry run.
 *
 * ⚠️ DDL inside a transaction is a Postgres feature, not a universal one. This works because the
 * database is Postgres; on MySQL an ALTER TABLE commits implicitly and there would be no rollback.
 *
 * Run: railway run --service Postgres bash -c 'npx tsx scripts/dryRunMigration.ts'
 *   …or name one to force just that: `npx tsx scripts/dryRunMigration.ts commission_negotiation`
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const MIGRATIONS = "prisma/migrations";
const ROLLBACK = "__ROLLBACK__";

const localMigrations = (): string[] =>
  readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();

async function pendingMigrations(): Promise<string[]> {
  const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
  const done = new Set(applied.map((r) => r.migration_name));
  return localMigrations().filter((m) => !done.has(m));
}

function statementsOf(dir: string): string[] {
  return readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("--")) // comment lines only; -- inside a literal would break this
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const named = process.argv[2];
  let dirs: string[];
  if (named) {
    const hit = localMigrations().filter((d) => d === named || d.includes(named));
    if (!hit.length) throw new Error(`No migration matching "${named}". Have:\n  ${localMigrations().join("\n  ")}`);
    dirs = hit;
    console.log(`Named: ${dirs.join(", ")}\n`);
  } else {
    dirs = await pendingMigrations();
    if (!dirs.length) {
      console.log("Nothing pending — every local migration is already applied. Nothing to dry run.");
      return;
    }
    console.log(`${dirs.length} pending migration(s), in the order migrate deploy will run them:\n`);
  }

  const plan = dirs.map((d) => ({ dir: d, statements: statementsOf(d) }));
  const total = plan.reduce((n, p) => n + p.statements.length, 0);
  console.log(`${total} statements, inside ONE transaction that WILL roll back.\n`);

  try {
    await prisma.$transaction(
      async (tx) => {
        for (const { dir, statements } of plan) {
          console.log(`── ${dir}`);
          for (const [i, stmt] of statements.entries()) {
            const affected = await tx.$executeRawUnsafe(stmt);
            console.log(`   ${String(i + 1).padStart(2)}. ${stmt.replace(/\s+/g, " ").slice(0, 74)}…  → ${affected} row(s)`);
          }
        }
        throw new Error(ROLLBACK);
      },
      // The default interactive-transaction timeout is 5s, which a multi-migration run can exceed.
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (e: any) {
    if (e?.message !== ROLLBACK) {
      console.error(`\n✗ THIS WOULD FAIL ON BOOT:\n  ${e?.message ?? e}`);
      process.exitCode = 1;
      return;
    }
    console.log("\n✓ Every statement ran, then the transaction rolled back.");
  }

  // Prove the rollback took. Nothing this run creates may exist on the live database.
  const sql = plan.map((p) => p.statements.join(";\n")).join(";\n");
  const columns = [...sql.matchAll(/ALTER TABLE "(\w+)"([\s\S]*?)(?=$|\n(?:CREATE|ALTER))/g)].flatMap(
    ([, table, body]) => [...body.matchAll(/ADD COLUMN\s+"(\w+)"/g)].map((m) => ({ table, column: m[1] })),
  );
  const tables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);

  const colCheck = columns.length
    ? Number(
        (
          await prisma.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM information_schema.columns WHERE ${columns
              .map((c) => `(table_name = '${c.table}' AND column_name = '${c.column}')`)
              .join(" OR ")}`,
          )
        )[0]?.n ?? 0,
      )
    : 0;
  const tblCheck = tables.length
    ? Number(
        (
          await prisma.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN (${tables
              .map((t) => `'${t}'`)
              .join(",")})`,
          )
        )[0]?.n ?? 0,
      )
    : 0;

  console.log(
    `  would add ${columns.length} column(s) — ${colCheck} present on the live database` +
      `\n  would add ${tables.length} table(s)  — ${tblCheck} present on the live database`,
  );
  if (colCheck > 0 || tblCheck > 0) {
    console.error("✗ THE ROLLBACK DID NOT TAKE — the live schema has changed. Investigate before deploying.");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
