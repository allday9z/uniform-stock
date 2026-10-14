# Uniform Stock — ระบบเบิกจ่ายชุดยูนิฟอร์ม

Shared web app for HR uniform stock + employee requisitions: stock per SKU (size × color) with movement history, employee request form, HR approval that cuts stock and issues a delivery note in one transaction, shipping confirmation, and requisition history (filters, per-branch chart, CSV export).

Built from `uniform-stock-spec.md` (HR prototype spec, 14 Oct 2569).

## Roles
- **HR** — stock, products/SKUs, receive / adjust, approve / reject / ship, settings, users.
- **Employee** — submit requests, see / cancel own pending requests, own history. **Never** receives stock quantities: `/api/catalog` strips qty/min/status and every stock endpoint answers 403.

Employees self-register with their employee code. The first HR account is created at `/#/setup` with `HR_SETUP_CODE` (works only while no HR exists); after that HR grants HR role from **ผู้ใช้งาน**.

## Data integrity
- Approval = one DB transaction: lock request + variant rows (`FOR UPDATE`, id order), re-check stock, decrement, write `out` movements, issue DN.
- `uni_variants.qty` has `CHECK (qty >= 0)`. Concurrent approvals of the same SKU can't go negative (tested).
- Every qty change writes a `uni_moves` row (in / out / adj). Existing SKU qty can only change via receive / adjust.
- Document numbers are running per day: `REQ-ปปดดวว-0001`, `DN-ปปดดวว-0001` (พ.ศ.).

## Run
```
DATABASE_URL=postgres://… HR_SETUP_CODE=… PORT=3000 bun src/server.ts
```
Tables are prefixed `uni_` (shared Postgres). Schema is created/migrated on start.
