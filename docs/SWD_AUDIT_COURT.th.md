> English: [SWD_AUDIT_COURT.md](SWD_AUDIT_COURT.md)

# SWD Audit Court — ให้ชุมชนโต้แย้งผล SWD Audit

> **สถานะ: ร่าง ยังไม่ผ่าน audit และยังไม่ deploy** ต้องผ่าน audit อิสระก่อนใช้บน mainnet
> โปรแกรม: `programs/swd_audit_court` · เทสต์: `programs/swd_audit_court/src/logic.rs` (Rust),
> `tests/swd_audit_court.ts` (validator ในเครื่อง)

## ทำไม

ผล SWD Audit เซ็นโดยคีย์ attestor ของ SWD และเก็บใน SWD Audit Registry (`programs/swd_audit_registry`)
ศาลนี้ให้ชุมชนโต้แย้งผลโดยวางเงินประกัน (bond) ตัดสินด้วยการโหวตที่ถ่วงน้ำหนักด้วย badge และบันทึกคำตัดสินบนเชน
ศาล **ไม่เขียนลง registry** (เป็นอีกโปรแกรม ยังไม่ deploy) — เก็บคำตัดสินไว้และส่ง event `DisputeResolved`
ให้ authority ของ registry นำไปใช้เอง

## ขั้นตอน

1. **`open_dispute(chain_id, address_hash, disputed_payload_hash, claimed_level, evidence_hash)`** — ใครก็ได้;
   โอน `bond_amount` SWD เข้า vault ของ dispute นั้น ระบุเหรียญแบบเดียวกับ registry: `chain_id` (u16) และ
   `address_hash = sha256(ที่อยู่ที่ normalize แล้ว)` ศาลคำนวณ Record PDA ของ registry
   `["audit", chain_id LE, address_hash]` ไว้ (ไม่อ่าน/ไม่เขียน) `disputed_payload_hash` ระบุ attestation ที่โต้แย้ง,
   `claimed_level` (0..3 หรือ 255) ระดับที่ผู้เปิดเห็นว่าถูก, `evidence_hash` = sha256 ของเอกสารหลักฐานนอกเชน
2. **`defend`** (ไม่บังคับ) — ผู้แก้ต่าง 1 คนวาง bond เท่ากันระหว่างโหวต
3. **`vote(support)`** — ผู้ถือ badge ระหว่างช่วงโหวต; `VoteRecord` PDA ต่อ (dispute, ผู้โหวต) ทำให้โหวตซ้ำไม่ได้
   ผู้เปิดและผู้แก้ต่างโหวตไม่ได้
4. **`finalize`** — ใครก็ได้ หลัง `voting_ends_at`:
   - `yes + no < quorum` → **NoQuorum** คืนเงินทุกคน
   - `yes / (yes + no) > pass_bps` (มากกว่าอย่างเดียว) → **Upheld** (ผู้โต้แย้งชนะ)
   - นอกนั้น → **Rejected**
   ผู้ชนะได้ bond คืน bond ของผู้แพ้แบ่ง `winner_share_bps` ให้ผู้ชนะ ที่เหลือเข้า treasury
   ถ้า Rejected และไม่มีผู้แก้ต่าง bond ของผู้เปิดเข้า treasury ทั้งหมด ค่าเช่า vault คืนผู้เปิด
   โทเคนที่มีคนโอนเข้า vault เกินมาจะเข้า treasury (กันไม่ให้ใครแกล้งบล็อกการปิด vault)
5. authority ของ registry ดู `DisputeResolved { status = 1 (Upheld), record, … }` แล้วแก้ใน registry และเรียก **`mark_applied`** ได้

## ตรวจ badge (soulbound)

ผู้โหวตส่ง **token account** badge ของ Token-2022 เป็น remaining accounts แต่ละบัญชีต้อง:

- เป็นของโปรแกรม Token-2022; `owner == ผู้โหวต`; `amount >= 1`; `mint ∈ config.badges`
- มี extension `NonTransferableAccount` (Token-2022 ใส่ให้ทุกบัญชีของ mint ที่เป็น `NonTransferable`)

ตอนแอดมินตั้งค่า badge แต่ละ **mint** ต้องเป็น Token-2022 ที่มี `NonTransferable` (ถอด extension ของ mint ไม่ได้ จึงจริงตลอดไป)
น้ำหนัก = ผลรวมน้ำหนักของ mint ที่ **ไม่ซ้ำกัน** (ส่ง mint เดิมสองครั้งนับครั้งเดียว) น้ำหนัก 1..1000, สูงสุด 8 mint

## บัญชีและค่าใช้จ่าย

| บัญชี | seeds | ขนาด | ค่าเช่า | อายุ |
| --- | --- | --- | --- | --- |
| `Config` | `["court"]` | 484 B | ~0.0043 SOL | ถาวร |
| `Dispute` | `["dispute", id u64 LE]` | 312 B | ~0.0031 SOL | ถาวร (เป็นบันทึกคำตัดสิน; ผู้เปิดจ่าย) |
| vault (SPL token account) | `["vault", dispute]` | 165 B | ~0.0020 SOL | ปิดตอน finalize/cancel ค่าเช่าคืนผู้เปิด |
| `VoteRecord` | `["vote", dispute, voter]` | 90 B | ~0.0015 SOL | ผู้โหวตปิดคืนได้หลังตัดสิน (`close_vote`) |

เปิด dispute = bond + ~0.005 SOL (ได้คืน 0.002 ตอนจบ) ขนาดโปรแกรม ~510 KB → ค่าเช่า ~3.5 SOL
แต่ละ dispute **บันทึกค่า** bond, quorum, `pass_bps`, `winner_share_bps`, treasury ไว้ตอนเปิด แก้ config ทีหลังไม่กระทบ dispute ที่เปิดอยู่

