> English: [SWD_LAUNCH_GUARD.md](SWD_LAUNCH_GUARD.md)

# SWD Launch Guard — Transfer Hook ของ Token-2022 กันบอทช่วงเปิดตัวเหรียญ

> **สถานะ: ร่าง ยังไม่ผ่าน audit และยังไม่ deploy** ต้องผ่าน audit อิสระก่อนใช้บน mainnet
> โปรแกรม: `programs/swd_launch_guard` · เทสต์: `programs/swd_launch_guard/src/logic.rs` (Rust),
> `tests/swd_launch_guard.ts` (โอน Token-2022 จริงบน validator ในเครื่อง)

## ทำไม

ช่วงวินาทีแรกของการเปิดตัว บอทจะกวาดซื้อจากพูลจำนวนมากด้วยกระเป๋าใหม่ ๆ
Token-2022 มี **Transfer Hook** ให้เหรียญเรียกโปรแกรมทุกครั้งที่มีการโอน โปรแกรมนี้ใช้มันเฉพาะ
**ช่วงเปิดตัว (launch window)** ที่สั้นและมีเพดานแน่นอน: ชะลอการซื้อจากกระเป๋าของโปรเจกต์เอง (พูล, ผู้สร้าง)
แล้วปิดตัวเองถาวร ออกแบบสำหรับเหรียญจากหน้าสร้างเหรียญ Token-2022 ของ SWD
(repo เว็บ `lib/create-token/token2022.ts`) ซึ่งตอนนี้ยัง **ไม่** ใส่ TransferHook — ดู "การเชื่อมกับหน้าสร้างเหรียญ"

## กฎ

ระหว่าง window การโอนจะ **ถูกจำกัด** ก็ต่อเมื่อ

```
เจ้าของบัญชีต้นทาง ∈ launch_wallets  (authority ของ vault พูล, ผู้สร้าง)
และ เจ้าของบัญชีปลายทาง ∉ launch_wallets
```

การโอนที่ถูกจำกัดต้องผ่าน (ตาม `Recipient` ของเจ้าของปลายทาง ซึ่งต้องลงทะเบียนไว้ก่อน):

| เงื่อนไข | error |
| --- | --- |
| `amount <= max_per_transfer` | `OverPerTransferCap` |
| `received + amount <= max_per_wallet` (ทั้ง window) | `OverPerWalletCap` |
| `now >= last_receive_ts + cooldown_secs` (หลังรับครั้งแรก) | `CooldownActive` |
| มี `Recipient` ของเจ้าของปลายทาง | `RecipientNotRegistered` |
| `now >= launch_ts` (เปิดซื้อตอน launch) | `NotOpenYet` |

นอกนั้นผ่านหมดโดยไม่ตรวจอะไร:

- **ทุกการโอนที่ต้นทางไม่ใช่ launch wallet** — **การขายทุกครั้ง** (ผู้ถือ → พูล), ผู้ถือ → ผู้ถือ
  ทุกช่วงเวลา ทุกจำนวน hook ไม่ดูยอดของต้นทาง และไม่เคยปฏิเสธการโอน *ออก* จากกระเป๋าผู้ถือ
- launch wallet → launch wallet (ผู้สร้างเติมสภาพคล่อง)
- **หลัง `window_end` — ทุกการโอน** hook คืนค่าทันทีหลังอ่าน config (วัดได้ ~4.7k CU, ใน window ~7.9k)

## การรับประกันกัน honeypot (บังคับในโค้ด)

| รับประกัน | วิธี |
| --- | --- |
| window ยาวสุด **24 ชม.** | `window_secs <= 86_400` ตอนสร้าง (`WindowTooLong`) |
| window เริ่มช้าสุด **7 วัน** หลังสร้าง | `launch_ts <= now + 7 วัน` (`LaunchTooFar`) |
| ไม่มีอะไรถูกจำกัดหลังสร้างเกิน 8 วัน | `window_end` เขียนครั้งเดียวตอนสร้าง; `end_window` เลื่อนได้แค่ **เร็วขึ้น** |
| ปรับเงื่อนไขได้แค่ **ผ่อนลง** | `relax_limits` ไม่รับเพดานต่ำลงหรือ cooldown ยาวขึ้น (`NotLooser`) |
| เปลี่ยนผู้ถือให้เป็นต้นทางที่ถูกจำกัดกลางทางไม่ได้ | `add_launch_wallet` ได้เฉพาะก่อน `launch_ts`; ลบได้ตลอด |
| การขายไม่ถูกบล็อกเลย | ต้องเป็นต้นทางจาก launch wallet เท่านั้นถึงจะถูกจำกัด — มีเทสต์ทั้ง Rust และ TS (เกินเพดาน, ระหว่าง cooldown, ก่อน launch) |
| แก้รายการ extra account ทีหลังไม่ได้ | ไม่มี `update_extra_account_meta_list`; Guard และรายการปิดไม่ได้ |
| เรียก `execute` ตรง ๆ เพื่อกลั่นแกล้งตัวนับไม่ได้ | บัญชีทั้งสองต้องเป็นของ mint นี้และมีแฟล็ก `transferring` ซึ่ง Token-2022 ตั้งเฉพาะตอนเรียก hook (`NotInTransfer`) |

