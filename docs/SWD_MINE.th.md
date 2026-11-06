[English](SWD_MINE.md) | **ภาษาไทย**

# SWD Mine — จ่ายรางวัลการขุดแบบตรวจสอบบนเชน

`programs/swd_mine` จ่าย SWD (SAWASDEE COIN, mint
`Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL`, SPL Token แบบคลาสสิก, ทศนิยม 5 ตำแหน่ง)
ให้กับ proof-of-work จากบราวเซอร์ **โดยไม่ต้องมี hot wallet**

> **สถานะ (2026-11-06): ร่างที่ยังไม่ผ่านการ audit ยังไม่ได้ deploy บนเครือข่ายใดเลย**
> ลำดับ: เทสต์ localnet (CI) → devnet → **audit อิสระ** → mainnet ผ่าน Squads
> ห้ามใส่ SWD จริงลงใน vault ก่อนผ่าน audit

## ทำไม

ปัจจุบันเว็บ (`swd-claim-site`, `lib/mine/swd-server.ts`) ตรวจ proof นอกเชน เก็บยอดใน KV
และจ่ายการถอนโดย **ร่วมเซ็นด้วย hot mining wallet** ซึ่ง secret key (`MINE_WALLET_SECRET_KEY`)
อยู่บนเว็บเซิร์ฟเวอร์ ใครขโมยคีย์นั้นได้ก็เอาทุกอย่างใน mining wallet ไป และยอดทุกยอดเชื่อได้เท่าที่ฐานข้อมูล KV เชื่อได้

เมื่อใช้ `swd_mine`:

- SWD อยู่ใน **vault token account ที่ PDA ของโปรแกรมเป็นเจ้าของ** ไม่มี private key ใดย้ายได้
  ย้ายได้เฉพาะ `claim` (ให้คนที่ขุดได้) และ `withdraw_unused` (ให้ authority ขณะหยุดอยู่) เท่านั้น
- เว็บเก็บความลับ **อย่างเดียว** คือคีย์ Ed25519 **challenge-signer** ที่ไม่มีเงินอยู่เลย เว็บตัดสินว่า
  *ใครได้ challenge* (กฎ IP, sybil, reputation ยังอยู่นอกเชนซึ่งเห็น IP ได้) ส่วนโปรแกรมตัดสินว่า
  *proof นี้ได้รับเงินหรือไม่*: ลายเซ็น, วันหมดอายุ, ใช้ได้ครั้งเดียว, งาน, เพดานรายวันต่อกระเป๋าและทั้งเว็บ, งบรวม
- ยอดคงเหลืออยู่บนเชน (`Miner` PDA ต่อกระเป๋า) และทุกการเปลี่ยนแปลงปล่อย event ใครก็ตรวจยอดรวมได้

## การออกแบบ

### บัญชี

| บัญชี | Seeds | เนื้อหา |
|---|---|---|
| `Config` | `["config"]` | authority, pending_authority, guardian, mint, vault, challenge_signer, difficulty_bits, reward_per_proof, wallet_daily_cap, site_daily_cap, total_budget, max_challenge_ttl_secs, mining_paused, claims_paused, total_credited, total_claimed, total_proofs, site_day, site_day_credited |
| vault | `["vault"]` | SPL token account ของ `mint`, **owner = Config PDA** |
| `Miner` | `["miner", wallet]` | wallet, accrued (เคลมได้), total_mined, total_claimed, proofs, last_seq, day, day_credited |

### Challenge (เว็บเป็นผู้เซ็น)

```
msg = "SWDMINE1"            8 ไบต์  domain tag
   || program_id           32       ผูกกับ deployment นี้
   || wallet               32       ผูกกับผู้ขุด
   || seq       u64 LE      8       ตัวนับใช้ครั้งเดียว
   || bits      u8          1       ความยากของ challenge นี้
   || expires_at i64 LE     8       unix วินาที
                           89 ไบต์
```

### งาน (Work)

```
prefix = sha256("SWDMINE1\0" || msg || wallet) || sha256("SWDMINE1\1" || msg || wallet)[0..28]   (60 ไบต์)
proof  = sha256(prefix || nonce เป็น u64 big-endian)
ผ่าน   ⇔ leading_zero_bits(proof) ≥ bits
```

คือ sha256 ของ (challenge, wallet, nonce) ในรูปแบบเดียวกับข้อความ prefix 60 ไบต์ + nonce 8 ไบต์
ที่ Web Worker ของเว็บค้นอยู่แล้ว (`lib/mine/hub/mine-core.js`) จึงใช้ midstate search เดิมได้เลย
เปลี่ยนแค่วิธีคำนวณ prefix มี test vector ข้ามภาษาใน `logic.rs` (`pow_cross_language_vector`)

