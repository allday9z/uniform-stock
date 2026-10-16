/**
 * PostgreSQL schema — every table is prefixed `uni_` because the database is
 * the shared Coolify Postgres instance used by other apps too.
 *
 * Stock correctness lives here as much as in code: variant qty has a
 * CHECK (qty >= 0), so even a buggy or concurrent write can never leave a
 * negative balance — approvals lock the variant rows (SELECT … FOR UPDATE)
 * inside one transaction, see routes in server.ts.
 */
import postgres from "postgres"

export const sql = postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres", {
  max: Number(process.env.PG_MAX ?? 10),   // PG_MAX=1 for single-connection test databases
  onnotice: () => {},
})

export async function initDB(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS uni_users (
      id            SERIAL PRIMARY KEY,
      emp_code      TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('hr', 'employee')),
      phone         TEXT,
      position      TEXT,
      dept          TEXT,
      branch        TEXT,
      disabled      BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS uni_sessions (
      token      TEXT PRIMARY KEY,
      user_id    INT NOT NULL REFERENCES uni_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS uni_settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )`
  await sql`INSERT INTO uni_settings (key, value) VALUES ('main', ${sql.json({ company: "", branches: [], depts: [] })}) ON CONFLICT (key) DO NOTHING`

  await sql`
    CREATE TABLE IF NOT EXISTS uni_products (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      code       TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT '',
      unit       TEXT NOT NULL DEFAULT 'ชิ้น',
      min_qty    INT NOT NULL DEFAULT 5 CHECK (min_qty >= 0),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uni_products_code_live ON uni_products (lower(code)) WHERE deleted_at IS NULL`

  await sql`
    CREATE TABLE IF NOT EXISTS uni_variants (
      id         SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES uni_products(id),
      sku        TEXT NOT NULL,
      size       TEXT NOT NULL DEFAULT '',
      color      TEXT NOT NULL DEFAULT '',
      qty        INT NOT NULL DEFAULT 0 CHECK (qty >= 0),
      sort       INT NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ
    )`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uni_variants_sku_live ON uni_variants (lower(sku)) WHERE deleted_at IS NULL`
  await sql`CREATE INDEX IF NOT EXISTS uni_variants_product ON uni_variants (product_id)`

  // Every qty change writes one row here (in / out / adj). Names, SKU, size and
  // color are snapshotted so history survives product edits and deletion.
  await sql`
    CREATE TABLE IF NOT EXISTS uni_moves (
      id           SERIAL PRIMARY KEY,
      product_id   INT NOT NULL,
      variant_id   INT NOT NULL,
      product_name TEXT NOT NULL,
      sku          TEXT NOT NULL,
      size         TEXT NOT NULL DEFAULT '',
      color        TEXT NOT NULL DEFAULT '',
      type         TEXT NOT NULL CHECK (type IN ('in', 'out', 'adj')),
      qty          INT NOT NULL,
      balance      INT NOT NULL,
      ref          TEXT NOT NULL DEFAULT '',
      who          TEXT NOT NULL DEFAULT '',
      branch       TEXT NOT NULL DEFAULT '',
      note         TEXT NOT NULL DEFAULT '',
      by_user      INT,
      at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`CREATE INDEX IF NOT EXISTS uni_moves_product ON uni_moves (product_id, at DESC)`

  // Running document numbers per prefix (e.g. "REQ-691014" -> 3).
  await sql`
    CREATE TABLE IF NOT EXISTS uni_counters (
      key TEXT PRIMARY KEY,
      n   INT NOT NULL
    )`

  await sql`
    CREATE TABLE IF NOT EXISTS uni_requests (
      id            SERIAL PRIMARY KEY,
      no            TEXT NOT NULL UNIQUE,
      req_date      DATE NOT NULL,
      name          TEXT NOT NULL,
      emp_code      TEXT NOT NULL,
      position      TEXT NOT NULL,
      dept          TEXT NOT NULL DEFAULT '',
      branch        TEXT NOT NULL,
      phone         TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL,
      note          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'shipped', 'rejected', 'cancelled')),
      requester_id  INT NOT NULL REFERENCES uni_users(id),
      dn_no         TEXT UNIQUE,
      approved_at   TIMESTAMPTZ,
      approver_id   INT,
      approver_name TEXT,
      shipped_at    TIMESTAMPTZ,
      shipper_id    INT,
      decision_note TEXT NOT NULL DEFAULT '',
      decided_at    TIMESTAMPTZ,
      decider_id    INT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`CREATE INDEX IF NOT EXISTS uni_requests_status ON uni_requests (status, created_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS uni_requests_requester ON uni_requests (requester_id, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS uni_request_lines (
      id           SERIAL PRIMARY KEY,
      request_id   INT NOT NULL REFERENCES uni_requests(id) ON DELETE CASCADE,
      product_id   INT NOT NULL,
      variant_id   INT NOT NULL,
      product_name TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT '',
      unit         TEXT NOT NULL DEFAULT '',
      sku          TEXT NOT NULL,
      size         TEXT NOT NULL DEFAULT '',
      color        TEXT NOT NULL DEFAULT '',
      qty          INT NOT NULL CHECK (qty > 0)
    )`
  await sql`CREATE INDEX IF NOT EXISTS uni_lines_request ON uni_request_lines (request_id)`

  // ---- Oct 2026 revision (htask-1792149268859) — additive, old rows keep working ----
  // Employee email (notification when HR ships), purchase orders (amount + payment slip),
  // delivery date, notification result, chest size per SKU for the size dropdown.
  await sql`ALTER TABLE uni_users ADD COLUMN IF NOT EXISTS email TEXT`
  await sql`ALTER TABLE uni_variants ADD COLUMN IF NOT EXISTS chest TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'issue'`      // issue | purchase
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS total_qty INT NOT NULL DEFAULT 0`
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS amount INT NOT NULL DEFAULT 0`          // baht, purchases only
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS slip_file_id INT`
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS shipped_date DATE`
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS notify_sent_at TIMESTAMPTZ`
  await sql`ALTER TABLE uni_requests ADD COLUMN IF NOT EXISTS notify_error TEXT NOT NULL DEFAULT ''`
  await sql`
    CREATE TABLE IF NOT EXISTS uni_files (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        INT NOT NULL,
      data        BYTEA NOT NULL,
      uploaded_by INT NOT NULL REFERENCES uni_users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
}

/** Next running number for a prefix, inside the caller's transaction. */
export async function nextNo(tx: any, prefix: string): Promise<string> {
  const [{ n }] = await tx`
    INSERT INTO uni_counters (key, n) VALUES (${prefix}, 1)
    ON CONFLICT (key) DO UPDATE SET n = uni_counters.n + 1
    RETURNING n`
  return `${prefix}-${String(n).padStart(4, "0")}`
}

/** "691014" — Buddhist-era 2-digit year + month + day, Bangkok time. */
export function thaiDateStamp(d = new Date()): string {
  const bkk = new Date(d.getTime() + 7 * 3600 * 1000)
  const be = (bkk.getUTCFullYear() + 543) % 100
  return `${String(be).padStart(2, "0")}${String(bkk.getUTCMonth() + 1).padStart(2, "0")}${String(bkk.getUTCDate()).padStart(2, "0")}`
}
