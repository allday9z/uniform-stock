/**
 * Uniform stock & requisition system — HR keeps uniform stock per SKU
 * (size × color), employees request uniforms, HR approves (stock is cut and a
 * delivery note issued in ONE transaction), ships, and keeps the history.
 *
 * Permission rules are enforced here, never only in the UI:
 *  - employees never receive qty / stock status / movements (catalog endpoint
 *    strips them; stock endpoints answer 403)
 *  - employees see only their own requests and can only create / cancel them
 *  - status changes (approve / reject / ship) are HR-only
 */
import { Hono } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { sql, initDB, nextNo, thaiDateStamp } from "./db"

type User = { id: number; emp_code: string; name: string; role: "hr" | "employee"; phone: string | null; position: string | null; dept: string | null; branch: string | null }
type Env = { Variables: { user: User | null } }

const app = new Hono<Env>()
const PORT = Number(process.env.PORT ?? 3000)
const COOKIE = "uni_session"
const SESSION_DAYS = 30
const HR_SETUP_CODE = process.env.HR_SETUP_CODE ?? ""
const REQUEST_TYPES = ["พนักงานใหม่", "เบิกเปลี่ยนตามรอบ", "ชำรุด-สูญหาย", "เปลี่ยนไซส์", "อื่นๆ"]

// ---------- helpers ----------
const str = (v: any, max = 200) => String(v ?? "").trim().slice(0, max)
const int = (v: any) => (Number.isInteger(Number(v)) ? Number(v) : NaN)
function bad(c: any, error: string, status = 400) { return c.json({ error }, status) }
function stockStatus(qty: number, min: number): "out" | "low" | "ok" {
  return qty <= 0 ? "out" : qty <= min ? "low" : "ok"
}
function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
function thaiDate(d: any): string {
  if (!d) return ""
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" })
}
function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
}

// Simple login throttle: 10 attempts / 10 min per IP+code.
const loginHits = new Map<string, number[]>()
function loginAllowed(key: string): boolean {
  const now = Date.now(), hits = (loginHits.get(key) ?? []).filter((t) => now - t < 600_000)
  hits.push(now); loginHits.set(key, hits)
  return hits.length <= 10
}

// ---------- auth ----------
app.use("*", async (c, next) => {
  c.set("user", null)
  const token = getCookie(c, COOKIE)
  if (token) {
    const [u] = await sql`
      SELECT u.id, u.emp_code, u.name, u.role, u.phone, u.position, u.dept, u.branch
      FROM uni_sessions s JOIN uni_users u ON u.id = s.user_id
      WHERE s.token = ${token} AND s.expires_at > NOW() AND NOT u.disabled`
    if (u) c.set("user", u as User)
  }
  await next()
})

function requireUser(c: any): User | null { return c.get("user") }
function isHR(c: any): boolean { return c.get("user")?.role === "hr" }

// Same-origin check for every state-changing API call (cookie auth).
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin")
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host")
    if (origin && host && new URL(origin).host !== host) return bad(c, "forbidden", 403)
  }
  await next()
})

async function startSession(c: any, userId: number) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
  await sql`INSERT INTO uni_sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, NOW() + make_interval(days => ${SESSION_DAYS}))`
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: c.req.url.startsWith("https") || c.req.header("x-forwarded-proto") === "https", path: "/", maxAge: SESSION_DAYS * 86400 })
}

app.post("/api/auth/register", async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const emp_code = str(b.emp_code, 40), name = str(b.name, 100), password = String(b.password ?? "")
  if (!emp_code || !name) return bad(c, "กรุณากรอกรหัสพนักงานและชื่อ-นามสกุล")
  if (password.length < 6) return bad(c, "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร")
  const [exists] = await sql`SELECT 1 FROM uni_users WHERE lower(emp_code) = lower(${emp_code})`
  if (exists) return bad(c, "รหัสพนักงานนี้ลงทะเบียนแล้ว — ถ้าลืมรหัสผ่านให้ติดต่อ HR")
  const hash = await Bun.password.hash(password)
  const [u] = await sql`INSERT INTO uni_users (emp_code, name, password_hash) VALUES (${emp_code}, ${name}, ${hash}) RETURNING id`
  await startSession(c, u.id)
  return c.json({ ok: true })
})

// First HR account: only while no HR exists, and only with the setup code
// from the server env — after that, HR promotes others from the Users page.
app.post("/api/auth/setup-hr", async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM uni_users WHERE role = 'hr'`
  if (n > 0) return bad(c, "มีบัญชี HR แล้ว — ให้ HR ปัจจุบันเพิ่มสิทธิ์ให้จากหน้า 'ผู้ใช้งาน'", 403)
  if (!HR_SETUP_CODE || String(b.setup_code ?? "") !== HR_SETUP_CODE) return bad(c, "รหัสตั้งค่าไม่ถูกต้อง", 403)
  const emp_code = str(b.emp_code, 40), name = str(b.name, 100), password = String(b.password ?? "")
  if (!emp_code || !name || password.length < 6) return bad(c, "กรุณากรอกข้อมูลให้ครบ (รหัสผ่านอย่างน้อย 6 ตัวอักษร)")
  const hash = await Bun.password.hash(password)
  const [existing] = await sql`SELECT id FROM uni_users WHERE lower(emp_code) = lower(${emp_code})`
  const [u] = existing
    ? await sql`UPDATE uni_users SET role = 'hr', name = ${name}, password_hash = ${hash}, disabled = false WHERE id = ${existing.id} RETURNING id`
    : await sql`INSERT INTO uni_users (emp_code, name, password_hash, role) VALUES (${emp_code}, ${name}, ${hash}, 'hr') RETURNING id`
  await startSession(c, u.id)
  return c.json({ ok: true })
})

app.get("/api/auth/needs-setup", async (c) => {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM uni_users WHERE role = 'hr'`
  return c.json({ needsSetup: n === 0 })
})

