# SWD Audit Registry (ทะเบียนผลตรวจบนเชน)

English: [SWD_AUDIT_REGISTRY.md](SWD_AUDIT_REGISTRY.md) (ฉบับเต็ม ใช้อ้างอิงหลัก)

`programs/swd_audit_registry` เป็นโปรแกรม Solana ของ SAWASDEE COIN (SWD) ที่เก็บ **ผล SWD Audit ล่าสุด** ของแต่ละโทเคนหรือสัญญา
ไว้บนเชน กระเป๋า, DEX และโปรแกรมอื่นอ่านระดับความเสี่ยงได้จาก PDA โดยตรง ไม่ต้องเรียก API และไม่ต้องรอให้เว็บ SWD ออนไลน์

> **สถานะ (2026-11-06): ร่างที่ยังไม่ผ่านการ audit และยังไม่ได้ deploy ที่ไหนเลย** program id ใน `declare_id!` และ `Anchor.toml`
> เป็นค่าชั่วคราว ดูหัวข้อ "ก่อนขึ้น mainnet" ด้านล่าง

ทะเบียนนี้ไม่ได้มาแทนการบันทึกด้วย memo แบบเดิม (`lib/audit/attest-anchor.ts`) memo เป็นหลักฐานราคาถูกว่ามี attestation อยู่จริง
ส่วนทะเบียนเป็นสถานะที่ **ค้นได้ด้วย address** โดยมี record ปัจจุบันหนึ่งรายการต่อหนึ่งสัญญา

## 1. บัญชี

**Config** มี PDA เป็น `["config"]` ขนาด 284 ไบต์ เก็บค่าเหล่านี้:

- `authority` คือ Squads vault บน mainnet
- `pending_authority` ใช้ตอนโอนสิทธิ์แบบสองขั้น
- `paused`
- `record_count`
- รายชื่อ attestor ได้สูงสุด 4 คีย์ แต่ละคีย์มี `{pubkey, key_id 8 ไบต์, status, since}`

สถานะของ attestor มี 3 แบบ:

- **1 active** ลงนาม record ใหม่ได้
- **2 retired** ลงนามใหม่ไม่ได้ แต่ record ที่เคยลงนามไว้ยังเชื่อถือได้
- **3 revoked** record ที่คีย์นี้ลงนามไว้ถือว่าเชื่อไม่ได้ และจะคืนสถานะคีย์ไม่ได้อีกเลย

**Record** มี PDA เป็น `["audit", chain_id (u16 LE), sha256(address ที่ normalize แล้ว)]` ขนาด **146 + ความยาว address**
(mint ของ Solana ได้ 190 ไบต์)

| offset | ฟิลด์ |
|---|---|
| 10 | chain_id |
| **12** | **level** (0 info, 1 low, 2 medium, 3 high) |
| **13** | **revoked** |
| 14 | address_hash |
| 46 | verdict |
| 78 | payload_hash |
| 110 | mldsa_key_id |
| 118 | ed25519_key_id |
| 126 | audited_at |
| 134 | updated_slot |
| 142 | ความยาว address |
| 146 | address |

รหัสเชน (ห้ามเปลี่ยนเลข): 1 eth, 2 bsc, 3 base, 4 arbitrum, 5 zetaphy, 6 sol, 7 sui, 8 aptos, 9 osmosis, 10 neutron,
11 near, 12 starknet, 13 bitcoin, 14 ton

กฎ address:

- EVM ต้องเป็นตัวพิมพ์เล็กทั้งหมด (โปรแกรมบังคับเอง)
- Solana ต้องเป็น base58 ยาว 32 ถึง 44 ตัวอักษร
- เชนอื่นใช้สตริงเดียวกับที่เว็บตรวจ เป็น ASCII ที่พิมพ์ได้และไม่มีช่องว่าง

## 2. คำสั่ง

- `initialize` เรียกได้เฉพาะ **upgrade authority** ของโปรแกรม จึงไม่มีใครชิงตั้งค่าก่อนได้หลัง deploy
- `upsert_record` **ใครส่งก็ได้** (relayer หรือ crank) แต่ต้องมีลายเซ็น Ed25519 จาก attestor ที่ active ครอบ record ทุกไบต์ ดูรายละเอียดด้านล่าง
- `revoke_record` และ `restore_record` เรียกได้เฉพาะ authority ส่วน record ที่ถูก revoke แล้วจะอัปเดตไม่ได้
- `set_attestors` ใช้หมุนเวียนคีย์ ส่วน `set_paused` ใช้หยุดหรือเปิดการเขียน
- `propose_authority` แล้วตามด้วย `accept_authority` ใช้โอนสิทธิ์แบบสองขั้น เช่น จาก deployer ไป Squads vault