## แอดมิน (Squads vault)

| คำสั่ง | ผล |
| --- | --- |
| `initialize` | ครั้งเดียว โดย **upgrade authority** ของโปรแกรมเท่านั้น (กัน front-run หลัง deploy) |
| `update_config` | bond, ช่วงโหวต, quorum, pass_bps, ส่วนแบ่งผู้ชนะ, treasury, id ของ registry, รายการ badge — ใช้กับ dispute ใหม่ |
| `set_paused` | หยุด `open_dispute`, `defend`, `vote` — **ไม่เคย** หยุด `finalize` |
| `propose_admin` / `accept_admin` | ส่งต่อสิทธิ์ 2 ขั้น |
| `cancel_dispute` | ระหว่างโหวต; **คืนเงินทุกคนเต็มจำนวน** |
| `mark_applied` | เฉพาะ Upheld ครั้งเดียว |

ขอบเขตในโค้ด: bond > 0; ช่วงโหวต 5 วินาที..30 วัน (feature `mainnet` บังคับขั้นต่ำ **3 วัน** และรับเฉพาะ SWD mint เป็น bond);
quorum > 0; `pass_bps` 5000..9000; `winner_share_bps` ≤ 10000; badge 1..8

## ความเชื่อใจ (trust model)

- **ไม่มีใครเอา bond ไปได้** — ออกจาก vault ได้แค่ `finalize` (ตามกฎ ไปยัง ATA ของผู้เปิด/ผู้แก้ต่าง/treasury) หรือ `cancel_dispute` (คืนเต็ม)
  ผลรวมการจ่ายเท่ากับเงินประกันพอดี (มีเทสต์หลายค่า)
- จ่ายเข้า **associated token account** ถ้ามีคนปิดบัญชีไว้ ใครก็สร้างใหม่ได้แล้ว finalize ต่อได้ — บล็อกคำตัดสินด้วยการปิดบัญชีไม่ได้
- **ผู้ออก badge ต้องเชื่อใจได้** — ผู้ถือ mint authority ของ badge mint แจกให้หลายกระเป๋าได้ (Sybil) ควรให้ Squads คุม
- อำนาจแอดมินที่สำคัญ: ยกเลิก dispute (คืนเงิน ไม่เสียหาย แต่เป็นการเซ็นเซอร์), pause (โหวตหยุด อาจจบแบบ NoQuorum → คืนเงิน),
  เปลี่ยนรายการ badge (มีผลกับโหวตหลังจากนั้น) — ใช้ Squads
- **upgrade authority** เปลี่ยนได้ทุกอย่าง — Squads + timelock
- ศาลไม่ตรวจว่ามี record ใน registry จริงไหม (registry ยังไม่ deploy)

## ข้อจำกัด

- โหวตเปิดเผยทันที (ไม่มี commit–reveal) คนโหวตทีหลังเห็นผลรวม
- ไม่มีอุทธรณ์ เปิด dispute ใหม่ได้ (วาง bond ใหม่)
- dispute หลายอันเรื่องเดียวกันเปิดพร้อมกันได้ ให้ authority ของ registry ตัดสินใจ
- bond เป็น SPL token แบบคลาสสิก (SWD) ไม่รองรับ Token-2022 (transfer fee ทำให้บัญชีเงินประกันเพี้ยน)

## Deploy (devnet)

```bash
anchor build -p swd_audit_court
solana-keygen new -o target/deploy/swd_audit_court-keypair.json   # ครั้งเดียว เก็บให้ดี
anchor keys list   # ใส่ id ใน declare_id! ของ lib.rs และ Anchor.toml (ทั้งสองส่วน)
anchor build -p swd_audit_court
anchor deploy -p swd_audit_court --provider.cluster devnet   # ผู้ deploy = upgrade authority
```

จากนั้นผู้ deploy เรียก `initialize` (admin = Squads vault บน devnet หรือคีย์ทดสอบ, bond mint = SWD ทดสอบ,
id ของ registry, และ badge mint เป็น remaining accounts) งาน deploy ของ CI deploy แค่ `swd_amm`
build สำหรับ mainnet: `anchor build -p swd_audit_court -- --features mainnet`

## เทสต์

- `cargo test -p swd_audit_court` — ผลการตัดสิน (quorum, เสียงข้างมาก, supermajority, ไม่ overflow), ผลรวมการจ่ายเท่าเงินประกัน,
  กรณีการจ่าย, ขอบเขตพารามิเตอร์, น้ำหนัก mint ไม่ซ้ำ, ขนาดบัญชี, Record PDA ตรงกับ registry
- `tests/swd_audit_court.ts` — init เฉพาะ upgrade authority, badge ที่ไม่ใช่ soulbound ถูกปฏิเสธ, เปิด/แก้ต่าง/โหวตถ่วงน้ำหนัก,
  โหวตซ้ำไม่ได้, badge ของคนอื่น/ไม่มี badge ถูกปฏิเสธ, cancel, pause (finalize ยังทำได้), NoQuorum/Upheld/Rejected และยอดเงิน,
  การโอนเข้า vault บล็อก finalize ไม่ได้, mark_applied, close_vote, ส่งต่อแอดมิน

## ก่อนขึ้น mainnet

- audit อิสระของโปรแกรมนี้
- admin และ upgrade authority = Squads vault (timelock)
- กำหนด bond, ช่วงโหวต (≥ 3 วัน), quorum, น้ำหนัก badge ร่วมกับชุมชน และประกาศให้ชัด
- ฝั่ง registry: ขั้นตอนนำคำตัดสิน Upheld ไปใช้ (audit ใหม่ → record ใหม่ที่เซ็นแล้ว) แล้วเรียก `mark_applied`