## บัญชี

| บัญชี | seeds | ขนาด | ค่าเช่า | ใครจ่าย / ได้คืน |
| --- | --- | --- | --- | --- |
| `ExtraAccountMetaList` | `["extra-account-metas", mint]` (กำหนดโดย interface) | 86 B | ~0.0015 SOL | ผู้เปิดตัว, ถาวร |
| `Guard` | `["guard", mint]` | 382 B | ~0.0036 SOL | ผู้เปิดตัว, ถาวร |
| `Recipient` | `["recipient", mint, wallet]` | 126 B | ~0.0018 SOL | ผู้ลงทะเบียน (ผู้ซื้อ/UI); คืนด้วย `close_recipient` หลัง window |

extra account ของ `Execute` (ต่อจาก source, mint, destination, owner, รายการ):
5. `guard` = PDA `["guard", mint]` อ่านอย่างเดียว
6. `recipient` = PDA `["recipient", mint, owner ของบัญชีปลายทาง (byte 32..64)]` เขียนได้

client หาเองได้ (`createTransferCheckedWithTransferHookInstruction` ใน `@solana/spl-token`) — เทสต์ใช้ทางนี้

## ทำไมต้องลงทะเบียนก่อน

hook ทำงานใน CPI ของ Token-2022 ทุกบัญชีถูกลดสิทธิ์เป็น non-signer จึงไม่มีผู้จ่ายค่าเช่า —
**สร้างบัญชีติดตามรายกระเป๋าใน hook ไม่ได้** ทางเลือก:

- *จำกัดแค่จำนวนต่อครั้ง ไม่เก็บสถานะ*: เพดานรวมและ cooldown ไร้ความหมาย (บอทซื้อย่อย ๆ ซ้ำ)
- *ลงทะเบียนก่อน* (เลือกแบบนี้): `register_recipient(wallet)` สร้าง `Recipient` ก่อนซื้อ ใครจ่ายก็ได้
  (ผู้ซื้อ หรือ fee payer ของ UI) UI จึงใส่ไว้หน้าธุรกรรม swap ครั้งแรกได้ การโอนที่ถูกจำกัดไปยังกระเป๋าที่ไม่ลงทะเบียนจะล้มเหลว
  หลัง window ใครก็เรียก `close_recipient` ได้ ค่าเช่าคืนผู้ที่จ่าย

## คำสั่ง

| คำสั่ง | ใคร | หมายเหตุ |
| --- | --- | --- |
| `initialize_extra_account_meta_list(params)` | **mint authority** หรือ **transfer-hook authority** ของ mint | สร้าง Guard + รายการพร้อมกัน; mint ต้องเป็น Token-2022 ที่ TransferHook ชี้มาที่โปรแกรมนี้ |
| `execute(amount)` | Token-2022 | discriminator ตาม interface |
| `register_recipient(wallet)` | ใครก็ได้ | ก่อน `window_end` |
| `close_recipient` | ใครก็ได้ | หลัง `window_end`; ค่าเช่าคืนผู้จ่าย |
| `end_window` | guard authority | `window_end = min(window_end, now)` |
| `relax_limits` | guard authority | ผ่อนได้อย่างเดียว |
| `add_launch_wallet` / `remove_launch_wallet` | guard authority | เพิ่มได้แค่ก่อน launch |
| `set_authority(new)` | guard authority | `Pubkey::default()` = สละสิทธิ์ |

## ความเชื่อใจ (trust model)

- **upgrade authority ของโปรแกรม** — จุดเสี่ยงใหญ่สุด: อัปเกรดเป็นโค้ดที่บล็อกทุกการโอนได้
  ใช้ Squads vault (มี timelock) และพิจารณาทำให้ immutable หลัง audit
- **TransferHook authority บน mint** — เปลี่ยน hook ไปโปรแกรมอื่นได้ หน้าสร้างเหรียญควรตั้งเป็น **none**
- **guard authority (ผู้สร้าง)** — ทำได้แค่จบ window เร็วขึ้น, ผ่อนเงื่อนไข, ลบ launch wallet, เพิ่มก่อน launch, สละสิทธิ์
  ขยาย window / เข้มขึ้น / แตะยอดเงินไม่ได้