app.post("/api/auth/login", async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const emp_code = str(b.emp_code, 40), password = String(b.password ?? "")
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "?"
  if (!loginAllowed(ip + "|" + emp_code.toLowerCase())) return bad(c, "ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอ 10 นาที", 429)
  const [u] = await sql`SELECT id, password_hash, disabled FROM uni_users WHERE lower(emp_code) = lower(${emp_code})`
  if (!u || u.disabled || !(await Bun.password.verify(password, u.password_hash))) return bad(c, "รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง", 401)
  await startSession(c, u.id)
  return c.json({ ok: true })
})

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, COOKIE)
  if (token) await sql`DELETE FROM uni_sessions WHERE token = ${token}`
  deleteCookie(c, COOKIE, { path: "/" })
  return c.json({ ok: true })
})

app.get("/api/me", (c) => c.json({ user: requireUser(c) }))

app.post("/api/me/password", async (c) => {
  const me = requireUser(c); if (!me) return bad(c, "unauthenticated", 401)
  const b = await c.req.json().catch(() => ({}))
  const [u] = await sql`SELECT password_hash FROM uni_users WHERE id = ${me.id}`
  if (!(await Bun.password.verify(String(b.current ?? ""), u.password_hash))) return bad(c, "รหัสผ่านปัจจุบันไม่ถูกต้อง")
  if (String(b.next ?? "").length < 6) return bad(c, "รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร")
  await sql`UPDATE uni_users SET password_hash = ${await Bun.password.hash(String(b.next))} WHERE id = ${me.id}`
  return c.json({ ok: true })
})

// Everything below needs a login.
app.use("/api/*", async (c, next) => {
  if (!c.get("user")) return bad(c, "unauthenticated", 401)
  await next()
})
const hrOnly = async (c: any, next: any) => { if (!isHR(c)) return bad(c, "forbidden", 403); await next() }

// ---------- settings ----------
async function getSettings(): Promise<{ company: string; branches: string[]; depts: string[] }> {
  const [r] = await sql`SELECT value FROM uni_settings WHERE key = 'main'`
  return { company: "", branches: [], depts: [], ...(r?.value ?? {}) }
}
app.get("/api/settings", async (c) => c.json({ ...(await getSettings()), requestTypes: REQUEST_TYPES }))
app.put("/api/settings", hrOnly, async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const list = (v: any) => (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((s: any) => str(s, 100)).filter(Boolean).filter((s: string, i: number, a: string[]) => a.indexOf(s) === i).slice(0, 300)
  const value = { company: str(b.company, 200), branches: list(b.branches), depts: list(b.depts) }
  await sql`UPDATE uni_settings SET value = ${sql.json(value)} WHERE key = 'main'`
  return c.json(value)
})

// ---------- catalog (everyone) — NO qty / status / min ----------
app.get("/api/catalog", async (c) => {
  const products = await sql`SELECT id, name, code, category, unit FROM uni_products WHERE deleted_at IS NULL ORDER BY category, name`
  const variants = await sql`SELECT id, product_id, sku, size, color FROM uni_variants WHERE deleted_at IS NULL ORDER BY sort, id`
  return c.json(products.map((p: any) => ({ ...p, variants: variants.filter((v: any) => v.product_id === p.id).map(({ product_id, ...v }: any) => v) })))
})

// ---------- stock (HR) ----------
app.use("/api/stock/*", hrOnly)
app.use("/api/stock", hrOnly)
app.use("/api/products/*", hrOnly)
app.use("/api/products", hrOnly)
app.use("/api/variants/*", hrOnly)

async function productsWithStock(where?: number) {
  const products = where
    ? await sql`SELECT * FROM uni_products WHERE id = ${where} AND deleted_at IS NULL`
    : await sql`SELECT * FROM uni_products WHERE deleted_at IS NULL ORDER BY category, name`
  const ids = products.map((p: any) => p.id)
  const variants = ids.length ? await sql`SELECT * FROM uni_variants WHERE product_id IN ${sql(ids)} AND deleted_at IS NULL ORDER BY sort, id` : []
  return products.map((p: any) => {
    const vs = variants.filter((v: any) => v.product_id === p.id).map((v: any) => ({ id: v.id, sku: v.sku, size: v.size, color: v.color, qty: v.qty, status: stockStatus(v.qty, p.min_qty) }))
    return { id: p.id, name: p.name, code: p.code, category: p.category, unit: p.unit, min: p.min_qty, total: vs.reduce((s: number, v: any) => s + v.qty, 0), variants: vs }
  })
}

