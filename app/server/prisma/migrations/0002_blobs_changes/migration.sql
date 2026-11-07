-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" REAL NOT NULL,
    "deleted_at" REAL,
    "purge_after" REAL
);

-- CreateTable
CREATE TABLE "blobs" (
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "device_id" TEXT,
    "updated_at" REAL NOT NULL,

    PRIMARY KEY ("scope", "kind")
);

-- CreateTable
CREATE TABLE "changes" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "meeting_id" TEXT,
    "kind" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sha256" TEXT,
    "size" INTEGER,
    "deleted" BOOLEAN NOT NULL,
    "device_id" TEXT,
    "at" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "blobs_sha256_idx" ON "blobs"("sha256");