### `submit_proof(seq, bits, expires_at, nonce)` — ธุรกรรมเดียว

```
ix 0: Ed25519 precompile (pubkey = challenge signer, ลายเซ็น, msg)
ix 1: swd_mine.submit_proof   (กระเป๋าผู้ขุดเซ็น)
```

ตรวจตามลำดับ:

1. `mining_paused` ไม่เปิด
2. **ลายเซ็น**: instruction ก่อนหน้าทันที (อ่านผ่าน instructions sysvar) ต้องเป็นโปรแกรม Ed25519
   ไม่มีบัญชี มีลายเซ็นเดียว offset ทุกตัวชี้ในตัวเอง (instruction index = `u16::MAX`
   — บั๊ก introspection คลาสสิกคือยอมรับ index อื่น) public key = `config.challenge_signer`
   และข้อความ = `msg` ที่สร้างใหม่จากอาร์กิวเมนต์และ **กระเป๋าที่เซ็น**
3. `bits ≥ config.difficulty_bits`, `now < expires_at`, `expires_at − now ≤ max_challenge_ttl_secs`
4. **ใช้ครั้งเดียว**: `seq > miner.last_seq`
5. **งาน**: leading zero bits ≥ `bits`
6. **เพดาน** (วัน UTC = `unix_ts div 86400`, คณิตแบบ checked): ต่อกระเป๋าต่อวัน ≤ `wallet_daily_cap`,
   ทั้งเว็บต่อวัน ≤ `site_daily_cap`, `total_credited ≤ total_budget`
7. บวก `reward_per_proof` เข้า `miner.accrued`, ตั้ง `last_seq = seq`, ปล่อย `ProofAccepted`

กระเป๋าจ่ายค่าธรรมเนียม และค่า rent ของ `Miner` ครั้งแรกครั้งเดียว (~0.0016 SOL)

**ทำไมใช้ seq ต่อกระเป๋าแทน PDA ต่อ challenge**: PDA ต่อ challenge ทำให้ทุก proof เสีย rent ~0.001 SOL
และต้องมีธุรกรรมปิดทีหลัง bitmap ต้องจัดการ epoch แต่ `last_seq` ใน `Miner` ไม่เสีย rent เพิ่มและไม่ต้องเก็บกวาด
เว็บต้องออก `seq` ที่เพิ่มขึ้นเสมอต่อกระเป๋า (เช่น `max(now_ms, last_issued + 1)`) ถ้ามีสอง challenge ค้างอยู่
การใช้อันใหม่จะทำให้อันเก่าใช้ไม่ได้ `Miner` จะไม่ถูกปิด เพราะการปิดจะรีเซ็ต `last_seq` และตัวนับรายวัน

### `claim()`

โอน `accrued` ทั้งหมดจาก vault (Config PDA เซ็น) ไปยัง associated token account ของกระเป๋าเอง
(สร้างให้ถ้ายังไม่มี — กระเป๋าจ่าย rent และค่าธรรมเนียม) ถ้า vault มีไม่พอจะ error `VaultInsufficient`
(ยอดยังอยู่ ไม่มีอะไรหาย) และ `ClaimsPaused` เมื่อหยุดเคลม

### ผู้ดูแล

| Instruction | ใคร | หมายเหตุ |
|---|---|---|
| `initialize(authority, guardian, challenge_signer, params)` | **upgrade authority** ของโปรแกรมเท่านั้น | กัน front-run หลัง deploy; build `--features mainnet` บังคับ mint SWD |
| `set_params(params)` | authority | bits 16–40, reward > 0, เพดานกระเป๋า ≥ reward, เพดานเว็บ ≥ เพดานกระเป๋า, งบ ≥ reward และ ≥ ที่ให้ไปแล้ว, TTL 60–86400 วินาที |
| `set_paused(mining, claims)` | authority | |
| `emergency_pause()` | guardian หรือ authority | หยุดทั้งสองอย่าง; guardian ยกเลิกการหยุดไม่ได้ |
| `set_challenge_signer(pk)` | authority | challenge เก่าใช้ไม่ได้ทันที |
| `set_guardian(pk)` | authority | |
| `transfer_authority` / `accept_authority` | authority / authority ใหม่ | สองขั้นตอน |
| `withdraw_unused(amount)` | authority | เฉพาะตอน **หยุดขุด**; ปลายทางต้องเป็นบัญชี SWD ที่ **authority เป็นเจ้าของ**; ถอนได้ไม่เกิน `vault − (credited − claimed)` (กันยอดของผู้ขุดไว้) เว้นแต่หยุดเคลมด้วย (ฉุกเฉิน) |