app.get("/api/stock", async (c) => {
  const products = await productsWithStock()
  const all = products.flatMap((p: any) => p.variants)
  const summary = { skus: all.length, ok: all.filter((v: any) => v.status === "ok").length, low: all.filter((v: any) => v.status === "low").length, out: all.filter((v: any) => v.status === "out").length }
  return c.json({ products, summary })
})

app.get("/api/stock/:id", async (c) => {
  const id = int(c.req.param("id"))
  const [p] = await productsWithStock(id)
  if (!p) return bad(c, "ไม่พบสินค้า", 404)
  const page = Math.max(1, int(c.req.query("page") ?? 1) || 1), size = 100
  const moves = await sql`SELECT * FROM uni_moves WHERE product_id = ${id} ORDER BY at DESC, id DESC LIMIT ${size + 1} OFFSET ${(page - 1) * size}`
  return c.json({ product: p, moves: moves.slice(0, size), page, hasMore: moves.length > size })
})

type VariantIn = { id?: number; sku: string; size: string; color: string; qty?: number }
function cleanVariants(raw: any): VariantIn[] | string {
  const list = Array.isArray(raw) ? raw : []
  const out: VariantIn[] = []
  for (const r of list) {
    const sku = str(r?.sku, 60), size = str(r?.size, 30), color = str(r?.color, 40)
    if (!sku) return "ทุก SKU ต้องมีรหัส SKU"
    const qty = r?.qty === undefined || r?.qty === "" ? 0 : int(r.qty)
    if (!Number.isInteger(qty) || qty < 0) return `ยอดตั้งต้นของ ${sku} ต้องเป็นจำนวนเต็มตั้งแต่ 0`
    out.push({ id: r?.id ? int(r.id) : undefined, sku, size, color, qty })
  }
  const skus = out.map((v) => v.sku.toLowerCase())
  if (new Set(skus).size !== skus.length) return "มีรหัส SKU ซ้ำกัน"
  return out
}

async function skuTaken(tx: any, sku: string, exceptVariantId?: number): Promise<boolean> {
  const [r] = await tx`SELECT id FROM uni_variants WHERE lower(sku) = lower(${sku}) AND deleted_at IS NULL AND id <> ${exceptVariantId ?? 0}`
  return !!r
}

app.post("/api/products", async (c) => {
  const me = requireUser(c)!
  const b = await c.req.json().catch(() => ({}))
  const name = str(b.name, 120), code = str(b.code, 30).toUpperCase(), category = str(b.category, 60), unit = str(b.unit, 20) || "ชิ้น"
  const min = b.min === undefined || b.min === "" ? 5 : int(b.min)
  if (!name || !code) return bad(c, "กรุณากรอกชื่อสินค้าและรหัสสินค้า")
  if (!Number.isInteger(min) || min < 0) return bad(c, "เกณฑ์ใกล้หมดต้องเป็นจำนวนเต็มตั้งแต่ 0")
  const variants = cleanVariants(b.variants)
  if (typeof variants === "string") return bad(c, variants)
  if (!variants.length) return bad(c, "กรุณาเพิ่มอย่างน้อย 1 SKU")
  try {
    const id = await sql.begin(async (tx) => {
      const [dup] = await tx`SELECT 1 FROM uni_products WHERE lower(code) = lower(${code}) AND deleted_at IS NULL`
      if (dup) throw new Error("รหัสสินค้านี้มีอยู่แล้ว")
      const [p] = await tx`INSERT INTO uni_products (name, code, category, unit, min_qty) VALUES (${name}, ${code}, ${category}, ${unit}, ${min}) RETURNING id`
      let sort = 0
      for (const v of variants) {
        if (await skuTaken(tx, v.sku)) throw new Error(`SKU ${v.sku} มีอยู่แล้วในสินค้าอื่น`)
        const [nv] = await tx`INSERT INTO uni_variants (product_id, sku, size, color, qty, sort) VALUES (${p.id}, ${v.sku}, ${v.size}, ${v.color}, ${v.qty ?? 0}, ${sort++}) RETURNING id`
        if (v.qty) await tx`INSERT INTO uni_moves (product_id, variant_id, product_name, sku, size, color, type, qty, balance, ref, who, by_user)
          VALUES (${p.id}, ${nv.id}, ${name}, ${v.sku}, ${v.size}, ${v.color}, 'in', ${v.qty}, ${v.qty}, 'ยอดตั้งต้น', ${me.name}, ${me.id})`
      }
      return p.id
    })
    return c.json({ id })
  } catch (e: any) { return bad(c, e.message) }
})