ทุกคำสั่งปล่อย event ออกมา

**สิ่งที่ `upsert_record` ตรวจ**

1. ทะเบียนไม่ได้หยุดอยู่
2. รู้จักรหัสเชน address ถูกรูปแบบ `address_hash == sha256(address)` และ level ไม่เกิน 3
3. `audited_at` มากกว่า 0 และไม่เกินเวลาปัจจุบันบวก 300 วินาที
4. คำสั่ง **ที่อยู่ก่อนหน้าทันที** ต้องเป็นคำสั่งของ Ed25519 precompile โดย:
   - มีลายเซ็นเดียว
   - offset ทั้งสามชี้อยู่ **ในคำสั่งนั้นเอง** (0xFFFF) เพื่อกันบั๊กประเภทเดียวกับ Wormhole ปี 2022
   - pubkey ต้องเป็น attestor ที่ active และ key id ต้องตรงกับ pubkey
   - ข้อความต้องตรงกับ `record_message` ทุกไบต์
5. ถ้ามี record อยู่แล้ว record นั้นต้องไม่ถูก revoke และ `audited_at` ต้อง **ใหม่กว่า** ค่าเดิมเท่านั้น ถอยกลับไม่ได้

ทะเบียนจึง **เชื่อลายเซ็น ไม่ได้เชื่อคนที่ส่งธุรกรรม**

ข้อความที่ลงนามยาว 177 ไบต์ ประกอบด้วย `"swd.audit-registry.v1\0"` ตามด้วย Config PDA, chain_id, sha256(address), level, verdict,
payload_hash, key id ทั้งสอง และ audited_at การรวม Config PDA ไว้ในข้อความทำให้ลายเซ็นของ devnet เอาไปใช้บน mainnet ไม่ได้
golden vector ชุดเดียวกันถูกทดสอบทั้งใน Rust และ TypeScript

## 3. ความไว้ใจ

**record หนึ่งรายการพิสูจน์ว่า** คีย์ audit ของ SWD ที่ active ในตอนนั้นได้ลงนามรับรอง level, verdict และ hash ของ attestation
สำหรับ (เชน, address) นี้ ในทะเบียนนี้

**สิ่งที่ record ไม่ได้พิสูจน์**

- **ไม่ได้พิสูจน์ว่าผลตรวจถูกต้อง** Neuro เป็นเครื่องตรวจตามกฎตายตัว ผล "low" ไม่ใช่การรับประกัน
- **ไม่ได้ตรวจ ML-DSA-44 (ลายเซ็นทนควอนตัม)** Solana ไม่มี syscall สำหรับ ML-DSA และลายเซ็นยาวถึง 2,420 ไบต์
  บนเชนจึงเก็บไว้แค่ **ML-DSA key id** กับ **payloadHash** ส่วนการตรวจลายเซ็นคู่ (hybrid) แบบเต็มต้องทำนอกเชน ดังนี้:
  1. ดึง attestation มาจากเว็บ
  2. ตรวจว่า sha256(canonical(payload)) เท่ากับ `payload_hash`
  3. รัน `verifyAttestation`
  4. เทียบฟิลด์ใน payload กับ record

  ความปลอดภัยบนเชนจึงพึ่ง Ed25519 แบบคลาสสิกอย่างเดียว
- **ไม่ได้รับประกันว่าจะมีคนส่ง record** ถ้าไม่มี record หรือ record เก่า แปลว่า "ไม่ทราบ" ไม่ได้แปลว่า "ปลอดภัย"
  ผู้อ่านต้องกำหนดนโยบายเอง

**กรณีคีย์หลุด** ให้ทำผ่าน Squads proposal เรียก `set_attestors` ตั้งคีย์ที่หลุดเป็น revoked และเพิ่มคีย์ใหม่ที่ active
record ทุกรายการที่คีย์นั้นลงนามจะกลายเป็นเชื่อไม่ได้ทันที จากนั้นลงนามใหม่ด้วยคีย์ใหม่ ถ้าจำเป็นก็ revoke แล้ว restore record ที่เกี่ยวข้อง

**ข้อจำกัด**

- ถ้าลบคีย์ออกจากรายชื่อ คีย์นั้นจะถือเป็น "ไม่รู้จัก" ซึ่งก็คือเชื่อไม่ได้ จึงต้อง **เก็บคีย์ที่ retired ไว้ในรายชื่อ**
- record ปิดไม่ได้ ค่า rent จึงค้างอยู่ตลอด
- ทะเบียนเก็บเฉพาะผลตรวจแบบ `contract` เท่านั้น