## Threat model

| ภัย | สิ่งที่กันไว้ |
|---|---|
| บอท / ฟาร์ม | ต้องได้ challenge ก่อน และเว็บเซ็นให้ตามกฎ IP/sybil/reputation เท่านั้น แต่ละ challenge จ่ายได้ครั้งเดียว ต้องทำงานจริง และหมดอายุ |
| ขโมย proof ของคนอื่นจาก mempool | challenge และงานผูกกับกระเป๋า และกระเป๋าต้องเซ็น `submit_proof` |
| Replay | `seq` ต้องเพิ่มต่อกระเป๋า; มี `program_id` ในข้อความ **ใช้คีย์ challenge-signer คนละตัวต่อเครือข่าย** (devnet / mainnet) |
| ตรวจลายเซ็นปลอม | introspection รับเฉพาะ instruction ก่อนหน้า, โปรแกรม Ed25519, ลายเซ็นเดียว, offset ในตัว, คีย์ที่ตั้งไว้, ข้อความตรงทุกไบต์ |
| vault / mint / ปลายทางปลอม | `has_one` + PDA seeds, ข้อบังคับ ATA ตอนเคลม, ปลายทางต้องเป็นของ authority |
| Overflow | คณิตแบบ checked ทั้งหมด, `overflow-checks = true` |
| front-run `initialize` | เฉพาะ upgrade authority |
| อัปเกรดโปรแกรมแบบประสงค์ร้าย | upgrade authority = Squads vault (2-of-3) |

### ถ้าคีย์ challenge-signer รั่ว

คีย์อยู่บนเว็บเซิร์ฟเวอร์ ให้ถือว่ารั่วได้ ผู้โจมตีจะเซ็น challenge ให้ **กระเป๋ากี่ใบก็ได้** ข้ามกฎ IP/sybil ของเว็บ
แต่ **ยังทำไม่ได้**:

- ข้ามงาน — ทุก proof ต้องมี ≥ `difficulty_bits` (16–40) บนเชน
- เกิน `wallet_daily_cap` ต่อกระเป๋าต่อวัน
- เกิน **`site_daily_cap` รวมต่อวัน** — นี่คือขอบเขตจริง
- เกิน `total_budget`
- เอาเกินกว่าที่อยู่ใน vault (เติม vault เป็นงวด)
- แตะ vault, พารามิเตอร์, สวิตช์หยุด หรือยอดของคนอื่น

**ความเสียหายสูงสุดก่อนมีคนรู้ตัว ≈ `site_daily_cap` × จำนวนวันที่ไม่มีใครเห็น** และไม่เกิน
`min(total_budget − total_credited, ยอดใน vault)` ตั้ง `site_daily_cap` ให้น้อย (ใกล้ปริมาณที่ปล่อยจริงต่อวัน)
และเฝ้าดู `ProofAccepted` (จำนวนกระเป๋าต่อวันพุ่งขึ้นคือสัญญาณ)

การตอบสนอง:

1. guardian: `emergency_pause` (หยุดขุดและเคลม) — ลายเซ็นเดียว ไม่ต้องรอ multisig
2. Squads: `set_challenge_signer(คีย์ใหม่)` และเปลี่ยน secret บนเซิร์ฟเวอร์
3. พิจารณายอดที่ได้มาโดยทุจริต: ขณะตรวจสอบให้หยุดเคลมไว้; `withdraw_unused` ย้าย vault ไปให้ authority ได้เมื่อหยุดทั้งสองอย่าง
   จากนั้นเติม vault ใหม่และ `set_paused(false, false)`

ความเสี่ยงที่เหลือ: authority (Squads) ถอน vault ได้ขณะหยุด — ระดับความไว้ใจเดียวกับ upgrade authority ซึ่งทำได้ทุกอย่างอยู่แล้ว

## Deploy

### Devnet ก่อน

```bash
solana-keygen new -o target/deploy/swd_mine-keypair.json   # ห้าม commit (อยู่ใน .gitignore)
anchor keys list   # ใส่ id ของ swd_mine ใน Anchor.toml และ declare_id! ใน programs/swd_mine/src/lib.rs
anchor build -p swd_mine
anchor deploy -p swd_mine --provider.cluster devnet
```