// Edit product info + SKU labels, add new SKUs (with opening qty). Existing
// SKU quantities can't be changed here — only via receive / adjust.
app.put("/api/products/:id", async (c) => {
  const me = requireUser(c)!
  const id = int(c.req.param("id"))
  const b = await c.req.json().catch(() => ({}))
  const name = str(b.name, 120), code = str(b.code, 30).toUpperCase(), category = str(b.category, 60), unit = str(b.unit, 20) || "ชิ้น"
  const min = int(b.min)
  if (!name || !code) return bad(c, "กรุณากรอกชื่อสินค้าและรหัสสินค้า")
  if (!Number.isInteger(min) || min < 0) return bad(c, "เกณฑ์ใกล้หมดต้องเป็นจำนวนเต็มตั้งแต่ 0")
  const variants = cleanVariants(b.variants)
  if (typeof variants === "string") return bad(c, variants)
  try {
    await sql.begin(async (tx) => {
      const [p] = await tx`SELECT id FROM uni_products WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`
      if (!p) throw new Error("ไม่พบสินค้า")
      const [dup] = await tx`SELECT 1 FROM uni_products WHERE lower(code) = lower(${code}) AND deleted_at IS NULL AND id <> ${id}`
      if (dup) throw new Error("รหัสสินค้านี้มีอยู่แล้ว")
      await tx`UPDATE uni_products SET name = ${name}, code = ${code}, category = ${category}, unit = ${unit}, min_qty = ${min}, updated_at = NOW() WHERE id = ${id}`
      const current = await tx`SELECT id FROM uni_variants WHERE product_id = ${id} AND deleted_at IS NULL`
      let sort = 0
      for (const v of variants) {
        if (v.id) {
          if (!current.some((r: any) => r.id === v.id)) throw new Error("SKU ไม่ถูกต้อง")
          if (await skuTaken(tx, v.sku, v.id)) throw new Error(`SKU ${v.sku} ซ้ำกับที่มีอยู่แล้ว`)
          await tx`UPDATE uni_variants SET sku = ${v.sku}, size = ${v.size}, color = ${v.color}, sort = ${sort++} WHERE id = ${v.id}`
        } else {
          if (await skuTaken(tx, v.sku)) throw new Error(`SKU ${v.sku} ซ้ำกับที่มีอยู่แล้ว`)
          const [nv] = await tx`INSERT INTO uni_variants (product_id, sku, size, color, qty, sort) VALUES (${id}, ${v.sku}, ${v.size}, ${v.color}, ${v.qty ?? 0}, ${sort++}) RETURNING id`
          if (v.qty) await tx`INSERT INTO uni_moves (product_id, variant_id, product_name, sku, size, color, type, qty, balance, ref, who, by_user)
            VALUES (${id}, ${nv.id}, ${name}, ${v.sku}, ${v.size}, ${v.color}, 'in', ${v.qty}, ${v.qty}, 'ยอดตั้งต้น', ${me.name}, ${me.id})`
        }
      }
    })
    return c.json({ ok: true })
  } catch (e: any) { return bad(c, e.message) }
})

app.delete("/api/products/:id", async (c) => {
  const id = int(c.req.param("id"))
  await sql.begin(async (tx) => {
    await tx`UPDATE uni_products SET deleted_at = NOW() WHERE id = ${id} AND deleted_at IS NULL`
    await tx`UPDATE uni_variants SET deleted_at = NOW() WHERE product_id = ${id} AND deleted_at IS NULL`
  })
  return c.json({ ok: true })
})

app.delete("/api/variants/:id", async (c) => {
  const id = int(c.req.param("id"))
  const [v] = await sql`UPDATE uni_variants SET deleted_at = NOW() WHERE id = ${id} AND deleted_at IS NULL AND qty = 0 RETURNING id`
  if (!v) return bad(c, "ลบได้เฉพาะ SKU ที่ยอดคงเหลือเป็น 0")
  return c.json({ ok: true })
})

// Receive (+qty) or adjust to a counted quantity (±diff, reason required).
async function changeQty(c: any, kind: "in" | "adj") {
  const me = requireUser(c)!
  const id = int(c.req.param("id"))
  const b = await c.req.json().catch(() => ({}))
  try {
    const result = await sql.begin(async (tx) => {
      const [v] = await tx`
        SELECT v.*, p.name AS product_name FROM uni_variants v JOIN uni_products p ON p.id = v.product_id
        WHERE v.id = ${id} AND v.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF v`
      if (!v) throw new Error("ไม่พบ SKU")
      let diff: number, ref: string, note: string
      if (kind === "in") {
        diff = int(b.qty)
        if (!Number.isInteger(diff) || diff <= 0) throw new Error("จำนวนรับเข้าต้องเป็นจำนวนเต็มมากกว่า 0")
        ref = str(b.ref, 80); note = str(b.note, 300)
      } else {
        const counted = int(b.counted)
        if (!Number.isInteger(counted) || counted < 0) throw new Error("ยอดนับจริงต้องเป็นจำนวนเต็มตั้งแต่ 0")
        note = str(b.reason, 300)
        if (!note) throw new Error("กรุณาระบุเหตุผลการปรับยอด")
        diff = counted - v.qty; ref = "ปรับยอด"
        if (diff === 0) throw new Error("ยอดนับจริงเท่ากับยอดในระบบ ไม่ต้องปรับ")
      }
      const balance = v.qty + diff
      await tx`UPDATE uni_variants SET qty = ${balance} WHERE id = ${id}`
      await tx`INSERT INTO uni_moves (product_id, variant_id, product_name, sku, size, color, type, qty, balance, ref, who, note, by_user)
        VALUES (${v.product_id}, ${id}, ${v.product_name}, ${v.sku}, ${v.size}, ${v.color}, ${kind}, ${diff}, ${balance}, ${ref}, ${me.name}, ${note}, ${me.id})`
      return { balance }
    })
    return c.json(result)
  } catch (e: any) { return bad(c, e.message) }
}
app.post("/api/variants/:id/receive", (c) => changeQty(c, "in"))
app.post("/api/variants/:id/adjust", (c) => changeQty(c, "adj"))

