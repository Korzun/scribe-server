import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { PrismaClient } from '@prisma/client';

import { logger } from '../logger';

const log = logger('Migrate');

/**
 * Resolves the Prisma Migrate migrations directory, which lives at
 * `prisma/migrations/` relative to the server package root. Works for both
 * the compiled production layout (dist/db/migrate.js → ../../prisma/migrations)
 * and the source development layout (db/migrate.ts → ../prisma/migrations).
 */
function findMigrationsDir(): string | null {
  const candidates = [
    path.join(__dirname, '../../prisma/migrations'), // compiled: dist/db → server root
    path.join(__dirname, '../prisma/migrations'), // dev (tsx): db → server root
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}

/**
 * Applies any Prisma Migrate SQL files that have not yet been recorded in
 * `_prisma_migrations`. Migrations generated with `prisma migrate dev` are
 * always executed; the vault has no legacy databases, so the baseline needs
 * no special-casing.
 */
async function applyPendingMigrations(prisma: PrismaClient): Promise<void> {
  const migrationsDir = findMigrationsDir();
  if (!migrationsDir) return;

  // Ensure the Prisma Migrate tracking table exists.
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS _prisma_migrations (
      id                  TEXT     NOT NULL PRIMARY KEY,
      checksum            TEXT     NOT NULL,
      finished_at         DATETIME,
      migration_name      TEXT     NOT NULL,
      logs                TEXT,
      rolled_back_at      DATETIME,
      started_at          DATETIME NOT NULL DEFAULT current_timestamp,
      applied_steps_count INTEGER  NOT NULL DEFAULT 0
    )
  `;

  const applied = await prisma.$queryRaw<Array<{ migration_name: string }>>`
    SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL
  `;
  const appliedSet = new Set(applied.map((r) => r.migration_name));

  const migrationNames = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const migName of migrationNames) {
    if (appliedSet.has(migName)) continue;

    const sqlPath = path.join(migrationsDir, migName, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;

    const sql = fs.readFileSync(sqlPath, 'utf-8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const migId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    await prisma.$executeRaw`
      INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
      VALUES (${migId}, ${checksum}, ${migName}, ${startedAt}, 0)
    `;

    const statements = sql
      .replace(/--[^\n]*/g, '') // strip line comments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await prisma.$executeRawUnsafe(stmt);
    }

    await prisma.$executeRaw`
      UPDATE _prisma_migrations
      SET finished_at = ${new Date().toISOString()}, applied_steps_count = 1
      WHERE id = ${migId}
    `;

    log.info(`Prisma migration applied: ${migName}`);
  }
}

/**
 * Runs a named data migration exactly once, tracking completion in
 * `_prisma_migrations` alongside the Prisma DDL migrations. The vault has no
 * data migrations yet; this is kept for the first schema change that needs one.
 */
export async function runDataMigration(
  prisma: PrismaClient,
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  const existing = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
    WHERE migration_name = ${name} AND rolled_back_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) return;

  await fn();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await prisma.$executeRaw`
    INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
    VALUES (${id}, '', ${name}, ${now}, ${now}, 1)
  `;
}

/**
 * Applies all pending Prisma DDL migrations. Safe to call on every startup.
 */
export async function runMigrations(prisma: PrismaClient): Promise<void> {
  // Enable FK enforcement for the lifetime of this connection so that ON DELETE
  // CASCADE / ON UPDATE CASCADE rules fire correctly at the database level.
  await prisma.$executeRaw`PRAGMA foreign_keys = ON`;

  // Apply any pending Prisma Migrate SQL files and keep _prisma_migrations in sync.
  await applyPendingMigrations(prisma);
}
