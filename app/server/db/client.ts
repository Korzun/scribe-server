import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

export function createPrismaClient(url: string): PrismaClient {
  // better-sqlite3 enables PRAGMA foreign_keys by default; any future ON DELETE
  // CASCADE rules depend on it staying enabled for this runtime connection.
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
}