// ---------- requests ----------
app.post("/api/requests", async (c) => {
  const me = requireUser(c)!
  const b = await c.req.json().catch(() => ({}))
  const settings = await getSettings()
  const f = {
    req_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.req_date)) ? String(b.req_date) : bkkToday(),
    name: str(b.name, 100), emp_code: str(b.emp_code, 40), position: str(b.position, 100), dept: str(b.dept, 100),
    phone: str(b.phone, 30), branch: str(b.branch, 100), type: str(b.type, 40), note: str(b.note, 500),
  }
  if (!f.name || !f.emp_code || !f.position || !f.branch) return bad(c, "กรุณากรอกข้อมูลที่บังคับให้ครบ")
  if (settings.branches.length && !settings.branches.includes(f.branch)) return bad(c, "กรุณาเลือกสาขาจากรายการ")
  if (!REQUEST_TYPES.includes(f.type)) return bad(c, "กรุณาเลือกประเภทการเบิก")
  const rawLines = Array.isArray(b.lines) ? b.lines : []
  const want = new Map<number, number>()
  for (const l of rawLines) {
    const vid = int(l?.variant_id), qty = int(l?.qty)
    if (!Number.isInteger(vid) || !Number.isInteger(qty) || qty <= 0 || qty > 999) return bad(c, "จำนวนที่ขอเบิกต้องเป็นจำนวนเต็ม 1–999")
    want.set(vid, (want.get(vid) ?? 0) + qty)
  }
  if (!want.size) return bad(c, "กรุณาเพิ่มรายการที่ขอเบิกอย่างน้อย 1 รายการ")
  if (want.size > 30) return bad(c, "ขอเบิกได้สูงสุด 30 รายการต่อคำขอ")
  const vs = await sql`
    SELECT v.id, v.sku, v.size, v.color, p.id AS product_id, p.name, p.category, p.unit
    FROM uni_variants v JOIN uni_products p ON p.id = v.product_id
    WHERE v.id IN ${sql([...want.keys()])} AND v.deleted_at IS NULL AND p.deleted_at IS NULL`
  if (vs.length !== want.size) return bad(c, "มีรายการที่ไม่พบในระบบ กรุณาเลือกใหม่")
  const no = await sql.begin(async (tx) => {
    const no = await nextNo(tx, `REQ-${thaiDateStamp()}`)
    const [r] = await tx`INSERT INTO uni_requests (no, req_date, name, emp_code, position, dept, branch, phone, type, note, requester_id)
      VALUES (${no}, ${f.req_date}, ${f.name}, ${f.emp_code}, ${f.position}, ${f.dept}, ${f.branch}, ${f.phone}, ${f.type}, ${f.note}, ${me.id}) RETURNING id`
    for (const v of vs) await tx`INSERT INTO uni_request_lines (request_id, product_id, variant_id, product_name, category, unit, sku, size, color, qty)
      VALUES (${r.id}, ${v.product_id}, ${v.id}, ${v.name}, ${v.category}, ${v.unit}, ${v.sku}, ${v.size}, ${v.color}, ${want.get(v.id)!})`
    // Remember the requester's details for the next form.
    await tx`UPDATE uni_users SET phone = ${f.phone}, position = ${f.position}, dept = ${f.dept}, branch = ${f.branch} WHERE id = ${me.id}`
    return no
  })
  return c.json({ no })
})

app.get("/api/requests", async (c) => {
  const me = requireUser(c)!
  const hr = me.role === "hr"
  const mine = !hr || c.req.query("mine") === "1"
  const status = str(c.req.query("status"), 20)
  const page = Math.max(1, int(c.req.query("page") ?? 1) || 1), size = 30
  const conds = [sql`TRUE`]
  if (mine) conds.push(sql`requester_id = ${me.id}`)
  const where = conds.reduce((a, b) => sql`${a} AND ${b}`)
  const counts = await sql`SELECT status, count(*)::int AS n FROM uni_requests WHERE ${where} GROUP BY status`
  const rows = await sql`
    SELECT * FROM uni_requests WHERE ${where} ${status && status !== "all" ? sql`AND status = ${status}` : sql``}
    ORDER BY created_at DESC LIMIT ${size + 1} OFFSET ${(page - 1) * size}`
  const list = rows.slice(0, size)
  const ids = list.map((r: any) => r.id)
  const lines = ids.length ? await sql`SELECT * FROM uni_request_lines WHERE request_id IN ${sql(ids)} ORDER BY id` : []
  // HR sees live stock next to pending lines (employees never do).
  let stock = new Map<number, number>()
  if (hr) {
    const vids = [...new Set(lines.filter((l: any) => list.find((r: any) => r.id === l.request_id)?.status === "pending").map((l: any) => l.variant_id))]
    if (vids.length) for (const v of await sql`SELECT id, qty FROM uni_variants WHERE id IN ${sql(vids)} AND deleted_at IS NULL`) stock.set(v.id, v.qty)
  }
  return c.json({
    counts: Object.fromEntries(counts.map((r: any) => [r.status, r.n])),
    page, hasMore: rows.length > size,
    requests: list.map((r: any) => ({
      ...r,
      mine: r.requester_id === me.id,
      lines: lines.filter((l: any) => l.request_id === r.id).map((l: any) => hr && r.status === "pending" ? { ...l, available: stock.get(l.variant_id) ?? 0 } : l),
    })),
  })
})

