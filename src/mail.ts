/**
 * Email to the employee when HR marks a request as shipped (htask-1792149268859 #4).
 * Same company SMTP relay as the other HR apps (no-reply@uficon.com). A mail
 * failure never blocks the status change — the result is stored on the request
 * (notify_sent_at / notify_error) so HR can see it and resend.
 */
import nodemailer from "nodemailer"

const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://uniform-stock.coolify.pve01.prod.uficon.com"
const SMTP_USER = process.env.SMTP_USER ?? "no-reply@uficon.com"
// mail.uficon.com only accepts mail whose From is the authenticated account ("550 From address must
// match authenticated address"). SMTP_FROM came through the env with escaped quotes (\"Name\" <addr>),
// which nodemailer parsed into a garbage address — so take only the display name from it and always
// send as SMTP_USER.
const FROM = {
  name: (process.env.SMTP_FROM ?? "").replace(/<[^>]*>/g, "").replace(/[\\"]/g, "").trim() || "UFicon Uniform (HR)",
  address: SMTP_USER,
}

const transporter = process.env.SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "mail.uficon.com",
      port: Number(process.env.SMTP_PORT ?? 25),
      secure: false,
      auth: { user: SMTP_USER, pass: process.env.SMTP_PASSWORD },
      tls: { rejectUnauthorized: false },
    })
  : null

export const mailEnabled = !!transporter

function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

type Req = { no: string; dn_no: string | null; name: string; branch: string; type: string; email: string; shipped_date: any }
type Line = { product_name: string; size: string; color: string; qty: number; unit: string }

export function shippedEmail(r: Req, lines: Line[], dateTH: string): { subject: string; html: string } {
  const rows = lines.map((l) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e6ecec;">${esc(l.product_name)}</td><td style="padding:6px 8px;border-bottom:1px solid #e6ecec;">${esc([l.size, l.color].filter(Boolean).join(" / "))}</td><td style="padding:6px 8px;border-bottom:1px solid #e6ecec;text-align:right;">${l.qty} ${esc(l.unit)}</td></tr>`).join("")
  const html = `<div style="font-family:Arial,'Sarabun',sans-serif;background:#f4f7f7;padding:20px 10px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #dde5e5;">
    <div style="background:#0a5f66;color:#fff;padding:18px 22px;"><div style="font-size:12px;opacity:.85;">ระบบเบิกจ่ายชุดยูนิฟอร์ม</div><div style="font-size:18px;font-weight:700;margin-top:4px;">จัดส่งรายการที่ขอแล้ว</div></div>
    <div style="padding:18px 22px;font-size:14px;color:#1f2d2d;line-height:1.6;">
      <p style="margin:0 0 10px;">เรียน คุณ${esc(r.name)}</p>
      <p style="margin:0 0 10px;">HR ได้จัดส่งรายการตามคำขอของคุณแล้ว</p>
      <table style="font-size:14px;margin:0 0 12px;">
        <tr><td style="color:#5b6b6b;padding-right:12px;">เลขที่คำขอ</td><td><b>${esc(r.no)}</b></td></tr>
        ${r.dn_no ? `<tr><td style="color:#5b6b6b;padding-right:12px;">ใบส่งสินค้า</td><td>${esc(r.dn_no)}</td></tr>` : ""}
        <tr><td style="color:#5b6b6b;padding-right:12px;">ประเภท</td><td>${esc(r.type)}</td></tr>
        <tr><td style="color:#5b6b6b;padding-right:12px;">วันที่จัดส่ง</td><td><b>${esc(dateTH)}</b></td></tr>
        <tr><td style="color:#5b6b6b;padding-right:12px;">จัดส่งที่</td><td>${esc(r.branch)}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;"><tr style="background:#f1f5f5;"><th style="text-align:left;padding:6px 8px;">รายการ</th><th style="text-align:left;padding:6px 8px;">ไซส์</th><th style="text-align:right;padding:6px 8px;">จำนวน</th></tr>${rows}</table>
      <p style="margin:16px 0 0;"><a href="${APP_ORIGIN}/#/requests" style="background:#0a5f66;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;">ดูคำขอของฉัน</a></p>
      <p style="margin:14px 0 0;color:#5b6b6b;font-size:12.5px;">อีเมลนี้ส่งอัตโนมัติจากระบบ กรุณาอย่าตอบกลับ หากมีข้อสงสัยติดต่อ HR</p>
    </div>
  </div></div>`
  return { subject: `จัดส่งรายการที่ขอแล้ว — ${r.no} (${dateTH})`, html }
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  if (!transporter) throw new Error("ยังไม่ได้ตั้งค่าอีเมลบนเซิร์ฟเวอร์")
  await transporter.sendMail({ from: FROM, envelope: { from: SMTP_USER, to }, to, subject, html })
}