## 4. การอ่าน

ใน TypeScript ให้หา PDA แล้วอ่าน `data[12]` ซึ่งเป็น level และ `data[13]` ซึ่งเป็นสถานะ revoked
ใน Rust ใช้ `swd_audit_registry::reader::trusted_level(config, record, chain_id, address)` ค่าที่ได้คืนมี 3 แบบ:

- `None` แปลว่าไม่มี record, record ถูก revoke หรือคีย์ไม่น่าเชื่อถือ
- `Some(level)` แปลว่าได้ระดับที่เชื่อถือได้
- `Err` แปลว่ามีคนส่งบัญชีปลอมเข้ามา

ตัวอย่างโค้ดเต็มอยู่ในฉบับภาษาอังกฤษ ทั้งฝั่งกระเป๋าหรือ DEX และโปรแกรมที่บล็อก level ≥ high

## 5. เว็บจะเขียน record อย่างไร (ยังไม่ได้ทำในเว็บ)

1. เมื่อ `runAudit` ได้ attestation แบบ `contract` เซิร์ฟเวอร์จะลงนาม `record_message` ด้วย **คีย์ Ed25519 audit ตัวเดียวกัน**
2. นำลายเซ็นไปเข้าคิวใน KV โดยเก็บไว้เฉพาะ `audited_at` ที่ใหม่ที่สุดของแต่ละ address
3. cron จะส่งธุรกรรมแบบ `[Ed25519, upsert_record]` ทีละหนึ่ง record ผู้จ่ายค่าธรรมเนียมเป็น **กระเป๋า relayer แยกต่างหาก**
   ห้ามใช้กระเป๋าโปรเจกต์หรือกระเป๋า claim ต้องมีเพดานจำนวนต่อวันและยอดคงเหลือขั้นต่ำ
   ถ้าเจอ `StaleRecord` ให้ถือว่าเขียนไปแล้ว
4. ใครจะรัน relayer ของตัวเองก็ได้ เพราะทะเบียนเชื่อลายเซ็นเป็นหลัก

## 6. ค่าใช้จ่าย

- record ใหม่หนึ่งรายการ (mint ของ Solana): rent **2,213,280 lamports (ประมาณ 0.0022 SOL หรือราว $0.33)** จ่ายครั้งเดียว
  บวกค่าธรรมเนียม 10,000 lamports (ลายเซ็นของธุรกรรม 1 + ลายเซ็นของ precompile 1)
- การอัปเดต: 10,000 lamports ต่อครั้ง
- ได้ **หนึ่ง record ต่อหนึ่ง legacy transaction** (ประมาณ 810 ไบต์)
- โดยรวม 1,000 โทเคนใช้ rent ราว 2.2 SOL ครั้งเดียว

## 7. Deploy

**Devnet:** สร้าง keypair แล้วใส่ id ลงใน `declare_id!` และ `Anchor.toml` จากนั้น `anchor build -p swd_audit_registry`
แล้ว deploy ด้วยมือ (job "deploy to Devnet" ของ CI จะ deploy แค่ `swd_amm`) เรียก `initialize` ด้วยคีย์ audit ของ devnet
แล้วรัน relayer อย่างน้อยหนึ่งสัปดาห์

**Mainnet** ใช้ขั้นตอนเดียวกับ `docs/MAINNET_RUNBOOK.md`:

1. **ให้ผู้ตรวจอิสระ audit ก่อน**
2. ใช้คีย์ใหม่ทั้งหมด ได้แก่ deployer ที่ใช้ครั้งเดียว, คีย์ audit ของ mainnet และกระเป๋า relayer
3. ทำ verified build
4. deploy
5. เรียก `initialize(authority = Squads vault)`
6. โอน upgrade authority ไปให้ Squads vault
7. ตรวจสอบบนเชน
8. หลังจากนั้นการเปลี่ยนแปลงทุกอย่างต้องเป็น Squads proposal แบบ 2 ใน 3

## ก่อนขึ้น mainnet

- [ ] audit อิสระเสร็จ และแก้ไขแล้วผ่านการตรวจซ้ำ
- [ ] รันบน devnet โดยให้ relayer ของเว็บเขียนจริงอย่างน้อยหนึ่งสัปดาห์
- [ ] เผยแพร่ hash ของ verified build
- [ ] Squads vault เป็นทั้ง authority และ upgrade authority
- [ ] สร้างคีย์ audit ของ mainnet ใหม่และเผยแพร่ key id แล้ว แยกกระเป๋า relayer ออกจากกระเป๋าอื่น