app.post("/api/requests/:no/cancel", async (c) => {
  const me = requireUser(c)!
  const [r] = await sql`UPDATE uni_requests SET status = 'cancelled', decided_at = NOW(), decider_id = ${me.id}
    WHERE no = ${c.req.param("no")} AND requester_id = ${me.id} AND status = 'pending' RETURNING no`
  if (!r) return bad(c, "ยกเลิกได้เฉพาะคำขอของตนเองที่ยังรออนุมัติ")
  return c.json({ ok: true })
})

app.post("/api/requests/:no/reject", hrOnly, async (c) => {
  const me = requireUser(c)!
  const b = await c.req.json().catch(() => ({}))
  const note = str(b.note, 500)
  if (!note) return bad(c, "กรุณาระบุเหตุผลที่ไม่อนุมัติ")
  const [r] = await sql`UPDATE uni_requests SET status = 'rejected', decision_note = ${note}, decided_at = NOW(), decider_id = ${me.id}
    WHERE no = ${c.req.param("no")} AND status = 'pending' RETURNING no`
  if (!r) return bad(c, "คำขอนี้ไม่ได้อยู่ในสถานะรออนุมัติแล้ว")
  return c.json({ ok: true })
})

// Approve = cut stock + write movements + issue DN, all-or-nothing. The
// request row and every variant row are locked first (variants in id order
// so two approvals can't deadlock), quantities re-checked under the lock,
// and the qty >= 0 CHECK is the last line of defence.
app.post("/api/requests/:no/approve", hrOnly, async (c) => {
  const me = requireUser(c)!
  try {
    const dn = await sql.begin(async (tx) => {
      const [r] = await tx`SELECT * FROM uni_requests WHERE no = ${c.req.param("no")} FOR UPDATE`
      if (!r || r.status !== "pending") throw new Error("คำขอนี้ไม่ได้อยู่ในสถานะรออนุมัติแล้ว")
      const lines = await tx`SELECT * FROM uni_request_lines WHERE request_id = ${r.id} ORDER BY variant_id`
      const vids = lines.map((l: any) => l.variant_id)
      const vs = await tx`SELECT id, qty, deleted_at FROM uni_variants WHERE id IN ${tx(vids)} ORDER BY id FOR UPDATE`
      const short: string[] = []
      for (const l of lines) {
        const v = vs.find((x: any) => x.id === l.variant_id)
        if (!v || v.deleted_at) short.push(`${l.sku} (ถูกลบแล้ว)`)
        else if (v.qty < l.qty) short.push(`${l.sku} ต้องการ ${l.qty} คงเหลือ ${v.qty}`)
      }
      if (short.length) throw new Error("สต๊อกไม่พอ: " + short.join(", "))
      const dnNo = await nextNo(tx, `DN-${thaiDateStamp()}`)
      for (const l of lines) {
        const [v] = await tx`UPDATE uni_variants SET qty = qty - ${l.qty} WHERE id = ${l.variant_id} RETURNING qty`
        await tx`INSERT INTO uni_moves (product_id, variant_id, product_name, sku, size, color, type, qty, balance, ref, who, branch, note, by_user)
          VALUES (${l.product_id}, ${l.variant_id}, ${l.product_name}, ${l.sku}, ${l.size}, ${l.color}, 'out', ${-l.qty}, ${v.qty}, ${dnNo},
                  ${`${r.name} (${r.emp_code})`}, ${r.branch}, ${r.no}, ${me.id})`
      }
      await tx`UPDATE uni_requests SET status = 'approved', dn_no = ${dnNo}, approved_at = NOW(), approver_id = ${me.id}, approver_name = ${me.name},
        decided_at = NOW(), decider_id = ${me.id} WHERE id = ${r.id}`
      return dnNo
    })
    return c.json({ dn: dn })
  } catch (e: any) {
    if (String(e?.message).includes("check constraint")) return bad(c, "สต๊อกไม่พอ (มีการเบิกพร้อมกัน) กรุณาลองใหม่")
    return bad(c, e.message)
  }
})

app.post("/api/requests/:no/ship", hrOnly, async (c) => {
  const me = requireUser(c)!
  const [r] = await sql`UPDATE uni_requests SET status = 'shipped', shipped_at = NOW(), shipper_id = ${me.id}
    WHERE no = ${c.req.param("no")} AND status = 'approved' RETURNING no`
  if (!r) return bad(c, "ยืนยันจัดส่งได้เฉพาะคำขอที่รอจัดส่ง")
  return c.json({ ok: true })
})

// ---------- history (approved + shipped lines) ----------
function historyWhere(me: User, q: { q?: string; branch?: string; category?: string }) {
  const conds = [sql`r.status IN ('approved', 'shipped')`]
  if (me.role !== "hr") conds.push(sql`r.requester_id = ${me.id}`)
  if (q.branch) conds.push(sql`r.branch = ${q.branch}`)
  if (q.category) conds.push(sql`l.category = ${q.category}`)
  if (q.q) {
    const like = "%" + q.q + "%"
    conds.push(sql`(r.name ILIKE ${like} OR r.emp_code ILIKE ${like} OR r.position ILIKE ${like} OR r.no ILIKE ${like} OR r.dn_no ILIKE ${like})`)
  }
  return conds.reduce((a, b) => sql`${a} AND ${b}`)
}
function historyQuery(c: any) {
  return { q: str(c.req.query("q"), 100), branch: str(c.req.query("branch"), 100), category: str(c.req.query("category"), 60) }
}