จากนั้นใช้กระเป๋า upgrade authority: สร้าง mint ทดสอบบน devnet, สร้างคีย์ challenge-signer **สำหรับ devnet เท่านั้น**,
เรียก `initialize` (authority = กระเป๋าของคุณ, guardian = คีย์ on-call, พารามิเตอร์เล็ก ๆ เช่น 20 bits, รางวัล 1 SWD,
เพดานกระเป๋า 20 SWD, เพดานเว็บ 500 SWD), เติม vault แล้วให้ preview ของเว็บชี้มาที่นี่ (ดูแฟล็กด้านล่าง)
รันอย่างน้อยหนึ่งสัปดาห์: บราวเซอร์จริง, เพดาน, หยุด/เปิด, เปลี่ยนคีย์ signer, `withdraw_unused`

### Mainnet (หลังผ่าน audit อิสระ)

1. build commit ที่ผ่าน audit ด้วย `anchor build -p swd_mine -- --features mainnet` (ปฏิเสธ mint อื่นที่ไม่ใช่ SWD)
   และบันทึก `sha256sum target/deploy/swd_mine.so`; ทำ verified build แบบเดียวกับ `scripts/verified-build.sh` ของ swd_amm
2. deploy ด้วยคีย์ deployer ใช้ครั้งเดียว แล้ว `initialize` **ทันที** โดย `authority` = **Squads vault PDA**,
   `guardian` = คีย์ฉุกเฉิน on-call (ไม่ใช่สมาชิก Squads), `challenge_signer` = คีย์ mainnet ใหม่, พารามิเตอร์แบบระมัดระวัง
3. `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT_PDA>` แล้วตรวจด้วย `solana program show`
4. เติม vault จาก treasury ผ่าน Squads proposal เป็นงวด (เช่น `site_daily_cap` หนึ่งเดือน) ไม่ใช่ทั้งงบในครั้งเดียว
5. `set_params` / `set_paused` / `set_challenge_signer` / `withdraw_unused` ทุกครั้งหลังจากนี้เป็น Squads proposal (2 ใน 3)

## การเปลี่ยนฝั่งเว็บ (repo ของเว็บ — อธิบายไว้ ยังไม่ได้ทำ)

ใช้แฟล็ก เช่น `MINE_ONCHAIN=1` พร้อม `MINE_PROGRAM_ID` และ `MINE_CHALLENGE_SIGNER_KEY`
(secret Ed25519 ใช้แทน `MINE_POW_SECRET` และสุดท้ายแทน `MINE_WALLET_SECRET_KEY`):

- **challenge**: route ยังตรวจทุกอย่างเหมือนเดิม (พิสูจน์กระเป๋า, เพดาน IP, เพดานตาม reputation, sybil)
  เพราะการส่ง proof ไปที่เชนตรง ๆ แล้ว เพดาน IP / reputation จึงต้องใช้ **ตอนออก challenge**:
  นับ challenge ที่ออกต่อ IP / กระเป๋าต่อวัน (หนึ่ง challenge = รางวัลไม่เกินหนึ่งครั้ง) ตอบ `{seq, bits, expiresAt, sig}`
- **workers**: เหมือนเดิม เปลี่ยนแค่ `minePrefix` เป็นสูตรข้างบน
- **submit**: หน้าเว็บสร้าง `[Ed25519 ix, submit_proof]` กระเป๋าเซ็นและจ่ายเอง เซิร์ฟเวอร์ไม่เกี่ยวแล้ว
- **ยอด / ประวัติ**: อ่าน `Miner` PDA และ event ของโปรแกรม
- **ถอน**: แทนด้วยธุรกรรม `claim` เดียวที่กระเป๋าเซ็น
- **ย้ายระบบ**: หยุดออก challenge นอกเชน, ให้ถอนยอดเก่าใน KV ด้วยระบบเดิมภายในช่วงเวลาที่กำหนด
  แล้วย้ายที่เหลือใน hot mining wallet เข้า vault และลบ `MINE_WALLET_SECRET_KEY` โปรแกรมไม่มีคำสั่ง "admin เติมยอด" โดยตั้งใจ

## เทสต์

- `cargo test -p swd_mine` — ตรรกะล้วน (`src/logic.rs`): leading-zero bits ทุกตำแหน่ง, วัน UTC, ตรวจ challenge,
  ตรวจพารามิเตอร์, เพดาน/งบ/overflow, ยอดที่ถอนได้, parser ของ Ed25519 instruction, PoW vector ข้ามภาษา
- `tests/swd_mine.ts` (`anchor test` ที่ CI รัน) — challenge ที่เซ็นด้วย Ed25519 จริงและ PoW จริงที่ 16 bits
  ครอบคลุมทุกเส้นทางที่ปฏิเสธและสำเร็จตามรายการในเอกสารภาษาอังกฤษ
