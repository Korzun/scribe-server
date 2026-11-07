-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "expires_at" REAL NOT NULL
);