app.get("/api/history", async (c) => {
  const me = requireUser(c)!
  const where = historyWhere(me, historyQuery(c))
  const page = Math.max(1, int(c.req.query("page") ?? 1) || 1), size = 100
  const rows = await sql`
    SELECT r.no, r.dn_no, r.approved_at, r.req_date, r.name, r.emp_code, r.position, r.dept, r.branch, r.type, r.status,
           l.product_name, l.category, l.sku, l.size, l.color, l.qty, l.unit
    FROM uni_request_lines l JOIN uni_requests r ON r.id = l.request_id
    WHERE ${where} ORDER BY r.approved_at DESC, l.id LIMIT ${size + 1} OFFSET ${(page - 1) * size}`
  const [sum] = await sql`
    SELECT COALESCE(sum(l.qty), 0)::int AS pieces, count(DISTINCT r.emp_code)::int AS employees, count(DISTINCT r.branch)::int AS branches
    FROM uni_request_lines l JOIN uni_requests r ON r.id = l.request_id WHERE ${where}`
  const byBranch = await sql`
    SELECT r.branch, sum(l.qty)::int AS pieces FROM uni_request_lines l JOIN uni_requests r ON r.id = l.request_id
    WHERE ${where} GROUP BY r.branch ORDER BY pieces DESC LIMIT 8`
  const categories = await sql`SELECT DISTINCT category FROM uni_request_lines WHERE category <> '' ORDER BY category`
  return c.json({ rows: rows.slice(0, size), page, hasMore: rows.length > size, summary: sum, byBranch, categories: categories.map((r: any) => r.category) })
})

