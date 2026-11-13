-- CreateTable
CREATE TABLE "mcp_clients" (
    "client_id" TEXT NOT NULL PRIMARY KEY,
    "client_secret" TEXT,
    "client_id_issued_at" REAL NOT NULL,
    "client_secret_expires_at" REAL,
    "last_granted_at" REAL,
    "metadata" TEXT NOT NULL,
    "created_at" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "mcp_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "library_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "created_at" REAL NOT NULL,
    "last_used_at" REAL,
    CONSTRAINT "mcp_grants_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "libraries" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mcp_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_clients" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mcp_authorization_codes" (
    "code_hash" TEXT NOT NULL PRIMARY KEY,
    "grant_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "resource" TEXT,
    "wrap" BLOB NOT NULL,
    "expires_at" REAL NOT NULL,
    CONSTRAINT "mcp_authorization_codes_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_grants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mcp_tokens" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "grant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "wrap" BLOB NOT NULL,
    "expires_at" REAL NOT NULL,
    "created_at" REAL NOT NULL,
    CONSTRAINT "mcp_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_grants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meeting_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_device_id" TEXT,
    "lease_expires_at" REAL,
    "created_at" REAL NOT NULL,
    "started_at" REAL,
    "finished_at" REAL,
    "outcome" TEXT,
    "note" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_grants_library_id_client_id_key" ON "mcp_grants"("library_id", "client_id");

-- CreateIndex
CREATE INDEX "mcp_authorization_codes_grant_id_idx" ON "mcp_authorization_codes"("grant_id");

-- CreateIndex
CREATE INDEX "mcp_tokens_grant_id_idx" ON "mcp_tokens"("grant_id");

-- CreateIndex
CREATE INDEX "mcp_tokens_expires_at_idx" ON "mcp_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "jobs_status_created_at_idx" ON "jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_meeting_id_idx" ON "jobs"("meeting_id");