- **ลำดับการเปิดตัว** — ก่อน init การโอนทุกครั้งล้มเหลว ถ้าเพิกถอน mint authority และ hook authority เป็น none ก่อน init
  จะไม่มีใคร init ได้อีกและเหรียญโอนไม่ได้ตลอดไป ต้อง init ก่อนเพิกถอน mint authority และให้การตรวจ mint ของเว็บเช็คว่ามี Guard แล้ว

## ข้อจำกัดที่ต้องรู้

- **Sybil**: เพดานเป็นต่อกระเป๋า บอทที่มีหลายกระเป๋าได้หลายเพดาน ค่าลงทะเบียนและ cooldown แค่ชะลอ ไม่ได้หยุด
- **พูลที่ไม่อยู่ในรายการ** ไม่ถูกจำกัด และเพิ่มหลัง launch ไม่ได้ — ใส่ทุกพูลก่อน launch
  (Raydium CPMM ใช้ vault authority เดียวทุกพูล ใส่ตัวเดียวครอบคลุมทุกพูล CPMM ของเหรียญ)
- **เส้นทาง aggregator** ที่ผ่านบัญชีตัวกลางของโปรแกรม จะโดนจำกัดที่ hop นั้นระหว่าง window — swap ตรงกับพูลใช้ได้
- launch wallet ที่จริง ๆ เป็นผู้ถือ (ใส่ผิด/ตั้งใจ) จะโดนจำกัดการโอนไปกระเป๋าทั่วไประหว่าง window — แต่โอนเข้าพูลได้เสมอ และไม่เกิน 24 ชม.
- เพดานเทียบกับจำนวนก่อนหัก transfer fee

## การเชื่อมกับหน้าสร้างเหรียญ (repo เว็บ — อธิบายไว้ ยังไม่ได้ทำ)

1. เพิ่ม `ExtensionType.TransferHook` (authority none, program = id นี้) ใน TX1 และย้ายออกจาก `FORBIDDEN_T22_EXTENSIONS` *เฉพาะเมื่อเลือก guard*
2. ใน TX3 ก่อน `SetAuthority(MintTokens → none)` เรียก `initialize_extra_account_meta_list` (project wallet เซ็นในฐานะ mint authority)
   โดย `guard_authority = ผู้สร้าง`, `launch_wallets = [ผู้สร้าง, vault authority ของพูล]`
3. `verifyCreatedMint`: รับ TransferHook เฉพาะเมื่อ program = id นี้, authority = none และมี Guard PDA แล้ว
4. UI swap: ระหว่าง window ถ้ายังไม่มี `Recipient` ของผู้ซื้อ ให้ใส่ `register_recipient` นำหน้า

## Deploy (devnet)

```bash
anchor build -p swd_launch_guard
solana-keygen new -o target/deploy/swd_launch_guard-keypair.json   # ครั้งเดียว เก็บให้ดี
anchor keys list   # ใส่ id ใน declare_id! ของ lib.rs และ Anchor.toml (ทั้งสองส่วน)
anchor build -p swd_launch_guard
anchor deploy -p swd_launch_guard --provider.cluster devnet
```

ขนาดโปรแกรม ~315 KB → ค่าเช่าบัญชีโปรแกรม ~2.2 SOL งาน deploy ของ CI deploy แค่ `swd_amm` (`anchor deploy -p swd_amm`)

## เทสต์

- `cargo test -p swd_launch_guard` — ช่วงเวลา, กฎการจำกัด (ขายไม่ถูกจำกัด), เพดาน, cooldown, overflow, ขอบเขต 24 ชม./7 วัน,
  ผ่อนได้อย่างเดียว, end_window ไม่ขยาย, รายการ launch wallet, discriminator ของ Execute ตรงกับ interface
- `tests/swd_launch_guard.ts` — โอน Token-2022 จริงผ่าน hook ครบทุกกรณีข้างบน รวมการขาย/โอนระหว่างผู้ถือไม่ถูกบล็อก,
  เรียก execute ตรง ๆ ถูกปฏิเสธ, หลัง window เป็น no-op (มีเช็ค CU)

## ก่อนขึ้น mainnet

- audit อิสระของโปรแกรมนี้ (และการแก้หน้าสร้างเหรียญ)
- upgrade authority = Squads vault + timelock หรือ immutable
- กำหนดค่า window/เพดานเริ่มต้นร่วมกับทีมหน้าสร้างเหรียญ และแสดงกฎให้ผู้ซื้อเห็นก่อนซื้อ
