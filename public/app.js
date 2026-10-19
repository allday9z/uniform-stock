/* Uniform stock & requisition — single-page client. All permission checks are
   repeated on the server; the UI only hides what a role can't use. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function thDate(d) { if (!d) return ""; var dt = new Date(d); return isNaN(dt) ? "" : dt.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }); }
  function thDateTime(d) { if (!d) return ""; var dt = new Date(d); return dt.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) + " " + dt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }); }
  function today() { var d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 10); }
  var STATUS = { ok: "พร้อมเบิก", low: "ใกล้หมด", out: "หมด" };
  var RSTATUS = { pending: "รออนุมัติ", approved: "รอจัดส่ง", shipped: "จัดส่งแล้ว", rejected: "ไม่อนุมัติ", cancelled: "ยกเลิก" };
  var MOVE = { in: ["รับเข้า", "in"], out: ["เบิกออก", "out2"], adj: ["ปรับยอด", "adj"] };

  var state = { me: null, settings: null };
  // "M (รอบอก 38 นิ้ว) / Green" — size dropdown shows the chest size when HR filled it in.
  function vlabel(v) { return [(v.size || "") + (v.chest ? " (รอบอก " + v.chest + ")" : ""), v.color].filter(Boolean).join(" / ") || v.sku; }
  function money(n) { return Number(n || 0).toLocaleString("th-TH"); }
  // Same rule as the server: "จำนวน=ราคา" lines; quantities not listed = qty × price of 1.
  function priceFor(qty) {
    var t = {}; String(state.settings.priceTable || "").split("\n").forEach(function (l) { var m = l.match(/^\s*(\d+)\s*[=:]\s*(\d+)\s*$/); if (m) t[Number(m[1])] = Number(m[2]); });
    return t[qty] != null ? t[qty] : qty * (t[1] != null ? t[1] : 230);
  }
  function typeOf(label) { return (state.settings.requestTypes || []).find(function (t) { return t.label === label; }); }
  function deliveryLine(r) {
    if (r.status === "shipped") return '<span class="badge shipped">จัดส่งแล้ว</span> วันที่ ' + thDate(r.shipped_date || r.shipped_at);
    if (r.status === "approved") return '<span class="badge approved">รอดำเนินการ</span>';
    if (r.status === "pending") return '<span class="muted">รออนุมัติ</span>';
    return '<span class="muted">—</span>';
  }

  async function api(path, opts) {
    opts = opts || {};
    var form = opts.body instanceof FormData;
    var res = await fetch(path, { method: opts.method || "GET", headers: opts.body && !form ? { "Content-Type": "application/json" } : {}, body: opts.body ? (form ? opts.body : JSON.stringify(opts.body)) : undefined });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && !/\/api\/auth\//.test(path)) { state.me = null; route(); throw new Error("กรุณาเข้าสู่ระบบ"); }
    if (!res.ok) throw new Error(data.error || "เกิดข้อผิดพลาด");
    return data;
  }
  function toast(msg) { var t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 3200); }
  function modal(html, wide) { var b = $("#modalBox"); b.className = "modal" + (wide ? " wide" : ""); b.innerHTML = html; $("#modal").hidden = false; return b; }
  function closeModal() { $("#modal").hidden = true; $("#modalBox").innerHTML = ""; }
  $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  function isHR() { return state.me && state.me.role === "hr"; }
  var app = $("#app");
  function setView(html) { app.innerHTML = html; window.scrollTo(0, 0); }
  function busy(btn, on) { if (btn) btn.disabled = on; }

  // ---------- shell ----------
  function renderShell() {
    var top = $("#top");
    if (!state.me) { top.hidden = true; return; }
    top.hidden = false;
    var links = isHR()
      ? [["#/stock", "สต๊อก"], ["#/requests", "คำขอเบิก"], ["#/new", "ขอเบิก / สั่งซื้อ"], ["#/history", "ประวัติการเบิก"], ["#/settings", "ตั้งค่า"], ["#/users", "ผู้ใช้งาน"]]
      : [["#/new", "ขอเบิก / สั่งซื้อ"], ["#/requests", "คำขอของฉัน"], ["#/history", "ประวัติการเบิก"]];
    var cur = location.hash.split("?")[0] || "#/";
    $("#nav").innerHTML = links.map(function (l) { return '<a href="' + l[0] + '" class="' + (cur.indexOf(l[0]) === 0 ? "on" : "") + '">' + l[1] + "</a>"; }).join("");
    $("#who").innerHTML = '<span>' + esc(state.me.name) + " · " + esc(state.me.emp_code) + '</span><span class="role">' + (isHR() ? "HR" : "พนักงาน") + '</span><button class="link" id="pwBtn">เปลี่ยนรหัสผ่าน</button><button class="link" id="logoutBtn">ออกจากระบบ</button>';
    $("#logoutBtn").onclick = async function () { await api("/api/auth/logout", { method: "POST" }); state.me = null; location.hash = "#/"; route(); };
    $("#pwBtn").onclick = changePassword;
  }
  $("#menuBtn").onclick = function () { $("#nav").classList.toggle("open"); $("#top").classList.toggle("open"); };

  function changePassword() {
    var b = modal('<h2>เปลี่ยนรหัสผ่าน</h2><div class="field"><label class="f">รหัสผ่านปัจจุบัน</label><input class="i" type="password" id="pwCur"></div><div class="field"><label class="f">รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)</label><input class="i" type="password" id="pwNew"></div><div class="err" id="pwErr"></div><div class="actions"><button class="btn ghost" id="c">ยกเลิก</button><button class="btn" id="ok">บันทึก</button></div>');
    $("#c", b).onclick = closeModal;
    $("#ok", b).onclick = async function () {
      try { await api("/api/me/password", { method: "POST", body: { current: $("#pwCur").value, next: $("#pwNew").value } }); closeModal(); toast("เปลี่ยนรหัสผ่านแล้ว"); }
      catch (e) { $("#pwErr").textContent = e.message; }
    };
  }

  // ---------- auth ----------
  async function viewAuth(mode) {
    var setup = (await api("/api/auth/needs-setup")).needsSetup;
    var logo = '<div class="logo"><svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 6.6 16 4l-1.2 1.6a3.5 3.5 0 0 1-5.6 0L8 4 3.6 6.6a1 1 0 0 0-.4 1.3l1.5 3a1 1 0 0 0 1.3.5L7 11v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-9l1 .4a1 1 0 0 0 1.3-.5l1.5-3a1 1 0 0 0-.4-1.3Z"/></svg></div>';
    if (mode === "setup") {
      setView('<div class="auth card">' + logo + '<h1>ตั้งค่าบัญชี HR แรก</h1><p class="sub">ใช้รหัสตั้งค่าที่ได้รับจากผู้ดูแลระบบ (ใช้ได้ครั้งเดียวจนกว่าจะมีบัญชี HR)</p>' +
        field("รหัสตั้งค่า", '<input class="i" id="sc" autocomplete="off">', true) + field("รหัสพนักงาน", '<input class="i" id="ec">', true) + field("ชื่อ-นามสกุล", '<input class="i" id="nm">', true) +
        field("รหัสผ่าน (อย่างน้อย 6 ตัวอักษร)", '<input class="i" id="pw" type="password">', true) + '<div class="err" id="err"></div><button class="btn" style="width:100%" id="go">สร้างบัญชี HR</button>' +
        '<div class="switch"><a href="#/login">กลับไปหน้าเข้าสู่ระบบ</a></div></div>');
      $("#go").onclick = async function () {
        try { await api("/api/auth/setup-hr", { method: "POST", body: { setup_code: $("#sc").value, emp_code: $("#ec").value, name: $("#nm").value, password: $("#pw").value } }); await boot(); location.hash = "#/settings"; }
        catch (e) { $("#err").textContent = e.message; }
      };
      return;
    }
    if (mode === "register") {
      setView('<div class="auth card">' + logo + '<h1>ลงทะเบียนพนักงาน</h1><p class="sub">ใช้รหัสพนักงานเป็นชื่อผู้ใช้สำหรับเข้าสู่ระบบ</p>' +
        field("รหัสพนักงาน", '<input class="i" id="ec" autocomplete="username">', true) + field("ชื่อ-นามสกุล", '<input class="i" id="nm" autocomplete="name">', true) +
        field("ตั้งรหัสผ่าน (อย่างน้อย 6 ตัวอักษร)", '<input class="i" id="pw" type="password" autocomplete="new-password">', true) +
        '<div class="err" id="err"></div><button class="btn" style="width:100%" id="go">ลงทะเบียน</button><div class="switch">มีบัญชีแล้ว? <a href="#/login">เข้าสู่ระบบ</a></div></div>');
      $("#go").onclick = async function () {
        try { await api("/api/auth/register", { method: "POST", body: { emp_code: $("#ec").value, name: $("#nm").value, password: $("#pw").value } }); await boot(); location.hash = "#/new"; }
        catch (e) { $("#err").textContent = e.message; }
      };
      return;
    }
    setView('<div class="auth card">' + logo + '<h1>ระบบเบิกจ่ายชุดยูนิฟอร์ม</h1><p class="sub">เข้าสู่ระบบด้วยรหัสพนักงาน</p>' +
      field("รหัสพนักงาน", '<input class="i" id="ec" autocomplete="username">', false) + field("รหัสผ่าน", '<input class="i" id="pw" type="password" autocomplete="current-password">', false) +
      '<div class="err" id="err"></div><button class="btn" style="width:100%" id="go">เข้าสู่ระบบ</button>' +
      '<div class="switch">ยังไม่มีบัญชี? <a href="#/register">ลงทะเบียนพนักงาน</a> · ลืมรหัสผ่านติดต่อ HR</div>' +
      (setup ? '<div class="switch"><a href="#/setup">ตั้งค่าบัญชี HR แรก</a></div>' : "") + "</div>");
    var go = async function () {
      try { await api("/api/auth/login", { method: "POST", body: { emp_code: $("#ec").value, password: $("#pw").value } }); await boot(); location.hash = isHR() ? "#/requests" : "#/new"; }
      catch (e) { $("#err").textContent = e.message; }
    };
    $("#go").onclick = go; $("#pw").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }
  function field(label, input, req) { return '<div class="field"><label class="f' + (req ? " req" : "") + '">' + label + "</label>" + input + "</div>"; }

  // ---------- stock (HR) ----------
  // % issued = issued ÷ (issued + remaining)
  function pct(issued, remaining) { var t = issued + remaining; return t ? (Math.round(issued / t * 1000) / 10) + "%" : "—"; }
  function issuedBar(issued, remaining, title, unit) {
    var t = issued + remaining, w = t ? Math.round(issued / t * 100) : 0;
    return '<div class="' + (title ? "card issued" : "issued") + '">' + (title ? "<b>" + title + "</b> " : "") + 'เบิกไปแล้ว <b>' + issued + "</b> จากทั้งหมด " + t + (unit ? " " + esc(unit) : "") + " (คงเหลือ " + remaining + ') · <b class="pctv">' + pct(issued, remaining) + '</b><div class="track"><div class="fill" style="width:' + w + '%"></div></div></div>';
  }
  // Per-size table for one product: คงเหลือ / เบิกไปแล้ว / % เบิก (+ total column and bar).
  function sizeTable(p) {
    var vs = p.variants;
    var colors = vs.map(function (v) { return v.color; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; });
    var head = function (v) { return esc((v.size || v.sku) + (colors.length > 1 && v.color ? " / " + v.color : "")) + (v.chest ? "<small>" + esc(v.chest) + "</small>" : ""); };
    return '<div class="scroll"><table class="t sizes"><thead><tr><th></th>' + vs.map(function (v) { return "<th>" + head(v) + "</th>"; }).join("") + '<th class="tot">รวม</th></tr></thead><tbody>' +
      '<tr><th>คงเหลือ</th>' + vs.map(function (v) { return '<td><span class="chip ' + v.status + '" title="' + esc(v.sku) + " · " + STATUS[v.status] + '">' + v.qty + "</span></td>"; }).join("") + '<td class="tot">' + p.total + "</td></tr>" +
      '<tr><th>เบิกไปแล้ว</th>' + vs.map(function (v) { return "<td>" + v.issued + "</td>"; }).join("") + '<td class="tot">' + p.issued + "</td></tr>" +
      '<tr><th>% เบิก</th>' + vs.map(function (v) { return "<td>" + pct(v.issued, v.qty) + "</td>"; }).join("") + '<td class="tot">' + pct(p.issued, p.total) + "</td></tr>" +
      "</tbody></table></div>" + issuedBar(p.issued, p.total, null, p.unit);
  }
  async function viewStock(q) {
    var data = await api("/api/stock");
    var filter = q.f || "", search = (q.s || "").toLowerCase();
    var s = data.summary;
    var cards = [["", "SKU ทั้งหมด", s.skus], ["ok", "พร้อมเบิก", s.ok], ["low", "ใกล้หมด", s.low], ["out", "หมด", s.out]];
    var list = data.products.filter(function (p) {
      var hay = (p.name + " " + p.code + " " + p.category + " " + p.variants.map(function (v) { return v.sku; }).join(" ")).toLowerCase();
      if (search && hay.indexOf(search) === -1) return false;
      if (filter && !p.variants.some(function (v) { return v.status === filter; })) return false;
      return true;
    });
    setView('<div class="row"><div><h1>สต๊อกชุดยูนิฟอร์ม</h1><p class="sub">ยอดคงเหลือแยกตาม SKU (ไซส์ × สี) — กดที่สินค้าเพื่อดูความเคลื่อนไหว</p></div><div class="spacer"></div><button class="btn" id="add">+ เพิ่มสินค้า</button></div>' +
      '<div class="summary">' + cards.map(function (c) { return '<button class="sum ' + c[0] + (filter === c[0] && (c[0] || !filter) ? " on" : "") + '" data-f="' + c[0] + '"><b>' + c[2] + "</b><span>" + c[1] + "</span></button>"; }).join("") + "</div>" +
      '<div class="card" style="padding:12px 14px"><input class="i" id="search" placeholder="ค้นหาชื่อสินค้า รหัสสินค้า หรือ SKU" value="' + esc(q.s || "") + '"></div>' +
      (list.length ? '<div class="products">' + list.map(function (p) {
        var vs = filter ? p.variants.filter(function (v) { return v.status === filter; }) : p.variants;
        return '<div class="prod" data-id="' + p.id + '"><div class="total"><b>' + p.total + "</b>" + esc(p.unit) + "คงเหลือ</div><h3>" + esc(p.name) + '</h3><div class="meta">' + esc(p.code) + (p.category ? " · " + esc(p.category) : "") + " · ใกล้หมดเมื่อ ≤ " + p.min + '</div><div class="chips">' +
          vs.map(function (v) { return '<span class="chip ' + v.status + '" title="' + esc(v.sku) + " · " + STATUS[v.status] + (v.chest ? " · รอบอก " + esc(v.chest) : "") + '">' + esc([v.size, v.color].filter(Boolean).join(" / ") || v.sku) + " · " + v.qty + "</span>"; }).join("") + "</div></div>";
      }).join("") + "</div>" : '<div class="card empty">' + (data.products.length ? "ไม่พบสินค้าที่ตรงกับเงื่อนไข" : "ยังไม่มีสินค้า — กด \"+ เพิ่มสินค้า\" เพื่อเริ่มต้น") + "</div>"));
    $$(".sum").forEach(function (b) { b.onclick = function () { nav("#/stock", { f: b.dataset.f, s: $("#search").value }); }; });
    $("#search").addEventListener("input", debounce(function () { nav("#/stock", { f: filter, s: $("#search").value }, true); }, 300));
    $$(".prod").forEach(function (el) { el.onclick = function () { location.hash = "#/stock/" + el.dataset.id; }; });
    $("#add").onclick = function () { productEditor(null); };
    if (q.s) { var si = $("#search"); si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
  }

  async function viewProduct(id, q) {
    var page = Number(q.page || 1);
    var d = await api("/api/stock/" + id + "?page=" + page);
    var p = d.product;
    setView('<p class="small"><a href="#/stock">← สต๊อก</a></p><div class="row"><div><h1>' + esc(p.name) + '</h1><p class="sub">' + esc(p.code) + (p.category ? " · " + esc(p.category) : "") + " · หน่วย " + esc(p.unit) + " · ใกล้หมดเมื่อ ≤ " + p.min + " · คงเหลือรวม <b>" + p.total + "</b></p></div><div class=\"spacer\"></div>" +
      '<button class="btn ghost" id="edit">แก้ไขสินค้า / เพิ่ม SKU</button><button class="btn danger" id="del">ลบสินค้า</button></div>' +
      '<div class="card"><h3 style="margin-top:0">สรุปคงเหลือ / การเบิก แยกตามไซส์</h3>' + sizeTable(p) + "</div>" +
      '<div class="card"><h3 style="margin-top:0">SKU</h3><div class="scroll"><table class="t"><thead><tr><th>รหัส SKU</th><th>ไซส์</th><th>รอบอก</th><th>สี</th><th class="n">คงเหลือ</th><th>สถานะ</th><th></th></tr></thead><tbody>' +
      p.variants.map(function (v) {
        return "<tr><td>" + esc(v.sku) + "</td><td>" + esc(v.size) + "</td><td>" + esc(v.chest || "") + "</td><td>" + esc(v.color) + '</td><td class="n"><b>' + v.qty + '</b></td><td><span class="badge ' + v.status + '">' + STATUS[v.status] + '</span></td><td class="nowrap right">' +
          '<button class="btn sm" data-in="' + v.id + '">รับเข้า</button> <button class="btn sm ghost" data-adj="' + v.id + '">ปรับยอด</button>' + (v.qty === 0 ? ' <button class="btn sm danger" data-delv="' + v.id + '">ลบ</button>' : "") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>" +
      '<div class="card"><h3 style="margin-top:0">ความเคลื่อนไหว</h3>' + (d.moves.length ? '<div class="scroll"><table class="t"><thead><tr><th>วันที่</th><th>ประเภท</th><th>SKU</th><th class="n">จำนวน</th><th class="n">คงเหลือหลังรายการ</th><th>อ้างอิง</th><th>โดย</th></tr></thead><tbody>' +
      d.moves.map(function (m) {
        var t = MOVE[m.type] || [m.type, ""];
        var ref = m.type === "out" ? esc(m.ref) + "<br><span class=\"muted small\">" + esc(m.who) + (m.branch ? " · " + esc(m.branch) : "") + "</span>" : esc(m.ref) + (m.note ? '<br><span class="muted small">' + esc(m.note) + "</span>" : "");
        return '<tr><td class="nowrap">' + thDateTime(m.at) + '</td><td><span class="badge ' + t[1] + '">' + t[0] + "</span></td><td>" + esc(m.sku) + '<br><span class="muted small">' + esc([m.size, m.color].filter(Boolean).join(" / ")) + '</span></td><td class="n ' + (m.qty > 0 ? "pos" : "neg") + '">' + (m.qty > 0 ? "+" : "−") + Math.abs(m.qty) + '</td><td class="n">' + m.balance + "</td><td>" + ref + "</td><td class=\"small\">" + (m.type === "out" ? "" : esc(m.who)) + "</td></tr>";
      }).join("") + "</tbody></table></div>" : '<div class="empty">ยังไม่มีความเคลื่อนไหว</div>') + pager(page, d.hasMore) + "</div>");
    bindPager(function (pg) { nav("#/stock/" + id, { page: pg }); });
    $("#edit").onclick = function () { productEditor(p); };
    $("#del").onclick = async function () {
      if (!confirm("ลบสินค้า \"" + p.name + "\" ทั้ง " + p.variants.length + " SKU?\nประวัติความเคลื่อนไหวและประวัติการเบิกยังเก็บไว้")) return;
      try { await api("/api/products/" + id, { method: "DELETE" }); toast("ลบสินค้าแล้ว"); location.hash = "#/stock"; } catch (e) { alert(e.message); }
    };
    $$("[data-in]").forEach(function (b) { b.onclick = function () { qtyDialog("in", p, p.variants.find(function (v) { return v.id == b.dataset.in; })); }; });
    $$("[data-adj]").forEach(function (b) { b.onclick = function () { qtyDialog("adj", p, p.variants.find(function (v) { return v.id == b.dataset.adj; })); }; });
    $$("[data-delv]").forEach(function (b) { b.onclick = async function () { if (!confirm("ลบ SKU นี้?")) return; try { await api("/api/variants/" + b.dataset.delv, { method: "DELETE" }); route(); } catch (e) { alert(e.message); } }; });
  }

  function qtyDialog(kind, p, v) {
    var label = esc(v.sku) + " · " + esc([v.size, v.color].filter(Boolean).join(" / ")) + " (คงเหลือ " + v.qty + ")";
    var b = modal(kind === "in"
      ? '<h2>รับสินค้าเข้า</h2><p class="muted">' + esc(p.name) + "<br>" + label + "</p>" + field("จำนวนที่รับเข้า", '<input class="i" type="number" min="1" step="1" id="q">', true) + field("เลขใบรับ / PO", '<input class="i" id="ref">', false) + field("หมายเหตุ", '<input class="i" id="note">', false)
      : '<h2>ปรับยอด (ตามยอดนับจริง)</h2><p class="muted">' + esc(p.name) + "<br>" + label + "</p>" + field("ยอดนับจริง", '<input class="i" type="number" min="0" step="1" id="q" value="' + v.qty + '">', true) + '<p class="small muted" id="diff"></p>' + field("เหตุผล", '<input class="i" id="note" placeholder="เช่น นับสต๊อกประจำเดือน / ชำรุด">', true));
    b.innerHTML += '<div class="err" id="err"></div><div class="actions"><button class="btn ghost" id="c">ยกเลิก</button><button class="btn" id="ok">บันทึก</button></div>';
    $("#c", b).onclick = closeModal;
    if (kind === "adj") $("#q", b).addEventListener("input", function () { var d = Number(this.value) - v.qty; $("#diff", b).textContent = isNaN(d) || this.value === "" ? "" : "ส่วนต่าง " + (d > 0 ? "+" : "") + d; });
    $("#q", b).focus();
    $("#ok", b).onclick = async function () {
      busy(this, true);
      try {
        if (kind === "in") await api("/api/variants/" + v.id + "/receive", { method: "POST", body: { qty: $("#q", b).value, ref: $("#ref", b).value, note: $("#note", b).value } });
        else await api("/api/variants/" + v.id + "/adjust", { method: "POST", body: { counted: $("#q", b).value, reason: $("#note", b).value } });
        closeModal(); toast("บันทึกแล้ว"); route();
      } catch (e) { $("#err", b).textContent = e.message; busy(this, false); }
    };
  }

  function skuFor(code, size, color, colorIndex) {
    var s = (code || "").toUpperCase() + "-" + (size ? size.toUpperCase().replace(/\s+/g, "") : "FREE");
    return color ? s + "-" + String(colorIndex).padStart(2, "0") : s;
  }

  function productEditor(p) {
    var editing = !!p;
    var rows = editing ? p.variants.map(function (v) { return { id: v.id, sku: v.sku, size: v.size, chest: v.chest || "", color: v.color, qty: v.qty }; }) : [];
    var cats = state.categories || [];
    var b = modal('<h2>' + (editing ? "แก้ไขสินค้า" : "เพิ่มสินค้า") + "</h2>" +
      '<div class="grid2">' + field("ชื่อสินค้า", '<input class="i" id="pn" value="' + esc(p && p.name) + '" placeholder="เช่น เสื้อโปโลพนักงาน">', true) + field("รหัสสินค้า (ต้น SKU)", '<input class="i" id="pc" value="' + esc(p && p.code) + '" placeholder="เช่น POLO">', true) + "</div>" +
      '<div class="grid3">' + field("หมวด", '<input class="i" id="pcat" list="cats" value="' + esc(p && p.category) + '" placeholder="เช่น เสื้อ"><datalist id="cats">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("") + "</datalist>", false) +
      field("หน่วย", '<input class="i" id="pu" value="' + esc(p ? p.unit : "ตัว") + '">', false) + field("เกณฑ์ใกล้หมด (≤)", '<input class="i" id="pm" type="number" min="0" value="' + (p ? p.min : 5) + '">', false) + "</div>" +
      '<div class="card" style="background:#f8fafb;box-shadow:none;border:1px solid var(--line)"><b>สร้าง SKU จาก ไซส์ × สี</b><div class="grid3" style="margin-top:8px">' +
      field("ไซส์ (คั่นด้วย ,)", '<input class="i" id="gs" placeholder="S, M, L, XL, 2XL">', false) + field("สี (คั่นด้วย , — เว้นว่างได้)", '<input class="i" id="gc" placeholder="กรมท่า, ขาว">', false) + field("ยอดตั้งต้นต่อ SKU", '<input class="i" id="gq" type="number" min="0" value="0">', false) +
      '</div><button class="btn sm ghost" id="gen">+ สร้าง SKU</button> <button class="btn sm ghost" id="addrow">+ เพิ่มทีละแถว</button></div>' +
      '<div class="scroll"><table class="t"><thead><tr><th>รหัส SKU</th><th>ไซส์</th><th>รอบอก (แสดงในแบบฟอร์ม)</th><th>สี</th><th class="n">' + (editing ? "ยอด (ใหม่ = ยอดตั้งต้น)" : "ยอดตั้งต้น") + '</th><th></th></tr></thead><tbody id="vrows"></tbody></table></div>' +
      (editing ? '<p class="small muted">ยอดของ SKU เดิมแก้ที่นี่ไม่ได้ — ใช้ปุ่ม "รับเข้า" หรือ "ปรับยอด" เพื่อให้มีประวัติ</p>' : "") +
      '<div class="err" id="err"></div><div class="actions"><button class="btn ghost" id="c">ยกเลิก</button><button class="btn" id="ok">' + (editing ? "บันทึก" : "เพิ่มสินค้า") + "</button></div>", true);
    function draw() {
      $("#vrows", b).innerHTML = rows.map(function (r, i) {
        return '<tr><td><input class="i" data-k="sku" data-i="' + i + '" value="' + esc(r.sku) + '"></td><td><input class="i" data-k="size" data-i="' + i + '" value="' + esc(r.size) + '" style="max-width:110px"></td><td><input class="i" data-k="chest" data-i="' + i + '" value="' + esc(r.chest || "") + '" placeholder="เช่น 38 นิ้ว" style="max-width:120px"></td><td><input class="i" data-k="color" data-i="' + i + '" value="' + esc(r.color) + '" style="max-width:140px"></td>' +
          '<td class="n">' + (r.id ? "<b>" + r.qty + "</b>" : '<input class="i" type="number" min="0" data-k="qty" data-i="' + i + '" value="' + esc(r.qty || 0) + '" style="max-width:90px">') + "</td><td>" + (r.id ? "" : '<button class="x" data-rm="' + i + '" title="ลบแถว">×</button>') + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="muted small">ยังไม่มี SKU</td></tr>';
      $$("input[data-k]", b).forEach(function (inp) { inp.oninput = function () { rows[inp.dataset.i][inp.dataset.k] = inp.value; }; });
      $$("[data-rm]", b).forEach(function (x) { x.onclick = function () { rows.splice(Number(x.dataset.rm), 1); draw(); }; });
    }
    draw();
    $("#gen", b).onclick = function () {
      var code = $("#pc", b).value.trim(); if (!code) { $("#err", b).textContent = "กรอกรหัสสินค้าก่อน เพื่อใช้เป็นต้น SKU"; return; }
      var sizes = $("#gs", b).value.split(",").map(function (s) { return s.trim(); }).filter(Boolean); if (!sizes.length) sizes = [""];
      var colors = $("#gc", b).value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      var existingColors = []; rows.forEach(function (r) { if (r.color && existingColors.indexOf(r.color) === -1) existingColors.push(r.color); });
      var qty = Number($("#gq", b).value) || 0, added = 0;
      sizes.forEach(function (sz) {
        (colors.length ? colors : [""]).forEach(function (col) {
          if (rows.some(function (r) { return r.size === sz && r.color === col; })) return;
          if (col && existingColors.indexOf(col) === -1) existingColors.push(col);
          rows.push({ sku: skuFor(code, sz, col, existingColors.indexOf(col) + 1), size: sz, chest: "", color: col, qty: qty }); added++;
        });
      });
      $("#err", b).textContent = added ? "" : "SKU เหล่านี้มีอยู่แล้ว";
      draw();
    };
    $("#addrow", b).onclick = function () { rows.push({ sku: "", size: "", chest: "", color: "", qty: 0 }); draw(); };
    $("#c", b).onclick = closeModal;
    $("#ok", b).onclick = async function () {
      busy(this, true);
      var body = { name: $("#pn", b).value, code: $("#pc", b).value, category: $("#pcat", b).value, unit: $("#pu", b).value, min: $("#pm", b).value,
        variants: rows.map(function (r) { return { id: r.id, sku: r.sku, size: r.size, chest: r.chest, color: r.color, qty: r.id ? undefined : r.qty }; }) };
      try {
        if (editing) { await api("/api/products/" + p.id, { method: "PUT", body: body }); closeModal(); toast("บันทึกแล้ว"); route(); }
        else { var r = await api("/api/products", { method: "POST", body: body }); closeModal(); toast("เพิ่มสินค้าแล้ว"); location.hash = "#/stock/" + r.id; }
      } catch (e) { $("#err", b).textContent = e.message; busy(this, false); }
    };
  }

  // ---------- new request (everyone) — catalog has NO stock numbers ----------
  // Types with a fixed number of shirts must add up to exactly that number;
  // "ซื้อเสื้อเพิ่ม" shows the amount, then a payment step (ask HR first, slip upload).
  // q.edit = request no → HR edits that pending request. HR filling the form = on behalf of an employee.
  // One request can hold several request types ("+ เพิ่มประเภทการเบิก"): one block per type,
  // shared employee details, one payment for the sum, one approval.
  async function viewNew(q) {
    var cat = await api("/api/catalog"); var s = state.settings; var me = state.me, hr = isHR();
    var edit = hr && q && q.edit ? await api("/api/requests/" + encodeURIComponent(q.edit)) : null;
    if (edit && edit.status !== "pending") { setView('<div class="card empty">แก้ไขได้เฉพาะคำขอที่รออนุมัติ — คำขอ ' + esc(edit.no) + " " + esc(RSTATUS[edit.status]) + "แล้ว</div>"); return; }
    var draft = {}; try { draft = JSON.parse(localStorage.getItem("uni_last_form") || "{}"); } catch (e) {}
    if (hr) { draft = edit ? { name: edit.name, position: edit.position, dept: edit.dept, phone: edit.phone, email: edit.email, branch: edit.branch } : {}; me = { name: "", emp_code: edit ? edit.emp_code : "", branch: "", position: "", dept: "", phone: "", email: "" }; }
    var v = function (k, fallback) { return esc(draft[k] != null && draft[k] !== "" ? draft[k] : fallback || ""); };
    var pick = function (k, fallback) { return draft[k] != null && draft[k] !== "" ? draft[k] : fallback || ""; };
    function dropdown(id, list, cur, placeholder) {
      return '<select class="i" id="' + id + '"><option value="">-- ' + placeholder + ' --</option>' + list.map(function (x) { return "<option" + (cur === x ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select>";
    }
    var branchInput = s.branches.length ? dropdown("branch", s.branches, pick("branch", me.branch), "เลือกสาขา") : '<input class="i" id="branch" value="' + v("branch", me.branch) + '">';
    var posInput = (s.positions || []).length ? dropdown("position", s.positions, pick("position", me.position), "เลือกตำแหน่ง") : '<input class="i" id="position" placeholder="พิมพ์ตำแหน่ง" value="' + v("position", me.position) + '">';
    var deptInput = s.depts.length ? dropdown("dept", s.depts, pick("dept", me.dept), "เลือกแผนก") : '<input class="i" id="dept" value="' + v("dept", me.dept) + '">';
    // Products linked to lanyard / card holder / ID card are not shirts.
    var linkedIds = Object.keys(s.itemProducts || {}).map(function (k) { return s.itemProducts[k]; }).filter(function (x) { return x; });
    var allProducts = cat, shirts = cat.filter(function (p) { return linkedIds.indexOf(p.id) === -1; });
    var single = shirts.length === 1 ? shirts[0] : null;
    function productFor(item) { var id = (s.itemProducts || {})[item]; return id ? allProducts.find(function (p) { return p.id === id; }) || null : null; }
    function itemProduct(t) { return t && t.item !== "shirt" && !t.bundle ? productFor(t.item) : null; }
    // A bundle (e.g. lanyard + holder + card): the linked stock products of its items, one of each per set.
    function bundleParts(t) { return t && t.bundle ? t.bundle.map(function (it) { return { item: it, p: productFor(it) }; }) : []; }
    var ITEM_NAMES = {}; (s.items || []).forEach(function (x) { ITEM_NAMES[x.key] = x.label; });
    function amountFor(t, n) { return !t ? 0 : t.item === "shirt" ? (t.purchase ? priceFor(n) : 0) : n * (t.price || 0); }
    function variantOptions(p, ph) { return '<option value="">-- ' + (ph || "เลือกแบบ") + ' --</option>' + p.variants.map(function (x) { return '<option value="' + x.id + '">' + esc(vlabel(x)) + "</option>"; }).join(""); }
    setView((edit ? '<h1>แก้ไขคำขอ ' + esc(edit.no) + '</h1><p class="sub">HR แก้ไขข้อมูล/รายการแทนพนักงาน — สต๊อกจะถูกตัดตามรายการที่แก้ไขเมื่อกดอนุมัติ</p>'
        : '<h1>ขอเบิก / สั่งซื้อ</h1><p class="sub">' + (hr ? "HR กรอกคำขอเบิกแทนพนักงานได้ — ใส่ข้อมูลของพนักงานที่ต้องการเบิก แล้วอนุมัติที่เมนู “คำขอเบิก” ระบบจะตัดสต๊อกตามจริง" : "เสื้อยูนิฟอร์ม · สายคล้องคอ · กรอบบัตร · บัตรพนักงาน — กรอกข้อมูลแล้วกดส่ง HR จะตรวจสอบและอนุมัติ แล้วจัดส่งไปยังสาขาที่เลือก พร้อมแจ้งทางอีเมล") + "</p>") +
      '<div class="card"><h3 style="margin-top:0">ข้อมูลพนักงาน</h3><div class="grid3">' +
      field("วันที่ขอ", '<input class="i" type="date" id="reqDate" value="' + (edit ? esc(String(edit.req_date).slice(0, 10)) : today()) + '">', true) +
      field("ชื่อ-นามสกุล", '<input class="i" id="name" value="' + v("name", me.name) + '">', true) +
      field("รหัสพนักงาน", '<input class="i" id="code" value="' + esc(me.emp_code) + '">', true) +
      field("ตำแหน่ง", posInput, true) +
      field("แผนก / ฝ่าย", deptInput, s.depts.length > 0) +
      field("สาขา", branchInput, true) +
      field("เบอร์โทรติดต่อ", '<input class="i" id="phone" inputmode="tel" value="' + v("phone", me.phone) + '">', false) +
      field("อีเมล (แจ้งเมื่อจัดส่งแล้ว)", '<input class="i" id="email" type="email" inputmode="email" placeholder="name@example.com" value="' + v("email", me.email) + '">', true) +
      "</div></div>" +
      '<div class="card"><h3 style="margin-top:0">รายการที่ขอเบิก</h3><p class="small muted" style="margin:-4px 0 10px">เลือกประเภทการเบิก — ต้องการหลายอย่าง กด “+ เพิ่มประเภทการเบิก” ได้ในคำขอเดียว</p>' +
      (shirts.length ? "" : '<div class="note red">ยังไม่มีรายการเสื้อในระบบ — กรุณาติดต่อ HR</div>') +
      '<div id="blocks"></div><button class="btn sm ghost addtype" id="addType">+ เพิ่มประเภทการเบิก</button>' +
      '<div class="totalbox" id="totalBox"></div><div class="note red stockwarn" id="stockWarn" hidden></div>' +
      '<div class="field" id="photoBlock" hidden style="margin-top:14px"><label class="f' + (hr ? "" : " req") + '">ถ่ายรูปของที่ชำรุดแนบมา</label><input class="i" type="file" id="photo" accept="image/*">' +
      (edit && edit.photo_file_id ? '<p class="small muted" style="margin:4px 0 0">มีรูปแนบแล้ว — <a href="/api/files/' + edit.photo_file_id + '" target="_blank">เปิดดู</a> (เลือกไฟล์ใหม่เพื่อเปลี่ยน)</p>' : "") + '<div id="photoPrev"></div></div>' +
      '<div class="field" style="margin-top:14px"><label class="f">หมายเหตุ</label><textarea class="i" id="note" rows="2"></textarea></div>' +
      '<div class="err" id="err"></div>' + (edit ? '<div class="row"><a class="btn ghost" href="#/requests">ยกเลิก</a><button class="btn" id="submit">บันทึกการแก้ไข</button></div>' : '<button class="btn" id="submit">ส่งคำขอเบิก</button>') + "</div>");

    // ---- one block per request type ----
    var blocks = [];
    function typeSelect() {
      return '<select class="i ttype" aria-label="ประเภทการเบิก"><option value="">-- เลือกประเภทการเบิก --</option>' + s.requestTypes.map(function (t) { return '<option value="' + esc(t.label) + '">' + esc(t.label) + (t.item !== "shirt" ? " — " + (t.price ? money(t.price) + " บาท" : "ไม่มีค่าใช้จ่าย") : "") + "</option>"; }).join("") + "</select>";
    }
    function addBlock() {
      var el = document.createElement("div"); el.className = "tblock";
      el.innerHTML = '<div class="thead"><span class="tno"></span>' + typeSelect() + '<button class="x tdel" title="ลบประเภทนี้">×</button></div><p class="small muted thint"></p>' +
        '<div class="tshirt" hidden><div class="tlines"></div><button class="btn sm ghost tadd">+ เพิ่มไซส์</button></div>' +
        '<div class="titem" hidden><div class="tparts"></div><div class="lrow item"><div class="i prname tname"></div><select class="i tsku" hidden></select><input class="i tqty" type="number" min="1" max="99" step="1" value="1" aria-label="จำนวน"></div></div>' +
        '<div class="tsub"></div>';
      var blk = { el: el };
      var sel = $(".ttype", el), tlines = $(".tlines", el);
      blk.type = function () { return typeOf(sel.value); };
      blk.addLine = function () {
        var div = document.createElement("div"); div.className = "lrow";
        div.innerHTML = (single ? '<div class="i prname">' + esc(single.name) + '</div>' : '<select class="i pr"><option value="">-- เลือกเสื้อ --</option>' + shirts.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + "</option>"; }).join("") + "</select>") +
          '<select class="i va"' + (single ? "" : " disabled") + ">" + (single ? variantOptions(single, "เลือกไซส์ (รอบอก)") : '<option value="">ไซส์ (รอบอก)</option>') + '</select><input class="i qt" type="number" min="1" step="1" value="1" aria-label="จำนวน"><button class="x" title="ลบรายการ">×</button>';
        if (!single) $(".pr", div).onchange = function () {
          var p = shirts.find(function (x) { return String(x.id) === this.value; }, this);
          var va = $(".va", div); va.innerHTML = p ? variantOptions(p, "เลือกไซส์ (รอบอก)") : '<option value="">ไซส์ (รอบอก)</option>'; va.disabled = !p;
          if (p && p.variants.length === 1) va.value = p.variants[0].id; update();
        };
        $(".va", div).onchange = update; $(".qt", div).oninput = update;
        $(".x", div).onclick = function () { div.remove(); if (!tlines.children.length) blk.addLine(); update(); };
        tlines.appendChild(div); return div;
      };
      blk.setType = function () {
        var t = blk.type(); $(".tshirt", el).hidden = !(t && t.item === "shirt"); $(".titem", el).hidden = !(t && t.item !== "shirt");
        if (t && t.item !== "shirt") {
          var ip = itemProduct(t), sku = $(".tsku", el);
          $(".tname", el).textContent = t.bundle ? "จำนวนชุด" : ip ? ip.name : t.label;
          sku.hidden = !(ip && ip.variants.length > 1); sku.innerHTML = ip && ip.variants.length > 1 ? variantOptions(ip) : "";
          // Bundle: what one set contains; parts with several SKUs get a picker.
          $(".tparts", el).innerHTML = bundleParts(t).map(function (x) {
            return '<div class="lrow item bpart"><div class="i prname">' + esc(x.p ? x.p.name : ITEM_NAMES[x.item] || x.item) + '</div>' + (x.p && x.p.variants.length > 1 ? '<select class="i" data-pid="' + x.p.id + '">' + variantOptions(x.p) + "</select>" : "") +
              '<div class="small muted bpq">' + (x.p ? "1 / ชุด" : "1 / ชุด · ไม่ตัดสต๊อก") + "</div></div>";
          }).join("");
          $$(".tparts select", el).forEach(function (x) { x.onchange = update; });
          $(".tqty", el).value = 1;
        }
        if (t && t.item === "shirt") {
          if (!tlines.children.length) blk.addLine();
          // One size line with the entitled quantity is the common case — prefill it.
          if (t.qty && tlines.children.length === 1) $(".qt", tlines.children[0]).value = t.qty;
        }
      };
      blk.collect = function () {
        var t = blk.type(); if (!t) return [];
        if (t.bundle) return bundleParts(t).filter(function (x) { return x.p; }).map(function (x) {
          var ps = $('.tparts select[data-pid="' + x.p.id + '"]', el);
          return { variant_id: x.p.variants.length === 1 ? x.p.variants[0].id : ps ? ps.value : "", qty: $(".tqty", el).value };
        }).filter(function (l) { return l.variant_id; });
        if (t.item !== "shirt") {
          var p = itemProduct(t); if (!p) return [];   // service: quantity only
          var vid = p.variants.length === 1 ? p.variants[0].id : $(".tsku", el).value;
          return vid ? [{ variant_id: vid, qty: $(".tqty", el).value }] : [];
        }
        return $$(".lrow", tlines).map(function (r) { return { variant_id: $(".va", r).value, qty: $(".qt", r).value }; }).filter(function (l) { return l.variant_id; });
      };
      blk.qty = function () { var t = blk.type(); return !t ? 0 : t.item !== "shirt" ? Number($(".tqty", el).value) || 0 : blk.collect().reduce(function (a, l) { return a + (Number(l.qty) || 0); }, 0); };
      blk.amount = function () { return amountFor(blk.type(), blk.qty()); };
      blk.problem = function () {   // what's missing in this block (null = ok)
        var t = blk.type(), lines = blk.collect(), n = blk.qty();
        if (!t) return "ประเภทการเบิก";
        if (t.item === "shirt" && !lines.length) return "ไซส์และจำนวนเสื้อ (" + t.label + ")";
        if (t.bundle && lines.length < bundleParts(t).filter(function (x) { return x.p; }).length) return "แบบของแต่ละรายการในชุด";
        if (t.item !== "shirt" && itemProduct(t) && !lines.length) return "แบบของ " + t.label;
        if (t.item !== "shirt" && !(n >= 1 && n <= 99)) return "จำนวน (1–99) ของ " + t.label;
        if (t.qty && n !== t.qty) return "จำนวนเสื้อ — ประเภท “" + t.label + "” เบิกได้ " + t.qty + " ตัว (ตอนนี้ " + n + " ตัว)";
        return null;
      };
      blk.render = function () {
        var t = blk.type(), n = blk.qty(), amt = blk.amount(), hint = $(".thint", el), sub = $(".tsub", el);
        if (!t) { hint.textContent = ""; sub.innerHTML = ""; return; }
        if (t.item !== "shirt") {
          hint.textContent = (t.price ? "ราคา " + money(t.price) + " บาท / " + (t.bundle ? "ชุด" : "ชิ้น") : "ไม่มีค่าใช้จ่าย") + (t.photo ? " · ถ่ายรูปของที่ชำรุดแนบมาด้วย" : "");
          sub.innerHTML = n > 0 ? "จำนวน <b>" + n + "</b>" + (t.bundle ? " ชุด" : "") + (amt ? ' · <b class="amt">' + money(amt) + " บาท</b>" : " · ไม่มีค่าใช้จ่าย") : "ระบุจำนวน";
        } else if (t.purchase) {
          hint.textContent = "ระบุไซส์และจำนวนเสื้อที่ต้องการสั่งซื้อ — ระบบคำนวณยอดชำระให้อัตโนมัติ";
          sub.innerHTML = n > 0 ? 'สั่งซื้อ <b>' + n + '</b> ตัว · <b class="amt">' + money(amt) + " บาท</b>" : "ระบุจำนวนเสื้อที่ต้องการสั่งซื้อ";
        } else {
          hint.textContent = "สิทธิ์เบิก " + t.qty + " ตัว — เลือกได้มากกว่า 1 ไซส์ แต่รวมกันต้องเท่ากับ " + t.qty + " ตัว";
          sub.innerHTML = 'เลือกแล้ว <b class="' + (n === t.qty ? "okq" : "badq") + '">' + n + " / " + t.qty + "</b> ตัว";
        }
      };
      sel.onchange = function () { blk.setType(); update(); };
      $(".tadd", el).onclick = function () { blk.addLine(); update(); };
      $(".tqty", el).oninput = update; $(".tsku", el).onchange = update;
      $(".tdel", el).onclick = function () { el.remove(); blocks.splice(blocks.indexOf(blk), 1); if (!blocks.length) addBlock(); update(); };
      $("#blocks").appendChild(el); blocks.push(blk);
      return blk;
    }
    function allLines() { return blocks.reduce(function (a, b) { return a.concat(b.collect()); }, []); }
    function totalAmount() { return blocks.reduce(function (a, b) { return a + b.amount(); }, 0); }
    // Live stock check (no numbers shown): warn as soon as a size / quantity can't be filled.
    var stockShort = [], checkSeq = 0, checkTimer = null;
    function scheduleCheck() {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(async function () {
        var lines = allLines(), seq = ++checkSeq;
        if (!lines.length) { stockShort = []; renderWarn(); return; }
        try { var r = await api("/api/stock-check", { method: "POST", body: { lines: lines } }); if (seq === checkSeq) { stockShort = r.short || []; renderWarn(); } } catch (e) {}
      }, 250);
    }
    function renderWarn() {
      var w = $("#stockWarn"); if (!w) return;
      w.hidden = !stockShort.length;
      w.innerHTML = stockShort.length ? "<b>" + (hr ? "สต๊อกคงเหลือไม่พอ — บันทึกคำขอได้ แต่ต้องรับสินค้าเข้าก่อนจึงจะอนุมัติได้" : "สต๊อกคงเหลือไม่เพียงพอ โปรดติดต่อ People Team") + "</b><br>" + stockShort.map(function (x) { return esc(x.label); }).join(", ") : "";
    }
    function update() {
      scheduleCheck();
      // A type can be picked once per request; numbering + delete button only when there are several.
      var chosen = blocks.map(function (b) { return $(".ttype", b.el).value; });
      blocks.forEach(function (b, i) {
        $(".tno", b.el).textContent = blocks.length > 1 ? i + 1 + "." : ""; $(".tdel", b.el).hidden = blocks.length < 2 && !$(".ttype", b.el).value;
        $$(".ttype option", b.el).forEach(function (o) { o.disabled = !!o.value && o.value !== chosen[i] && chosen.indexOf(o.value) !== -1; });
        b.render();
      });
      var typed = blocks.filter(function (b) { return b.type(); }), amt = totalAmount();
      $("#photoBlock").hidden = !blocks.some(function (b) { var t = b.type(); return t && t.photo; });
      $("#addType").hidden = blocks.length >= 10 || blocks.length >= s.requestTypes.length;
      $("#totalBox").innerHTML = !typed.length ? "เลือกประเภทการเบิกก่อน" : (typed.length > 1 ? "รวม <b>" + typed.length + "</b> ประเภท · " : "") + (amt > 0 ? 'ยอดชำระรวม <b class="amt">' + money(amt) + " บาท</b>" : "ไม่มีค่าใช้จ่าย");
      $("#submit").textContent = edit ? "บันทึกการแก้ไข" : amt > 0 ? "ถัดไป: ชำระเงิน →" : "ส่งคำขอเบิก";
    }
    $("#addType").onclick = function () { addBlock(); update(); $(".ttype", blocks[blocks.length - 1].el).focus(); };
    var photoFile = null;
    $("#photo").onchange = async function () {
      photoFile = null; $("#photoPrev").innerHTML = ""; var f = this.files[0]; if (!f) return;
      try { photoFile = await shrinkImage(f); } catch (e) { photoFile = f; }
      if (photoFile.size > 6 * 1024 * 1024) { $("#err").textContent = "รูปใหญ่เกิน 6 MB"; photoFile = null; this.value = ""; return; }
      $("#photoPrev").innerHTML = '<img class="slipimg" src="' + URL.createObjectURL(photoFile) + '" alt="รูปของที่ชำรุด">';
    };
    // Edit: one block per stored item, with its lines (old requests: one item, lines without a type).
    if (edit) {
      $("#code").value = edit.emp_code; $("#note").value = edit.note || "";
      var items = edit.items && edit.items.length ? edit.items : [{ type: edit.type, qty: edit.total_qty }];
      items.forEach(function (it) {
        var blk = addBlock(), t = typeOf(it.type); if (!t) return;
        $(".ttype", blk.el).value = it.type; blk.setType();
        var mine = edit.lines.filter(function (l) { return (l.req_type || items[0].type) === it.type; });
        if (t.item !== "shirt") {
          $(".tqty", blk.el).value = it.qty;
          mine.forEach(function (l) { var ps = $('.tparts select[data-pid="' + l.product_id + '"]', blk.el); if (ps) ps.value = l.variant_id; if (!t.bundle) $(".tsku", blk.el).value = l.variant_id; });
        } else if (mine.length) {
          $(".tlines", blk.el).innerHTML = "";
          mine.forEach(function (l) {
            var row = blk.addLine(), pr = $(".pr", row);
            if (pr) { pr.value = l.product_id; pr.onchange(); }
            $(".va", row).value = l.variant_id; $(".qt", row).value = l.qty;
          });
        }
      });
    } else addBlock();
    update();
    function body() {
      return { req_date: $("#reqDate").value, name: $("#name").value, emp_code: $("#code").value, position: $("#position").value, dept: $("#dept").value, phone: $("#phone").value, email: $("#email").value.trim(), branch: $("#branch").value, note: $("#note").value,
        items: blocks.filter(function (b) { return b.type(); }).map(function (b) { return { type: b.type().label, qty: b.qty(), lines: b.collect() }; }) };
    }
    function remember(b) {
      try { localStorage.setItem("uni_last_form", JSON.stringify({ name: b.name, position: b.position, dept: b.dept, phone: b.phone, email: b.email, branch: b.branch })); } catch (e) {}
      state.me.position = b.position; state.me.dept = b.dept; state.me.phone = b.phone; state.me.email = b.email; state.me.branch = b.branch;
    }
    function done(no, purchase) {
      var mb = modal('<h2>' + (purchase ? "ส่งคำสั่งซื้อแล้ว" : "ส่งคำขอเบิกแล้ว") + '</h2><p>เลขที่คำขอ <b>' + esc(no) + '</b></p><p class="muted">HR จะตรวจสอบ' + (purchase ? "การชำระเงินและ" : "") + 'สต๊อก แล้วจัดส่ง — เมื่อจัดส่งแล้วระบบจะแจ้งทางอีเมล · ติดตามสถานะได้ที่เมนู "' + (isHR() ? "คำขอเบิก" : "คำขอของฉัน") + '"</p><div class="actions"><button class="btn ghost" id="again">ส่งอีกครั้ง</button><button class="btn" id="see">ดูคำขอ</button></div>');
      $("#again", mb).onclick = function () { closeModal(); route(); };
      $("#see", mb).onclick = function () { closeModal(); location.hash = "#/requests"; };
    }
    $("#submit").onclick = async function () {
      var b = body(), missing = [];
      if (!b.name.trim()) missing.push("ชื่อ-นามสกุล"); if (!b.emp_code.trim()) missing.push("รหัสพนักงาน"); if (!b.position.trim()) missing.push("ตำแหน่ง");
      if (s.depts.length && !b.dept) missing.push("แผนก"); if (!b.branch.trim()) missing.push("สาขา");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) missing.push("อีเมล");
      blocks.forEach(function (blk) { var p = blk.problem(); if (p && !(p === "ประเภทการเบิก" && blocks.length > 1 && b.items.length)) missing.push(p); });
      if (blocks.some(function (x) { var t = x.type(); return t && t.photo; }) && !hr && !photoFile) missing.push("รูปของที่ชำรุด");
      if (missing.length) { $("#err").textContent = "กรุณากรอก: " + missing.join(", "); return; }
      var lines = allLines();
      if (lines.length) {   // re-check right before submitting / paying
        try { var chk = await api("/api/stock-check", { method: "POST", body: { lines: lines } }); stockShort = chk.short || []; renderWarn(); } catch (e) {}
        if (stockShort.length && !hr) { $("#err").textContent = "สต๊อกคงเหลือไม่เพียงพอ โปรดติดต่อ People Team"; return; }
      }
      $("#err").textContent = "";
      if (totalAmount() > 0) return paymentStep(b);
      busy(this, true);
      try { var r = await send(b, null); finish(r, b, false); }
      catch (e) { $("#err").textContent = e.message; busy(this, false); }
    };
    // POST a new request, or PUT the edited one; multipart when a file goes along.
    function send(data, slip) {
      var fd = new FormData(); fd.append("data", JSON.stringify(data));
      if (slip) fd.append("slip", slip, slip.name || "slip.jpg");
      if (photoFile) fd.append("photo", photoFile, photoFile.name || "photo.jpg");
      return api(edit ? "/api/requests/" + encodeURIComponent(edit.no) : "/api/requests", { method: edit ? "PUT" : "POST", body: fd });
    }
    function finish(r, b, purchase) {
      closeModal();
      if (edit) { toast("บันทึกการแก้ไขคำขอ " + edit.no + " แล้ว"); location.hash = "#/requests"; return; }
      if (!hr) remember(b);
      done(r.no, purchase);
    }
    function lineText(l, shirt) {
      var x = null; allProducts.forEach(function (p) { p.variants.forEach(function (vv) { if (String(vv.id) === String(l.variant_id)) x = { p: p, v: vv }; }); });
      return x ? esc(x.p.name) + (x.p.variants.length > 1 || shirt ? " · " + esc(vlabel(x.v)) : "") + " × " + Number(l.qty) : "";
    }
    // Step 2 when something costs money: amount per type, how to pay, "ask HR first", payment slip.
    function paymentStep(b) {
      var amount = totalAmount(), typed = blocks.filter(function (x) { return x.type(); }), anyShirt = typed.some(function (x) { return x.type().item === "shirt"; });
      var items = typed.map(function (x) {
        var t = x.type(), lines = x.collect(), a = x.amount();
        return '<div class="payitem"><div><b>' + esc(t.label) + "</b>" + (a ? " — " + money(a) + " บาท" : " — ไม่มีค่าใช้จ่าย") + '</div><div class="small muted">' + (lines.length ? lines.map(function (l) { return lineText(l, t.item === "shirt"); }).join("<br>") : esc(t.label) + " × " + x.qty()) + "</div></div>";
      }).join("");
      var mb = modal('<h2>ชำระเงิน</h2>' +
        '<div class="paybox"><div>' + items + '</div><div class="payamt">ยอดชำระรวม <b>' + money(amount) + ' บาท</b></div></div>' +
        (hr ? '<div class="note">HR บันทึกแทนพนักงาน — แนบหลักฐานการชำระเงินได้ถ้ามี (ไม่บังคับ)' + (edit && edit.slip_file_id ? ' · มีสลิปเดิมแล้ว <a href="/api/files/' + edit.slip_file_id + '" target="_blank">เปิดดู</a>' : "") + "</div>"
          : '<div class="note red"><b>ก่อนชำระเงิน</b> กรุณาสอบถาม HR เพื่อตรวจสอบจำนวนคงเหลือ' + (anyShirt ? "และไซซ์ที่ต้องการ" : "") + 'ก่อน</div>' +
        (s.payInfo ? '<div class="note"><b>ช่องทางการชำระเงิน</b><br>' + esc(s.payInfo).replace(/\n/g, "<br>") + "</div>" : '<div class="note">สอบถามช่องทางการชำระเงินกับ HR</div>') +
        '<label class="ack"><input type="checkbox" id="ack"> สอบถาม HR เรื่องจำนวนคงเหลือ' + (anyShirt ? "และไซซ์" : "") + 'แล้ว</label>') +
        field("แนบหลักฐานการชำระเงิน (รูปภาพ หรือ PDF)", '<input class="i" type="file" id="slip" accept="image/*,application/pdf">', !hr) + '<div id="slipPrev"></div>' +
        '<div class="err" id="perr"></div><div class="actions"><button class="btn ghost" id="back">← แก้ไขรายการ</button><button class="btn" id="pay">' + (edit ? "บันทึกการแก้ไข" : "ส่งคำสั่งซื้อ") + '</button></div>');
      var file = null;
      $("#back", mb).onclick = closeModal;
      $("#slip", mb).onchange = async function () {
        $("#perr", mb).textContent = ""; file = null; $("#slipPrev", mb).innerHTML = "";
        var f = this.files[0]; if (!f) return;
        try { file = await shrinkImage(f); } catch (e) { file = f; }
        if (file.size > 6 * 1024 * 1024) { $("#perr", mb).textContent = "ไฟล์ใหญ่เกิน 6 MB"; file = null; return; }
        $("#slipPrev", mb).innerHTML = /^image\//.test(file.type) ? '<img class="slipimg" src="' + URL.createObjectURL(file) + '" alt="หลักฐานการชำระเงิน">' : '<p class="small muted">' + esc(f.name) + "</p>";
      };
      $("#pay", mb).onclick = async function () {
        if (!hr && !$("#ack", mb).checked) { $("#perr", mb).textContent = "กรุณายืนยันว่าสอบถาม HR แล้ว"; return; }
        if (!hr && !file) { $("#perr", mb).textContent = "กรุณาแนบหลักฐานการชำระเงิน"; return; }
        busy(this, true);
        try { var r = await send(Object.assign({}, b, { ack_hr: !hr || undefined, amount: amount }), file); finish(r, b, true); }
        catch (e) { $("#perr", mb).textContent = e.message; busy(this, false); }
      };
    }
  }
  // Phone photos are often 4–8 MB: re-encode big images to ~1600px JPEG before upload.
  function shrinkImage(f) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size < 1.5 * 1024 * 1024) return resolve(f);
      var img = new Image(); img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (blob) { blob ? resolve(new File([blob], (f.name || "slip").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" })) : reject(); }, "image/jpeg", 0.85);
      }; img.onerror = reject; img.src = URL.createObjectURL(f);
    });
  }

  // ---------- requests ----------
  async function viewRequests(q) {
    var status = q.status || "pending", mine = isHR() && q.mine === "1", page = Number(q.page || 1), kind = q.kind || "";
    var d = await api("/api/requests?status=" + status + "&page=" + page + (mine ? "&mine=1" : "") + (kind ? "&kind=" + kind : ""));
    var total = Object.keys(d.counts).reduce(function (t, k) { return t + d.counts[k]; }, 0);
    var tabs = [["pending", "รออนุมัติ"], ["approved", "รอจัดส่ง"], ["shipped", "จัดส่งแล้ว"], ["rejected", "ไม่อนุมัติ"], ["cancelled", "ยกเลิก"], ["all", "ทั้งหมด"]];
    setView('<div class="row"><div><h1>' + (isHR() ? "คำขอเบิก" : "คำขอของฉัน") + '</h1><p class="sub">' + (isHR() ? "ตรวจสต๊อก อนุมัติ และออกใบส่งสินค้า" : "ติดตามสถานะคำขอเบิกชุด") + '</p></div><div class="spacer"></div>' +
      (isHR() ? '<select class="i" id="kind" style="width:auto"><option value="">ทุกประเภท</option><option value="issue"' + (kind === "issue" ? " selected" : "") + '>เบิกตามสิทธิ์</option><option value="purchase"' + (kind === "purchase" ? " selected" : "") + '>สั่งซื้อเสื้อเพิ่ม</option></select>' +
        '<label class="small"><input type="checkbox" id="mine"' + (mine ? " checked" : "") + '> เฉพาะคำขอของฉัน</label><a class="btn ghost" href="/api/requests.xlsx">ส่งออก Excel</a>' : "") + "</div>" +
      '<div class="tabs">' + tabs.map(function (t) { var n = t[0] === "all" ? total : d.counts[t[0]] || 0; return '<button class="tab' + (status === t[0] ? " on" : "") + '" data-s="' + t[0] + '">' + t[1] + "<i>" + n + "</i></button>"; }).join("") + "</div>" +
      (d.requests.length ? d.requests.map(reqCard).join("") : '<div class="card empty">ไม่มีคำขอในสถานะนี้</div>') + pager(page, d.hasMore));
    $$(".tab").forEach(function (b) { b.onclick = function () { nav("#/requests", { status: b.dataset.s, mine: mine ? "1" : "", kind: kind }); }; });
    if ($("#mine")) $("#mine").onchange = function () { nav("#/requests", { status: status, mine: this.checked ? "1" : "", kind: kind }); };
    if ($("#kind")) $("#kind").onchange = function () { nav("#/requests", { status: status, mine: mine ? "1" : "", kind: this.value }); };
    bindPager(function (pg) { nav("#/requests", { status: status, mine: mine ? "1" : "", kind: kind, page: pg }); });
    $$("[data-act]").forEach(function (b) {
      b.onclick = function () {
        var r = d.requests.find(function (x) { return x.no === b.dataset.no; });
        var act = b.dataset.act;
        if (act === "approve") return approveDialog(r);
        if (act === "reject") return rejectDialog(r);
        if (act === "dn") return window.open("/dn/" + encodeURIComponent(r.dn_no), "_blank");
        if (act === "cancel") { if (!confirm("ยกเลิกคำขอ " + r.no + "?")) return; return doAct("/api/requests/" + encodeURIComponent(r.no) + "/cancel", "ยกเลิกคำขอแล้ว"); }
        if (act === "ship") return shipDialog(r, false);
        if (act === "shipdate") return shipDialog(r, true);
        if (act === "slip") return window.open("/api/files/" + r.slip_file_id, "_blank");
        if (act === "photo") return window.open("/api/files/" + r.photo_file_id, "_blank");
        if (act === "edit") { location.hash = "#/new?edit=" + encodeURIComponent(r.no); return; }
        if (act === "notify") return doAct("/api/requests/" + encodeURIComponent(r.no) + "/notify", "ส่งอีเมลแจ้งพนักงานแล้ว");
      };
    });
  }
  async function doAct(url, msg, body) { try { await api(url, { method: "POST", body: body || {} }); toast(msg); route(); } catch (e) { alert(e.message); } }

  // Lines of a request grouped by its types (old requests: one type, lines without req_type). A type
  // with no stock lines (service) gets one row; an ID-card set also lists the card (no stock cut).
  function reqRows(r, cols) {
    var items = r.items && r.items.length ? r.items : [{ type: r.type, qty: r.total_qty, amount: r.amount }];
    var names = {}; (state.settings.items || []).forEach(function (x) { names[x.key] = x.label; });
    var svc = function (name, qty) { return "<tr><td>" + esc(name) + '</td><td class="muted">ไม่ตัดสต๊อก</td><td></td><td class="n">' + qty + "</td>" + (cols > 4 ? "<td></td>" : "") + "</tr>"; };
    return items.map(function (it) {
      var t = typeOf(it.type), mine = r.lines.filter(function (l) { return (l.req_type || items[0].type) === it.type; });
      var head = items.length > 1 ? '<tr class="grp"><td colspan="' + cols + '">' + esc(it.type) + (it.amount ? " · " + money(it.amount) + " บาท" : "") + "</td></tr>" : "";
      var rows = mine.map(function (l) { return "<tr><td>" + esc(l.product_name) + "</td><td>" + esc(l.sku) + "</td><td>" + esc([l.size, l.color].filter(Boolean).join(" / ")) + '</td><td class="n">' + l.qty + " " + esc(l.unit) + "</td>" + (cols > 4 ? '<td class="n' + (l.available < l.qty ? " short" : "") + '">' + l.available + "</td>" : "") + "</tr>"; }).join("");
      if (!mine.length) rows = svc(it.type, it.qty);
      else if (t && t.bundle) rows += t.bundle.filter(function (x) { return !(state.settings.itemProducts || {})[x]; }).map(function (x) { return svc(names[x] || x, it.qty); }).join("");
      return head + rows;
    }).join("");
  }
  function reqCard(r) {
    var hr = isHR(), pend = r.status === "pending";
    var lines = '<div class="scroll"><table class="t lines"><thead><tr><th>รายการ</th><th>SKU</th><th>ไซส์ / สี</th><th class="n">จำนวน</th>' + (hr && pend ? '<th class="n">คงเหลือ</th>' : "") + "</tr></thead><tbody>" +
      reqRows(r, hr && pend ? 5 : 4) + "</tbody></table></div>";
    var acts = [];
    if (pend && hr) { acts.push('<button class="btn sm" data-act="approve" data-no="' + esc(r.no) + '">อนุมัติและออกใบส่งสินค้า</button>'); acts.push('<button class="btn sm ghost" data-act="edit" data-no="' + esc(r.no) + '">แก้ไข</button>'); acts.push('<button class="btn sm danger" data-act="reject" data-no="' + esc(r.no) + '">ไม่อนุมัติ</button>'); }
    if (pend && r.mine) acts.push('<button class="btn sm ghost" data-act="cancel" data-no="' + esc(r.no) + '">ยกเลิกคำขอ</button>');
    if (r.status === "approved" || r.status === "shipped") acts.push('<button class="btn sm ghost" data-act="dn" data-no="' + esc(r.no) + '">ดูใบส่งสินค้า</button>');
    if (r.status === "approved" && hr) acts.push('<button class="btn sm" data-act="ship" data-no="' + esc(r.no) + '">อัปเดตเป็น "จัดส่งแล้ว"</button>');
    if (r.status === "shipped" && hr) acts.push('<button class="btn sm ghost" data-act="shipdate" data-no="' + esc(r.no) + '">แก้วันที่จัดส่ง</button>');
    if (r.photo_file_id) acts.push('<button class="btn sm ghost" data-act="photo" data-no="' + esc(r.no) + '">ดูรูปของที่ชำรุด</button>');
    if (r.slip_file_id) acts.push('<button class="btn sm ghost" data-act="slip" data-no="' + esc(r.no) + '">ดูหลักฐานการชำระเงิน</button>');
    if (r.status === "shipped" && hr && !r.notify_sent_at && r.email) acts.push('<button class="btn sm ghost" data-act="notify" data-no="' + esc(r.no) + '">ส่งอีเมลแจ้งอีกครั้ง</button>');
    return '<div class="card reqcard"><h3>' + esc(r.no) + ' <span class="badge ' + r.status + '">' + RSTATUS[r.status] + "</span>" + (r.dn_no ? ' <span class="muted small">' + esc(r.dn_no) + "</span>" : "") + '<span class="spacer"></span><span class="muted small">' + thDateTime(r.created_at) + "</span></h3>" +
      '<div class="kv"><div><span>ผู้เบิก</span> ' + esc(r.name) + " (" + esc(r.emp_code) + ")</div><div><span>ตำแหน่ง</span> " + esc(r.position) + "</div>" + (r.dept ? "<div><span>แผนก</span> " + esc(r.dept) + "</div>" : "") +
      "<div><span>สาขาจัดส่ง</span> " + esc(r.branch) + "</div><div><span>ประเภท</span> " + esc(r.type) + "</div>" + (r.phone ? "<div><span>โทร</span> " + esc(r.phone) + "</div>" : "") + (r.email ? "<div><span>อีเมล</span> " + esc(r.email) + "</div>" : "") + "<div><span>วันที่ขอ</span> " + thDate(r.req_date) + "</div>" +
      (r.kind === "purchase" ? '<div><span>ยอดชำระ</span> <b>' + money(r.amount) + " บาท</b>" + (r.slip_file_id ? ' <span class="badge shipped">แนบสลิปแล้ว</span>' : "") + "</div>" : "") +
      "<div><span>สถานะการจัดส่ง</span> " + deliveryLine(r) + "</div>" +
      (hr && r.status === "shipped" ? "<div><span>แจ้งอีเมล</span> " + (r.notify_sent_at ? '<span class="badge shipped">ส่งแล้ว</span> ' + thDateTime(r.notify_sent_at) : r.notify_error ? '<span class="badge rejected">ส่งไม่สำเร็จ</span> <span class="small muted">' + esc(r.notify_error) + "</span>" : '<span class="muted">—</span>') + "</div>" : "") + "</div>" +
      lines + (r.note ? '<div class="note">หมายเหตุ: ' + esc(r.note) + "</div>" : "") + (r.status === "rejected" && r.decision_note ? '<div class="note red">เหตุผลที่ไม่อนุมัติ: ' + esc(r.decision_note) + "</div>" : "") +
      (r.by_hr || r.edited_at ? '<p class="small muted" style="margin:8px 0 0">' + [r.by_hr ? "HR บันทึกแทนพนักงาน" : "", r.edited_at ? "แก้ไขล่าสุด " + thDateTime(r.edited_at) + (r.edited_by ? " โดย " + esc(r.edited_by) : "") : ""].filter(Boolean).join(" · ") + "</p>" : "") +
      (r.approved_at ? '<p class="small muted" style="margin:8px 0 0">อนุมัติ ' + thDateTime(r.approved_at) + (r.approver_name ? " โดย " + esc(r.approver_name) : "") + (r.shipped_at ? " · จัดส่ง " + thDateTime(r.shipped_at) : "") + "</p>" : "") +
      (acts.length ? '<div class="row" style="margin-top:12px">' + acts.join("") + "</div>" : "") + "</div>";
  }

  function approveDialog(r) {
    var short = r.lines.some(function (l) { return l.available < l.qty; });
    var b = modal("<h2>อนุมัติคำขอ " + esc(r.no) + '</h2><p class="muted">' + esc(r.name) + " · สาขา " + esc(r.branch) + " · " + esc(r.type) + "</p>" +
      (r.kind === "purchase" ? '<div class="note">สั่งซื้อเสื้อเพิ่ม · ยอดชำระ <b>' + money(r.amount) + ' บาท</b> — ตรวจหลักฐานการชำระเงินก่อนอนุมัติ ' + (r.slip_file_id ? '<a href="/api/files/' + r.slip_file_id + '" target="_blank">เปิดดูสลิป</a>' : "(ไม่มีสลิป)") + "</div>" : "") + '<div class="scroll"><table class="t lines"><thead><tr><th>SKU</th><th>รายการ</th><th class="n">คงเหลือ</th><th class="n">ตัด</th><th class="n">หลังตัด</th></tr></thead><tbody>' +
      r.lines.map(function (l) { var after = l.available - l.qty; return "<tr><td>" + esc(l.sku) + "</td><td>" + esc(l.product_name) + " " + esc([l.size, l.color].filter(Boolean).join(" / ")) + '</td><td class="n">' + l.available + '</td><td class="n">−' + l.qty + '</td><td class="n' + (after < 0 ? " short" : "") + '">' + after + "</td></tr>"; }).join("") +
      "</tbody></table></div>" + (short ? '<div class="note red">สต๊อกไม่พอสำหรับบางรายการ — อนุมัติไม่ได้ (ไม่อนุมัติพร้อมเหตุผล หรือรับสินค้าเข้าก่อน)</div>' : '<p class="small muted">เมื่ออนุมัติ ระบบจะตัดสต๊อก บันทึกความเคลื่อนไหว "เบิกออก" และออกใบส่งสินค้าทันที</p>') +
      '<div class="err" id="err"></div><div class="actions"><button class="btn ghost" id="c">ยกเลิก</button><button class="btn" id="ok"' + (short ? " disabled" : "") + ">อนุมัติและออกใบส่งสินค้า</button></div>");
    $("#c", b).onclick = closeModal;
    $("#ok", b).onclick = async function () {
      busy(this, true);
      try { var res = await api("/api/requests/" + encodeURIComponent(r.no) + "/approve", { method: "POST", body: {} }); closeModal(); toast("อนุมัติแล้ว — ออกใบส่งสินค้า " + res.dn); window.open("/dn/" + encodeURIComponent(res.dn), "_blank"); route(); }
      catch (e) { $("#err", b).textContent = e.message; busy(this, false); }
    };
  }
  function rejectDialog(r) {
    var b = modal("<h2>ไม่อนุมัติคำขอ " + esc(r.no) + "</h2>" + field("เหตุผล", '<textarea class="i" id="why" rows="3" placeholder="เช่น ไซส์ L หมด รอของเข้า"></textarea>', true) + '<div class="err" id="err"></div><div class="actions"><button class="btn ghost" id="c">ยกเลิก</button><button class="btn danger" id="ok">ไม่อนุมัติ</button></div>');
    $("#c", b).onclick = closeModal;
    $("#ok", b).onclick = async function () {
      try { await api("/api/requests/" + encodeURIComponent(r.no) + "/reject", { method: "POST", body: { note: $("#why", b).value } }); closeModal(); toast("บันทึกไม่อนุมัติแล้ว"); route(); }
      catch (e) { $("#err", b).textContent = e.message; }
    };
  }

  // Delivery status → "จัดส่งแล้ว" with the delivery date; the server emails the employee.
  function shipDialog(r, editDate) {
    var b = modal("<h2>" + (editDate ? "แก้วันที่จัดส่ง " : "อัปเดตสถานะการจัดส่ง ") + esc(r.no) + '</h2><p class="muted">' + esc(r.name) + " · " + esc(r.dn_no || "") + " · สาขา " + esc(r.branch) + "</p>" +
      field("วันที่จัดส่ง", '<input class="i" type="date" id="sd" value="' + (r.shipped_date ? String(r.shipped_date).slice(0, 10) : today()) + '">', true) +
      (editDate ? '<p class="small muted">แก้เฉพาะวันที่ ไม่ส่งอีเมลซ้ำ</p>' : r.email ? '<p class="small muted">เมื่อบันทึก สถานะจะเป็น "จัดส่งแล้ว" และระบบส่งอีเมลแจ้งไปที่ <b>' + esc(r.email) + "</b></p>" : '<p class="small muted">คำขอนี้ไม่มีอีเมล (ส่งก่อนมีช่องอีเมล) — ระบบจะไม่ส่งอีเมลแจ้ง</p>') +
      '<div class="err" id="err"></div><div class="actions"><button class="btn ghost" id="c">ยกเลิก</button><button class="btn" id="ok">' + (editDate ? "บันทึก" : "บันทึก · จัดส่งแล้ว") + "</button></div>");
    $("#c", b).onclick = closeModal;
    $("#ok", b).onclick = async function () {
      busy(this, true);
      try {
        var res = await api("/api/requests/" + encodeURIComponent(r.no) + (editDate ? "/ship-date" : "/ship"), { method: "POST", body: { date: $("#sd", b).value } });
        closeModal();
        toast(editDate ? "แก้วันที่จัดส่งแล้ว" : res.notify && res.notify.sent ? "จัดส่งแล้ว · ส่งอีเมลแจ้ง " + r.email + " แล้ว" : "จัดส่งแล้ว" + (r.email ? " · ส่งอีเมลไม่สำเร็จ (กดส่งอีกครั้งได้)" : ""));
        route();
      } catch (e) { $("#err", b).textContent = e.message; busy(this, false); }
    };
  }

  // ---------- history ----------
  async function viewHistory(q) {
    var page = Number(q.page || 1);
    var qs = "q=" + encodeURIComponent(q.q || "") + "&branch=" + encodeURIComponent(q.branch || "") + "&category=" + encodeURIComponent(q.category || "");
    var d = await api("/api/history?" + qs + "&page=" + page);
    var branches = state.settings.branches.slice();
    d.byBranch.forEach(function (b) { if (b.branch && branches.indexOf(b.branch) === -1) branches.push(b.branch); });
    var max = d.byBranch.reduce(function (m, b) { return Math.max(m, b.pieces); }, 0) || 1;
    setView('<div class="row"><div><h1>ประวัติการเบิก</h1><p class="sub">' + (isHR() ? "คำขอที่อนุมัติ/จัดส่งแล้ว แยกเป็นรายบรรทัดสินค้า" : "ชุดที่คุณเบิกไปแล้ว") + '</p></div><div class="spacer"></div><a class="btn ghost" href="/api/history.csv?' + qs + '">ส่งออก CSV</a></div>' +
      '<div class="card"><div class="grid3">' + field("ค้นหา", '<input class="i" id="hq" placeholder="ชื่อ รหัสพนักงาน ตำแหน่ง เลขคำขอ/DN" value="' + esc(q.q || "") + '">', false) +
      field("สาขา", '<select class="i" id="hb"><option value="">ทุกสาขา</option>' + branches.map(function (b) { return "<option" + (q.branch === b ? " selected" : "") + ">" + esc(b) + "</option>"; }).join("") + "</select>", false) +
      field("ประเภทชุด (หมวด)", '<select class="i" id="hc"><option value="">ทุกหมวด</option>' + d.categories.map(function (c) { return "<option" + (q.category === c ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("") + "</select>", false) + "</div></div>" +
      '<div class="summary" style="grid-template-columns:repeat(3,1fr)"><div class="sum"><b>' + d.summary.pieces + '</b><span>จำนวนชิ้น</span></div><div class="sum"><b>' + d.summary.employees + '</b><span>จำนวนพนักงาน</span></div><div class="sum"><b>' + d.summary.branches + "</b><span>จำนวนสาขา</span></div></div>" +
      (d.byBranch.length ? '<div class="card"><h3 style="margin-top:0">จำนวนชิ้นแยกตามสาขา (8 อันดับแรก)</h3><div class="bars">' + d.byBranch.map(function (b) { return '<div class="bar"><span>' + esc(b.branch) + '</span><div class="track"><div class="fill" style="width:' + Math.round(b.pieces / max * 100) + '%"></div></div><b class="right">' + b.pieces + "</b></div>"; }).join("") + "</div></div>" : "") +
      '<div class="card">' + (d.rows.length ? '<div class="scroll"><table class="t"><thead><tr><th>วันที่อนุมัติ</th><th>พนักงาน</th><th>ตำแหน่ง</th><th>สาขา</th><th>รายการ</th><th>ไซส์ / สี</th><th class="n">จำนวน</th><th>เอกสาร</th></tr></thead><tbody>' +
        d.rows.map(function (r) { return '<tr><td class="nowrap">' + thDate(r.approved_at) + "</td><td>" + esc(r.name) + '<br><span class="muted small">' + esc(r.emp_code) + "</span></td><td>" + esc(r.position) + "</td><td>" + esc(r.branch) + "</td><td>" + esc(r.product_name) + '<br><span class="muted small">' + esc(r.category) + "</span></td><td>" + esc([r.size, r.color].filter(Boolean).join(" / ")) + '</td><td class="n">' + r.qty + '</td><td class="small"><a href="/dn/' + encodeURIComponent(r.dn_no) + '" target="_blank">' + esc(r.dn_no) + '</a><br><span class="muted">' + esc(r.no) + "</span></td></tr>"; }).join("") +
        "</tbody></table></div>" : '<div class="empty">ยังไม่มีประวัติการเบิก</div>') + pager(page, d.hasMore) + "</div>");
    var go = function () { nav("#/history", { q: $("#hq").value, branch: $("#hb").value, category: $("#hc").value }, true); };
    $("#hq").addEventListener("input", debounce(go, 400)); $("#hb").onchange = go; $("#hc").onchange = go;
    bindPager(function (pg) { nav("#/history", { q: q.q || "", branch: q.branch || "", category: q.category || "", page: pg }); });
    if (q.q) { var h = $("#hq"); h.focus(); h.setSelectionRange(h.value.length, h.value.length); }
  }

  // ---------- settings (HR) ----------
  async function viewSettings() {
    var s = state.settings, products = await api("/api/catalog");
    var priceRows = s.requestTypes.filter(function (t) { return t.priceKey; });
    var linkSel = function (key, label) {
      var cur = (s.itemProducts || {})[key];
      return field(label, '<select class="i" data-link="' + key + '"><option value="">— ไม่ตัดสต๊อก —</option>' + products.map(function (p) { return '<option value="' + p.id + '"' + (cur === p.id ? " selected" : "") + ">" + esc(p.name) + " (" + esc(p.code) + ")</option>"; }).join("") + "</select>", false);
    };
    setView('<h1>ตั้งค่า</h1><p class="sub">ข้อมูลที่ใช้ในแบบฟอร์มขอเบิกและใบส่งสินค้า</p><div class="card">' +
      field("ชื่อหน่วยงานบนใบส่งสินค้า", '<input class="i" id="co" value="' + esc(s.company) + '" placeholder="เช่น บริษัท ตัวอย่าง จำกัด — ฝ่ายทรัพยากรบุคคล">', false) +
      '<p class="small muted">รายชื่อด้านล่างจะแสดงเป็น Dropdown ในแบบฟอร์มของพนักงาน (ถ้าเว้นว่าง จะให้พิมพ์เอง)</p>' +
      '<div class="grid3">' + field("รายชื่อสาขา (บรรทัดละ 1 สาขา)", '<textarea class="i" id="br" rows="10">' + esc(s.branches.join("\n")) + "</textarea>", false) +
      field("รายชื่อตำแหน่ง (บรรทัดละ 1 ตำแหน่ง)", '<textarea class="i" id="ps" rows="10">' + esc((s.positions || []).join("\n")) + "</textarea>", false) +
      field("รายชื่อแผนก / ฝ่าย (บรรทัดละ 1 รายการ)", '<textarea class="i" id="dp" rows="10">' + esc(s.depts.join("\n")) + "</textarea>", false) + "</div>" +
      '<h3>สั่งซื้อเสื้อเพิ่ม</h3><div class="grid2">' +
      field("ราคาตามจำนวน (บรรทัดละ จำนวน=ราคา)", '<textarea class="i" id="pt" rows="5">' + esc(s.priceTable || "") + '</textarea><p class="small muted">จำนวนที่ไม่ได้ระบุ = จำนวน × ราคาของ 1 ตัว · ตัวอย่าง: 3 ตัว = 3 × ' + money(priceFor(1)) + ' = ' + money(priceFor(3)) + " บาท</p>", true) +
      field("ช่องทางการชำระเงิน (แสดงตอนพนักงานกดชำระเงิน)", '<textarea class="i" id="pi" rows="5" placeholder="เช่น โอนเข้าบัญชี … ธนาคาร … เลขที่ … ชื่อบัญชี …">' + esc(s.payInfo || "") + "</textarea>", false) + "</div>" +
      '<h3>สายคล้องคอ / กรอบบัตร / บัตรพนักงาน</h3>' +
      '<p class="small muted">ราคาต่อชิ้น (0 = ไม่มีค่าใช้จ่าย ไม่ต้องชำระเงิน) และสินค้าในสต๊อกที่ใช้ตัดยอดเมื่ออนุมัติ — ถ้าไม่ผูก จะไม่ตัดสต๊อก (เช่น ออกบัตรใหม่) · สินค้าที่ผูกไว้จะไม่แสดงในรายการเสื้อ</p>' +
      '<div class="grid2">' + priceRows.map(function (t) { return field(esc(t.label) + (t.bundle ? " (บาท / ชุด)" : " (บาท / ชิ้น)"), '<input class="i" type="number" min="0" step="1" data-price="' + t.priceKey + '" value="' + (t.price || 0) + '">', false); }).join("") + "</div>" +
      '<div class="grid3">' + linkSel("lanyard", "สินค้าในสต๊อก: สายคล้องคอ") + linkSel("cardholder", "สินค้าในสต๊อก: กรอบบัตร") + linkSel("idcard", "สินค้าในสต๊อก: บัตรพนักงาน") + "</div>" +
      '<p class="small muted">อีเมลแจ้งพนักงานเมื่อจัดส่งแล้ว: ' + (s.mailEnabled ? '<span class="badge shipped">เปิดใช้งาน</span> (ส่งจาก no-reply@uficon.com)' : '<span class="badge rejected">ยังไม่ได้ตั้งค่า</span>') + "</p>" +
      '<div class="err" id="err"></div><button class="btn" id="save">บันทึกการตั้งค่า</button></div>');
    $("#save").onclick = async function () {
      var prices = {}, links = {};
      $$("[data-price]").forEach(function (i) { prices[i.dataset.price] = i.value; });
      $$("[data-link]").forEach(function (i) { links[i.dataset.link] = i.value ? Number(i.value) : null; });
      try {
        await api("/api/settings", { method: "PUT", body: { company: $("#co").value, branches: $("#br").value, positions: $("#ps").value, depts: $("#dp").value, priceTable: $("#pt").value, payInfo: $("#pi").value, prices: prices, itemProducts: links } });
        state.settings = await api("/api/settings"); toast("บันทึกการตั้งค่าแล้ว"); viewSettings();
      }
      catch (e) { $("#err").textContent = e.message; }
    };
  }

  // ---------- users (HR) ----------
  async function viewUsers() {
    var users = await api("/api/users");
    setView('<h1>ผู้ใช้งาน</h1><p class="sub">พนักงานลงทะเบียนเองด้วยรหัสพนักงาน — HR กำหนดสิทธิ์ ปิดบัญชี และรีเซ็ตรหัสผ่านได้ที่นี่</p><div class="card"><div class="scroll"><table class="t"><thead><tr><th>รหัสพนักงาน</th><th>ชื่อ</th><th>ตำแหน่ง / สาขาล่าสุด</th><th>สิทธิ์</th><th>สถานะ</th><th></th></tr></thead><tbody>' +
      users.map(function (u) {
        var self = u.id === state.me.id;
        return "<tr><td>" + esc(u.emp_code) + "</td><td>" + esc(u.name) + '</td><td class="small">' + esc([u.position, u.branch].filter(Boolean).join(" · ")) + "</td><td>" +
          '<select class="i" data-role="' + u.id + '"' + (self ? " disabled" : "") + ' style="max-width:130px"><option value="employee"' + (u.role === "employee" ? " selected" : "") + '>พนักงาน</option><option value="hr"' + (u.role === "hr" ? " selected" : "") + ">HR</option></select></td><td>" +
          (u.disabled ? '<span class="badge cancelled">ปิดบัญชี</span>' : '<span class="badge shipped">ใช้งาน</span>') + '</td><td class="nowrap right">' +
          (self ? "" : '<button class="btn sm ghost" data-reset="' + u.id + '">รีเซ็ตรหัสผ่าน</button> <button class="btn sm ' + (u.disabled ? "" : "danger") + '" data-dis="' + u.id + '" data-v="' + (u.disabled ? "0" : "1") + '">' + (u.disabled ? "เปิดบัญชี" : "ปิดบัญชี") + "</button>") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>");
    $$("[data-role]").forEach(function (s) { s.onchange = async function () { try { await api("/api/users/" + s.dataset.role, { method: "PUT", body: { role: s.value } }); toast("เปลี่ยนสิทธิ์แล้ว"); } catch (e) { alert(e.message); route(); } }; });
    $$("[data-dis]").forEach(function (b) { b.onclick = async function () { try { await api("/api/users/" + b.dataset.dis, { method: "PUT", body: { disabled: b.dataset.v === "1" } }); route(); } catch (e) { alert(e.message); } }; });
    $$("[data-reset]").forEach(function (b) {
      b.onclick = async function () {
        var u = users.find(function (x) { return x.id == b.dataset.reset; });
        if (!confirm("รีเซ็ตรหัสผ่านของ " + u.name + "?")) return;
        try { var r = await api("/api/users/" + u.id + "/reset-password", { method: "POST", body: {} }); var mb = modal("<h2>รหัสผ่านชั่วคราว</h2><p>" + esc(u.name) + " (" + esc(u.emp_code) + ')</p><p style="font-size:24px;font-weight:700;letter-spacing:.1em">' + esc(r.password) + '</p><p class="small muted">แจ้งพนักงานให้เข้าสู่ระบบแล้วเปลี่ยนรหัสผ่านทันที — รหัสนี้จะไม่แสดงอีก</p><div class="actions"><button class="btn" id="ok">ปิด</button></div>'); $("#ok", mb).onclick = closeModal; }
        catch (e) { alert(e.message); }
      };
    });
  }

  // ---------- routing ----------
  function parseHash() {
    var h = location.hash.replace(/^#/, "") || "/", i = h.indexOf("?");
    var path = i === -1 ? h : h.slice(0, i), q = {};
    if (i !== -1) h.slice(i + 1).split("&").forEach(function (kv) { var p = kv.split("="); if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ""); });
    return { path: path, q: q };
  }
  function nav(path, q, replace) {
    var s = Object.keys(q || {}).filter(function (k) { return q[k] !== "" && q[k] != null; }).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(q[k]); }).join("&");
    var h = "#" + path.replace(/^#/, "") + (s ? "?" + s : "");
    if (replace) { history.replaceState(null, "", h); route(); } else location.hash = h;
  }
  function pager(page, more) { return page > 1 || more ? '<div class="row" style="margin-top:12px;justify-content:center">' + (page > 1 ? '<button class="btn sm ghost" data-pg="' + (page - 1) + '">← ก่อนหน้า</button>' : "") + '<span class="muted small">หน้า ' + page + "</span>" + (more ? '<button class="btn sm ghost" data-pg="' + (page + 1) + '">ถัดไป →</button>' : "") + "</div>" : ""; }
  function bindPager(fn) { $$("[data-pg]").forEach(function (b) { b.onclick = function () { fn(Number(b.dataset.pg)); }; }); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  async function route() {
    closeModal(); $("#nav").classList.remove("open"); $("#top").classList.remove("open");
    var r = parseHash();
    try {
      if (!state.me) { renderShell(); return viewAuth(r.path === "/register" ? "register" : r.path === "/setup" ? "setup" : "login"); }
      renderShell();
      var p = r.path;
      if (p === "/" || p === "/login" || p === "/register" || p === "/setup") { location.replace(isHR() ? "#/requests" : "#/new"); return; }
      if (p === "/new") return await viewNew(r.q);
      if (p === "/requests") return await viewRequests(r.q);
      if (p === "/history") return await viewHistory(r.q);
      if (isHR()) {
        if (p === "/stock") { state.categories = (await api("/api/catalog")).map(function (x) { return x.category; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }); return await viewStock(r.q); }
        var m = p.match(/^\/stock\/(\d+)$/); if (m) return await viewProduct(m[1], r.q);
        if (p === "/settings") return await viewSettings();
        if (p === "/users") return await viewUsers();
      }
      setView('<div class="card empty">ไม่พบหน้านี้ หรือไม่มีสิทธิ์เข้าถึง</div>');
    } catch (e) { if (state.me) setView('<div class="card empty">' + esc(e.message) + "</div>"); }
  }
  async function boot() {
    state.me = (await api("/api/me")).user;
    if (state.me) state.settings = await api("/api/settings");
  }
  window.addEventListener("hashchange", route);
  boot().then(route).catch(function () { app.innerHTML = '<div class="card empty">เชื่อมต่อระบบไม่สำเร็จ กรุณารีเฟรช</div>'; });
})();
