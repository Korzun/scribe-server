-- CreateTable
CREATE TABLE "uploads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "device_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "declared_sha256" TEXT NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "part_size" INTEGER NOT NULL,
    "if_match" INTEGER,
    "epoch" INTEGER NOT NULL,
    "created_at" REAL NOT NULL,
    "expires_at" REAL NOT NULL,
    "completed_at" REAL
);

-- CreateIndex
CREATE INDEX "uploads_expires_at_idx" ON "uploads"("expires_at");