app.get("/api/history.csv", async (c) => {
  const me = requireUser(c)!
  const where = historyWhere(me, historyQuery(c))
  const rows = await sql`
    SELECT r.approved_at, r.no, r.dn_no, r.name, r.emp_code, r.position, r.dept, r.branch, r.type, r.status,
           l.product_name, l.category, l.sku, l.size, l.color, l.qty, l.unit
    FROM uni_request_lines l JOIN uni_requests r ON r.id = l.request_id
    WHERE ${where} ORDER BY r.approved_at DESC, l.id`
  const cell = (v: any) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s }
  const head = ["วันที่อนุมัติ", "เลขคำขอ", "เลข DN", "ชื่อ-นามสกุล", "รหัสพนักงาน", "ตำแหน่ง", "แผนก", "สาขา", "ประเภทการเบิก", "สถานะ", "รายการ", "หมวด", "SKU", "ไซส์", "สี", "จำนวน", "หน่วย"]
  const status: Record<string, string> = { approved: "รอจัดส่ง", shipped: "จัดส่งแล้ว" }
  const lines = rows.map((r: any) => [thaiDate(r.approved_at), r.no, r.dn_no, r.name, r.emp_code, r.position, r.dept, r.branch, r.type, status[r.status] ?? r.status, r.product_name, r.category, r.sku, r.size, r.color, r.qty, r.unit].map(cell).join(","))
  const body = "﻿" + [head.join(","), ...lines].join("\r\n")
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="uniform-history-${bkkToday()}.csv"` } })
})

// ---------- users (HR) ----------
app.get("/api/users", hrOnly, async (c) => c.json(await sql`SELECT id, emp_code, name, role, position, branch, disabled, created_at FROM uni_users ORDER BY role, name`))
app.put("/api/users/:id", hrOnly, async (c) => {
  const me = requireUser(c)!
  const id = int(c.req.param("id"))
  const b = await c.req.json().catch(() => ({}))
  if (id === me.id && (b.role === "employee" || b.disabled)) return bad(c, "เปลี่ยนสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้")
  if (b.role !== undefined && b.role !== "hr" && b.role !== "employee") return bad(c, "role ไม่ถูกต้อง")
  await sql`UPDATE uni_users SET role = COALESCE(${b.role ?? null}, role), disabled = COALESCE(${typeof b.disabled === "boolean" ? b.disabled : null}, disabled) WHERE id = ${id}`
  if (b.disabled) await sql`DELETE FROM uni_sessions WHERE user_id = ${id}`
  return c.json({ ok: true })
})
app.post("/api/users/:id/reset-password", hrOnly, async (c) => {
  const id = int(c.req.param("id"))
  const temp = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("")
  const [u] = await sql`UPDATE uni_users SET password_hash = ${await Bun.password.hash(temp)} WHERE id = ${id} RETURNING id`
  if (!u) return bad(c, "ไม่พบผู้ใช้", 404)
  await sql`DELETE FROM uni_sessions WHERE user_id = ${id}`
  return c.json({ password: temp })
})

// ---------- delivery note (printable page) ----------
app.get("/dn/:no", async (c) => {
  const me = requireUser(c)
  if (!me) return c.redirect("/")
  const [r] = await sql`SELECT * FROM uni_requests WHERE dn_no = ${c.req.param("no")}`
  if (!r || (me.role !== "hr" && r.requester_id !== me.id)) return c.text("ไม่พบใบส่งสินค้า", 404)
  const lines = await sql`SELECT * FROM uni_request_lines WHERE request_id = ${r.id} ORDER BY id`
  const s = await getSettings()
  const total = lines.reduce((t: number, l: any) => t + l.qty, 0)
  return c.html(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.dn_no)} — ใบส่งสินค้า</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box} body{font-family:Sarabun,sans-serif;color:#111;margin:0;background:#eef1f3}
  .bar{max-width:210mm;margin:16px auto 0;display:flex;gap:8px;justify-content:flex-end}
  .bar button,.bar a{font:600 14px Sarabun,sans-serif;padding:8px 16px;border-radius:8px;border:1px solid #0e7c86;background:#0e7c86;color:#fff;cursor:pointer;text-decoration:none}
  .bar a{background:#fff;color:#0e7c86}
  .page{width:210mm;min-height:297mm;margin:12px auto 24px;background:#fff;padding:16mm 15mm;box-shadow:0 2px 12px rgba(0,0,0,.12)}
  h1{font-size:22px;margin:0} .co{font-size:15px;font-weight:600;color:#333}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:12px}
  .meta td{padding:2px 0 2px 12px;font-size:14px} .meta td:first-child{color:#555;padding-left:0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .box{border:1px solid #bbb;border-radius:6px;padding:8px 10px;font-size:14px;line-height:1.6} .box b{display:block;font-size:13px;color:#555}
  table.items{width:100%;border-collapse:collapse;font-size:14px} .items th,.items td{border:1px solid #999;padding:6px 8px}
  .items th{background:#f1f3f4} .items td.n{text-align:right} .items td.c{text-align:center}
  .sign{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:48px;text-align:center;font-size:14px}
  .sign .line{border-top:1px dotted #333;margin-top:42px;padding-top:6px} .muted{color:#555;font-size:13px}
  @media print{body{background:#fff}.bar{display:none}.page{margin:0;box-shadow:none;width:auto;min-height:auto;padding:10mm}@page{size:A4;margin:8mm}}
</style></head><body>
<div class="bar"><a href="/#/requests">กลับ</a><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>
<div class="page">
  <div class="head">
    <div><div class="co">${esc(s.company || "ฝ่ายทรัพยากรบุคคล")}</div><h1>ใบส่งสินค้า (Delivery Note)</h1><div class="muted">ชุดยูนิฟอร์มพนักงาน</div></div>
    <table class="meta"><tr><td>เลขที่</td><td><b>${esc(r.dn_no)}</b></td></tr><tr><td>วันที่</td><td>${esc(thaiDate(r.approved_at))}</td></tr>
    <tr><td>อ้างอิงคำขอ</td><td>${esc(r.no)}</td></tr><tr><td>ประเภทการเบิก</td><td>${esc(r.type)}</td></tr></table>
  </div>
  <div class="grid">
    <div class="box"><b>ผู้รับ</b>${esc(r.name)} (รหัส ${esc(r.emp_code)})<br>ตำแหน่ง ${esc(r.position)}${r.dept ? ` · แผนก ${esc(r.dept)}` : ""}${r.phone ? `<br>โทร ${esc(r.phone)}` : ""}</div>
    <div class="box"><b>จัดส่งที่</b>สาขา ${esc(r.branch)}${r.note ? `<br>หมายเหตุ: ${esc(r.note)}` : ""}</div>
  </div>
  <table class="items"><thead><tr><th style="width:44px">ลำดับ</th><th>SKU</th><th>รายการ</th><th>ไซส์</th><th>สี</th><th style="width:90px">จำนวน</th></tr></thead><tbody>
  ${lines.map((l: any, i: number) => `<tr><td class="c">${i + 1}</td><td>${esc(l.sku)}</td><td>${esc(l.product_name)}</td><td class="c">${esc(l.size)}</td><td class="c">${esc(l.color)}</td><td class="n">${l.qty} ${esc(l.unit)}</td></tr>`).join("")}
  <tr><td colspan="5" class="n"><b>รวม</b></td><td class="n"><b>${total}</b></td></tr></tbody></table>
  <div class="sign">
    <div><div class="line">ผู้อนุมัติ (HR)</div><div class="muted">${esc(r.approver_name || "")}</div><div class="muted">วันที่ ${esc(thaiDate(r.approved_at))}</div></div>
    <div><div class="line">ผู้ส่งสินค้า</div><div class="muted">วันที่ ......../......../........</div></div>
    <div><div class="line">ผู้รับสินค้า</div><div class="muted">วันที่ ......../......../........</div></div>
  </div>
</div></body></html>`)
})

// ---------- static SPA ----------
app.get("/health", (c) => c.json({ ok: true }))
app.get("/app.js", () => new Response(Bun.file(import.meta.dir + "/../public/app.js"), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } }))
app.get("/style.css", () => new Response(Bun.file(import.meta.dir + "/../public/style.css"), { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" } }))
app.get("/", () => new Response(Bun.file(import.meta.dir + "/../public/index.html"), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } }))
app.notFound((c) => (c.req.path.startsWith("/api/") ? bad(c, "not found", 404) : c.text("404", 404)))
app.onError((err, c) => { console.error("[error]", err); return c.json({ error: "เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่" }, 500) })

await initDB()
console.log(`[uniform-stock] listening on :${PORT}${HR_SETUP_CODE ? "" : " (HR_SETUP_CODE not set — first HR account can't be created)"}`)
export default { port: PORT, fetch: app.fetch }
