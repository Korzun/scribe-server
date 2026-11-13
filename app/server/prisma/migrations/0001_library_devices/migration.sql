-- CreateTable
CREATE TABLE "libraries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" REAL NOT NULL,
    "password_salt" BLOB NOT NULL,
    "recovery_salt" BLOB NOT NULL,
    "auth_verifier" TEXT NOT NULL,
    "password_wrap" BLOB NOT NULL
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "library_id" TEXT NOT NULL,
    "auth_verifier" TEXT NOT NULL,
    "wrap" BLOB NOT NULL,
    "used_at" REAL,
    CONSTRAINT "recovery_codes_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "libraries" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "library_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" REAL NOT NULL,
    "last_seen_at" REAL,
    "revoked_at" REAL,
    CONSTRAINT "devices_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "libraries" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "recovery_codes_library_id_idx" ON "recovery_codes"("library_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_token_hash_key" ON "devices"("token_hash");

-- CreateIndex
CREATE INDEX "devices_library_id_idx" ON "devices"("library_id");
