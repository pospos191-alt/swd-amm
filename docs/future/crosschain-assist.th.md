[English](crosschain-assist.md) | **ภาษาไทย**

# ความปลอดภัยข้ามเชนและผู้ช่วย (testnet)

สายงาน `fut-crosschain` มี 8 รายการ: oracle ความปลอดภัยข้ามเชนของ Neuro (18), ภูมิคุ้มกันหมู่ (28), ใบรับรอง "Neuro-checked" (19),
การรับรอง AI ที่ทนควอนตัม (30), ประกันการถูกแฮ็กแบบพาราเมตริก (32), ผู้ช่วยก่อนลงนาม (20), ผู้ช่วยธรรมาภิบาล (21) และผู้ช่วย validator (22)

ทุกอย่างในนี้ใช้กับ **testnet เท่านั้น** ไม่มีเงินจริง และไม่ต้องมีเซิร์ฟเวอร์ที่เปิดตลอดเวลา งานทั้งหมดเกิดในสัญญา ในเบราว์เซอร์ (hub)
บน runner และ validator ที่มีคนรันอยู่แล้ว หรือใน GitHub Actions

| # | รายการ | สถานะ | อยู่ที่ |
|---|---|---|---|
| 18 | oracle ความปลอดภัยข้ามเชนของ Neuro | **สร้างแล้วและทดสอบบนเชนในเครื่อง** ติดตั้งบน EVM testnet รอหลัง 1 พฤศจิกายน ฝั่ง Osmosis มีสัญญาและเส้นทาง memo ที่ใช้งานได้ แต่ยังไม่ได้ติดตั้ง | `contracts/NeuroOracle.sol`, `src/neurooracle.js`, `scripts/neuro-oracle.js`, `scripts/saphan-dryrun.js --neuro-oracle`, `.github/workflows/neuro-oracle.yml`, `cosmwasm/neuro-oracle-osmo/` |
| 28 | ภูมิคุ้มกันหมู่ + ความครอบคลุมต่อเชน | **สร้างแล้ว**: ตัว push และมาตรวัดความครอบคลุม (CLI และ hub) แสดงว่า "ยังไม่ได้ติดตั้ง" จนกว่าข้อ 18 จะติดตั้ง | `src/neurooracle.js`, `zetaphy immune push/coverage`, แท็บ **ภูมิคุ้มกัน** ใน hub |
| 19 | ใบรับรอง "Neuro-checked" | **สร้างแล้ว**: สัญญา, CLI, `--attest` ของ DEX, ป้ายในแถบกระเป๋าและหน้าสวอป, การค้นใน hub ยังไม่ได้ติดตั้ง | `contracts/NeuroAttest.sol`, `zetaphy certify`, `zetaphy-dex/cli.js deploy --attest`, `walletbar.js`, `zetaphy-dex/web` |
| 30 | การรับรอง AI ที่ทนควอนตัม | **สร้างแล้ว**: ไฟล์เก็บถาวรลงนาม ML-DSA-44, การยึดบนเชน, ตัวตรวจแบบ CLI และในเบราว์เซอร์, เทสต์การแก้ไขไฟล์ | `zetaphy-hub/pqattest.js`, `src/pqattest.js`, `contracts/NeuroAttest.sol` (`NeuroAnchor`), `zetaphy attest-pq` |
| 32 | ประกันการถูกแฮ็กแบบพาราเมตริก (testnet) | **สัญญาต้นแบบพร้อมเทสต์** ยังไม่ได้ติดตั้ง เครื่องมือ replay ที่สร้างรายงานนิติวิทยาไม่อยู่ในสายงานนี้ | `contracts/HackInsurance.sol` |
| 20 | ผู้ช่วยก่อนลงนาม | **สร้างแล้ว**: จำลองการเปลี่ยนยอดเงินบนโหนด ZETAPHY จริง (โพรบผ่าน state override) และให้ AI อธิบายได้ถ้าต้องการ | `zetaphy-hub/presign.js`, `tools/PresignProbe.sol`, `wallet-safety.js` (`simulate` / `explain`) |
| 21 | ผู้ช่วยธรรมาภิบาล | **สร้างแล้ว**: ข้อเสนอและคิว timelock ถอดความ จำลอง และติดธง ใน 8 ภาษา | `zetaphy-hub/govassist.js`, แท็บ **ธรรมาภิบาล** ใน hub |
| 22 | ผู้ช่วย validator | **สร้างแล้ว**: `zetaphy-validator status` วินิจฉัยและแนะนำเป็นภาษาง่าย | `zetaphy-chain/join-validator.sh` (`diagnose`, `jail_eta`) |

path ที่ไม่ได้ระบุโฟลเดอร์อยู่ใต้ `zetaphy-network/`

---

## 18 · oracle ความปลอดภัยข้ามเชนของ Neuro

### สิ่งที่สร้าง

```
ZETAPHY                                                       Sepolia / Base Sepolia / Arbitrum Sepolia
ThreatRegistry (โควรัมของ runner) ─┐
NeuroJobs (คำตัดสินที่สิ้นสุดแล้ว) ──┴─ NeuroOracleSender อ่าน ── Hyperlane ──▶ NeuroOracle (DEX เรียก check(token))
                                         │                  ตรวจโดย multisig ISM ของ validator ของเรา (แบบเดียวกับ Saphan)
                                         └── ICS-20 + memo (ibc-hooks) ──▶ CosmWasm neuro-oracle-osmo (osmo-test-5)
```

- **`NeuroOracleSender`** (บน ZETAPHY) ไม่ถือกุญแจและไม่ตัดสินใจอะไรเอง
  - `push(domain, keys)` อ่านสถานะปัจจุบันของแต่ละคีย์ใน ThreatRegistry: รอบ, ติดธงหรือไม่, เหตุผล, `enforcedFrom`, `heldFrom` แล้วส่งสถานะนั้นผ่าน Mailbox ของ ZETAPHY ไปยัง `NeuroOracle` ที่ governance ลงทะเบียนไว้สำหรับ domain นั้น
  - ใครก็เรียกได้ และจ่ายค่า Hyperlane ตามที่ quote ส่วนที่จ่ายเกินจะได้คืน
  - ผู้เรียกส่งข้อความเท็จไม่ได้ เพราะสัญญาอ่านเนื้อหาเอง
  - `pushVerdict(domain, jobId)` ส่งต่อคำตัดสินของ NeuroJobs ที่สิ้นสุดแล้ว: runner 2 ใน 3 เห็นตรงกัน และไม่มีการคัดค้านที่เปิดอยู่หรือยังเปิดได้
  - `pending(domain, keys)` บอกว่าปลายทางยังขาดคีย์ไหน
  - `snapshot(start, n)` ไล่ดูประวัติการติดธงของ registry ทีละหน้า มาตรวัดความครอบคลุมใช้ตัวนี้
- **`NeuroOracle`** (บน EVM testnet แต่ละเชน) ใช้แบบเดียวกับ `HyperlaneLockBoxV2`
  - `handle` รับเฉพาะจาก Mailbox ที่ตั้งไว้ ต้นทาง ZETAPHY และ sender ตัวเดียว
  - `interchainSecurityModule()` ของมันคือ multisig ISM ของ validator **ของเรา** (`zetaphyValidators` ใน `saphan-chains.json`) ที่สร้างผ่าน factory ของ Hyperlane บนเชนนั้น
  - แต่ละคีย์เก็บสถานะใหม่สุดตามรอบของ registry รอบจะเพิ่มทุกครั้งที่ติดธงและล้างธง ข้อความเก่าหรือข้อความที่ส่งซ้ำจึงย้อนคีย์กลับไม่ได้
  - การบังคับใช้ช่องทางด่วน (`enforceNow`) ใช้รอบเดิมแต่ทำให้บังคับใช้เร็วขึ้น และ mirror ก็รับการเปลี่ยนนั้นด้วย
  - view สำหรับ DEX:
    - `check(token)`: ที่อยู่ของโทเคนบนเชนนี้หรือโค้ดของมันถูกติดธงหรือไม่ (`addressKey` / `codeKey` แบบเดียวกับ registry)
    - `isFlagged(fp1)` / `isEnforced(fp1)`: แบบเดียวกันสำหรับลายนิ้วมือของ Neuro
    - `verdictOf(chain, target)`: คำตัดสินของ NeuroJobs ที่ส่งต่อมา
  - บทบาท: governance คือ timelock v2 ของเชนนั้น guardian สั่งหยุดชั่วคราวได้ ระหว่างหยุด ข้อความรออยู่ที่ Mailbox และ view ตอบว่า "ไม่ติดธง" (fail open เพื่อให้ DEX ยังทำงานได้) และ `paused()` บอก DEX ว่า mirror ไม่เป็นปัจจุบัน
- **Osmosis** memo ของ ICS-20 อย่างเดียวรันอะไรบน Osmosis ไม่ได้ถ้าไม่มีสัญญา จึงใช้ **ibc-hooks คู่กับสัญญา CosmWasm ขนาดเล็ก**
  - `pushIbc(keys)` เรียก ICS-20 precompile ของ ZETAPHY (`0x…0802`) โอน 1 azetaphy พร้อม memo ที่สร้างบนเชนจาก registry: `{"wasm":{"contract":…,"msg":{"mirror":{"src_chain":77390,"items":[…]}}}}`
  - ibc-hooks ของ Osmosis รันข้อความนั้นด้วยผู้ส่งที่คำนวณจาก (channel ฝั่ง Osmosis, ที่อยู่ `zetaphy1…` ของ sender ของเรา)
  - สัญญา (`cosmwasm/neuro-oracle-osmo`) รับเฉพาะผู้ส่งที่คำนวณได้นั้น `src_chain` 77390 และคีย์ hex 64 ตัว ใช้กฎรอบใหม่สุดแบบเดียวกัน และมี `pause` กับ `admin`
  - วิธีคำนวณอยู่ใน `ibcHooksSender()`
  - ความไว้ใจอยู่ที่ light client IBC ของ ZETAPHY บน Osmosis บวกกับสัญญาของเรา ไม่มีคณะกรรมการเกี่ยวข้อง
  - เราเลือกวิธีนี้แทน interchain account (ICA) เพราะ ICA ต้องมี ICA controller บน ZETAPHY และต้องมีกุญแจเจ้าของฝั่ง controller หรือ governance ทุกข้อความ ibc-hooks ไม่ต้องใช้ทั้งสองอย่าง

### การติดตั้ง (แบบ saphan-route)

- `scripts/neuro-oracle.js`
  - `check --chain <name>`: อ่านอย่างเดียว
  - `sender`: บน ZETAPHY
  - `receiver --chain <name> --sender 0x…`: ISM ของเราผ่าน factory แล้ว NeuroOracle ใช้ timelock และ multisig v2 ของเชนนั้น หรือสร้างใหม่แบบเดียวกับ `origin-prepare`
  - `wire --sender 0x… --receivers a=0x…,b=0x…`: ตั้งเส้นทาง แล้วส่ง governance ให้ timelock ของ ZETAPHY
  - `coverage`
- `.github/workflows/neuro-oracle.yml` มีเฉพาะโหมด **check** และ **dry_run** บน pull request จะรัน dry_run ของ Base Sepolia
- **การติดตั้งจริงทำหลัง 2026-11-01** มี 3 ขั้น (sender, receivers, wire) แล้วเขียนผลลง `zetaphy-chain/hyperlane/neuro-oracle.json` เป็น `{ sender, receivers: { <chain>: { oracle } } }` ซึ่ง hub อ่านไฟล์นี้ ตอนนั้นจะเพิ่มโหมด `deploy` ที่ต้องใช้ environment `testnet-deploy` เหมือน `saphan-route.yml`
- **relayer ต้องเพิ่ม sender ใน whitelist:** `{ originDomain: 77390, senderAddress: <sender>, destinationDomain: <chain> }` ใน `HYP_WHITELIST` (ต้องเพิ่มรายการนี้ใน `relayerWhitelist` ของ `src/saphan.js` เมื่อติดตั้งแล้ว) ไม่อย่างนั้น validator ของเราลงนามข้อความแต่ไม่มีใคร relay
- Osmosis
  1. build wasm ด้วย `cosmwasm/optimizer` (โค้ดใช้แค่ `cosmwasm-std` 2.1)
  2. อัปโหลดไป osmo-test-5
  3. instantiate ด้วย `hook_sender = osmosisd q ibc-hooks wasm-sender <channel ฝั่ง osmosis> <zetaphy1… ของ sender>` และเทียบผลกับ `ibcHooksSender()` ก่อนจะไว้ใจค่าใดค่าหนึ่ง
  4. บน ZETAPHY ให้ governance เรียก `setIbcRoute("channel-N", "osmo1…", 600)`
  5. channel IBC ไป osmo-test-5 คือเส้นทาง Osmosis ของ Saphan (`zetaphy-chain/ibc`, `ROUTE=osmosis`)

### เทสต์

- `test/neurooracle.test.js` 10 เทสต์บน EVM ในหน่วยความจำ ข้อความลงนามเป็น checkpoint ของ Hyperlane และผ่าน Mailbox ที่ตรวจ message-id multisig ISM ครอบคลุม:
  - จังหวะเตือนและจังหวะบังคับใช้
  - `check(token)` ทั้งตามที่อยู่และตามโค้ด
  - การปฏิเสธ: ผู้ลงนามปลอม, 1 ใน 2, ส่งซ้ำ, sender แปลกปลอม, ต้นทางอื่น, เรียกตรง
  - ข้อความมาไม่ตามลำดับ
  - ช่องทางด่วน
  - การหยุดชั่วคราว
  - คำตัดสิน
  - ความครอบคลุม
  - memo IBC และผู้ส่งของ ibc-hooks
  - บทบาท
- **dry run บนเชนจริง 2 เชนในเครื่อง** `node scripts/saphan-dryrun.js --chain basesepolia --neuro-oracle --kit` รันกับ devnet ของ `zetaphyd` สองตัว (chain id 77390 และ 84532 ผ่าน `scripts/devnet.sh`) โดยใช้ Mailbox และ ISM ของชุดทดสอบแทนแกน Hyperlane ผลคือ `NEURO ORACLE DRY RUN OK` พร้อมการปฏิเสธและความครอบคลุม 100.0% ถ้าไม่ใส่ `--kit` จะใช้ Mailbox และ ISM factory จริง ซึ่งเป็น dry_run ของ workflow ส่วนนี้**ไม่ได้รันที่นี่** เพราะต้องใช้ anvil และ Hyperlane CLI ที่สภาพแวดล้อมนี้ไม่มี
- `cargo test` ใน `cosmwasm/neuro-oracle-osmo` (`npm run test:cosmwasm`) 3 เทสต์: ตรวจผู้ส่ง, กฎรอบใหม่สุด, การหยุดชั่วคราว, รูปแบบคีย์, และการอ่าน memo ที่ ZETAPHY สร้าง

### ข้อจำกัด

- DEX บนเชนอื่นต้อง**เลือก**เรียก `check(token)` เอง เราบังคับ Uniswap ไม่ได้
- ตอนหยุดชั่วคราว mirror จะ fail open (ตอบว่า "ไม่ติดธง") เพื่อให้ DEX ยังทำงานได้ถ้า validator ของเราถูกยึด แลกกับการไม่มีการป้องกันช่วงที่หยุด
- mirror เป็นปัจจุบันเท่ากับการ push ครั้งล่าสุดเท่านั้น เรื่องความเร็วดูข้อ 28
- เส้นทาง ICS-20 ใช้ 1 azetaphy ต่อข้อความ ถ้ารันบน Osmosis ไม่สำเร็จ การโอนจะถูกคืนและข้อความหายไป ตัว push ไม่ได้ติดตามการส่งผ่าน IBC ให้ส่ง `pushIbc` ใหม่
- ยังไม่ได้ตรวจขนาดของ wasm หรือรัน `cosmwasm-check` ที่นี่ (รันแค่เทสต์ native) และยังไม่ได้ติดตั้งบน osmo-test-5

---

## 28 · ภูมิคุ้มกันหมู่

### สิ่งที่สร้าง

- **ตัว push:** `zetaphy immune push --sender 0x… [--once] [--interval 30] [--max-fee 0.1]` runner รันคู่กับ `zetaphy node start` ได้ หรือให้ GitHub Actions ตามตารางเวลารันด้วย `--once`
  - รอบแรกส่งทุกคีย์ที่ติดธงอยู่
  - รอบต่อไปอ่านเฉพาะเหตุการณ์ของ registry ตั้งแต่บล็อกล่าสุด (`Flagged`, `Cleared`, `FastEnforced`, `HeldNow`, `Protected`)
  - แต่ละเส้นทาง ส่งเฉพาะคีย์ที่ยัง `pending` ทีละไม่เกิน 32 คีย์
  - ค่าธรรมเนียมที่เกิน `--max-fee` จะถูกปฏิเสธ และคีย์เหล่านั้นลองใหม่รอบถัดไป
  - สถานะเก็บใน `~/.zetaphy/immune-<sender>.json`
- **ความครอบคลุมต่อเชน** = (คีย์ที่ติดธงบน ZETAPHY ตอนนี้ซึ่ง mirror มีรอบเดียวกัน) / (คีย์ที่ติดธงบน ZETAPHY ตอนนี้) ปัดลงที่ 0.1% mirror ที่ขาดคีย์ 1 ใน 1000 จึงไม่มีทางแสดง 100%
  - CLI: `zetaphy immune coverage --sender … --mirror <name>=<rpc>@0x…` และ `node scripts/neuro-oracle.js coverage`
  - hub: แท็บ **ภูมิคุ้มกัน** อ่าน RPC ของเชนต่างๆ ใน `saphan-chains.json` ตรงจากเบราว์เซอร์

### เร็วแค่ไหน

- ถ้า push ทุก 30 วินาที ธงใหม่จะถูกส่งภายใน 30 วินาทีบวก 1 บล็อกของ ZETAPHY
- หลังจากนั้นเป็นเวลาของ relayer Hyperlane และ validator ของเรา ซึ่งต้องรอ finality ของต้นทางและรอบการตรวจของตัวเอง (หลักวินาทีถึงนาที)
- "ภายในไม่กี่บล็อก" เป็นจริงเฉพาะเมื่อมีคนรันตัว push ไม่มีอะไร push เอง เพราะ `ThreatRegistry` ติดตั้งไปแล้วและเรียก sender ไม่ได้
- GitHub Actions ตามตารางเวลารันได้ถี่สุดทุก 5 นาที เครื่องของ runner รันตัว push ได้ต่อเนื่อง

### เทสต์

- `test/neurooracle.test.js` (ความครอบคลุมจากสัญญาจริง) และ `test/assist.test.js` (รอบของตัว push, การลองใหม่, `--max-fee`)
- `zetaphy-hub/test/assist.test.mjs` (การคำนวณความครอบคลุมในเบราว์เซอร์, mirror ที่ติดต่อไม่ได้) และ `assist.e2e.mjs` (แท็บภูมิคุ้มกันภายใต้ CSP ของเว็บ)

---

## 19 · ใบรับรอง "Neuro-checked"

### สิ่งที่สร้าง

- **`NeuroAttest`** (คล้าย EAS มี schema เดียวคือ `zetaphy.neuro-checked.v1`) การรับรองหนึ่งรายการบันทึก:
  - โทเคนที่ถูกรับรอง
  - ผู้รับรอง
  - เวลา
  - แฮชรายงาน Neuro (verdict hash, `zetaphy-neuro/src/verdict.js`)
  - **skill id** (รุ่นของโค้ด Neuro, `src/skill.js`)
  - **โมเดล AI** (`rules` ถ้าไม่ได้ใช้โมเดล)
  - หมายเลข job ของ NeuroJobs
  - URI
- ได้ใบรับรองมาได้ 2 ทาง:
  - `attest(…)` โดยผู้รับรองที่ governance อนุมัติ เช่น กุญแจของเครื่องมือเปิดตัว
  - `attestFromJob(jobId, token)` ใครก็เรียกได้ สำหรับคำตัดสินของ NeuroJobs ที่**สิ้นสุดแล้ว** บนเชน `zetaphy` เกี่ยวกับโทเคนนั้น ผู้รับรองจะเป็น NeuroJobs เอง จึงไม่ต้องเชื่อคำของใคร job หนึ่งใช้ได้ครั้งเดียว
- **governance เพิกถอน**การรับรองใดก็ได้พร้อมเหตุผล ผู้รับรองเพิกถอนของตัวเองได้
- `badge(token)` คืนการรับรองล่าสุดของโทเคนถ้ายังไม่ถูกเพิกถอน
- เครื่องมือ:
  - `zetaphy certify <token> --attest 0x…` รัน Neuro กับโทเคน (อ่านจาก ZETAPHY) แล้วรับรอง
  - `zetaphy certify from-job <id> <token>` และ `zetaphy certify show <token>`
  - `zetaphy deploy-assist attest`
  - **เครื่องมือเปิดตัว:** `zetaphy-dex/cli.js deploy --test-tokens --attest 0x<NeuroAttest>` รับรองทุกโทเคนที่สร้าง
- **ป้าย:**
  - แถบกระเป๋า (`walletbar.js` ตัวเลือก `neuroBadge`) แสดง "✓ Neuro-checked" ข้างโทเคนที่ถืออยู่
  - กล่อง Neuro ในหน้าสวอปแสดงเลขใบรับรองและผู้รับรอง หรือ "ถูกเพิกถอน" เมื่อ `deployments.json` มี `contracts.neuroAttest`
  - แท็บภูมิคุ้มกันใน hub ค้นที่อยู่ใดก็ได้
  - ทุกข้อความบอกว่าเป็น**การตรวจ ไม่ใช่การรับประกัน** และเทสต์ตรวจว่าไม่มีภาษาไหนเขียนว่า "safe"

### เทสต์

- `test/neuroattest.test.js`: กฎผู้รับรอง, from-job (ต้องสิ้นสุดแล้ว, โทเคนต้องตรง, ใช้ครั้งเดียว, target ตัวพิมพ์ผสม), การเพิกถอน, NeuroAnchor
- `test/assist.test.js`: certify และข้อความของป้าย
- `zetaphy-dex/test/badge.test.js`: การอ่านป้ายและ 8 ภาษา

### ข้อจำกัด

- `attestFromJob` ต้องเป็น job บนเชน `zetaphy` เพราะ NeuroJobs รู้จักแค่ชื่อเชนของตัวเอง
- `zetaphy-launch` ยังไม่เรียก certify เอง ตอนนี้ทำผ่านแฟล็กของ DEX CLI การต่อเข้าขั้นตอนเปิดตัวเป็นงานเล็กที่ทำได้หลังติดตั้ง NeuroAttest

---

## 30 · การรับรอง AI ที่ทนควอนตัม

### สิ่งที่สร้าง

- **รูปแบบไฟล์เก็บถาวร** `zetaphy.neuro-attestation.v1` (JSON ไฟล์เดียว):
  - `payload`: ชนิด, createdAt, subject, reportHash, skill, model, และรายงานเต็ม (ถ้าต้องการ)
  - `payloadHash`: sha256 ของ JSON มาตรฐานของ payload
  - `signature`: alg `ML-DSA-44`, publicKey ขนาด 1312 ไบต์, keyHash = keccak256(publicKey) (แฮชกุญแจเดียวกับ `zetaphy pq` และ QuantumWallet), และ sig ขนาด 2420 ไบต์ ลงนามบน `"zetaphy.neuro-attestation.v1\n" + payloadHash`
  - `anchor` (ถ้ามี): chainId, สัญญา NeuroAnchor, hash, time, block
- `archiveHash` คือ keccak256 ของ JSON มาตรฐานของ `{format, payloadHash, signature{alg, publicKey, sig}}` ค่านี้คือสิ่งที่ `NeuroAnchor.anchor()` บันทึก พร้อมบล็อกและเวลาครั้งแรก
- **โมดูลเดียวที่ใช้ร่วมกัน** (`zetaphy-hub/pqattest.js` ไม่มี import ผู้เรียกส่งฟังก์ชันเข้ารหัสเข้าไปเอง) ใช้ใน:
  - **CLI:** `zetaphy attest-pq sign <report.json>` ลงนามด้วย `~/.zetaphy/pq.seed` ของเครื่องนี้, `verify <archive>` ตรวจ, `anchor <archive> --anchor 0x…` ยึดบนเชน
  - **ตัวตรวจในเบราว์เซอร์:** แท็บภูมิคุ้มกันใน hub ใช้ ML-DSA-44 และ keccak จาก `vendor/pqwallet.js` ที่กระเป๋ามีอยู่แล้ว และ SHA-256 จาก WebCrypto
- ตัวตรวจยังคำนวณ verdict hash ของรายงานใหม่ด้วยโค้ดของ Neuro (`verdict.js`) payload ที่ถูกสลับรายงานจึงถูกจับได้

### เทสต์

- `test/pqattest.test.js` ตรวจจับการแก้ไข: payload, รายงาน (แม้คำนวณ payloadHash ใหม่แล้ว), keyHash, สลับกุญแจ, แก้ลายเซ็น 1 ตัวอักษร, ลายเซ็นถูกตัด, format, alg, เวลา anchor, hash ของ anchor, ไฟล์ที่ไม่เคยถูกยึด, และการลงนามใหม่ด้วยกุญแจอื่น (ยังถูกต้อง แต่ผู้ลงนามเป็น "unknown")
- `test/assist.test.js` ลงนามและตรวจผ่านโพรเซส CLI
- e2e ของ hub ลงนามไฟล์ แล้วหน้าเว็บตรวจได้ว่า**ถูกต้อง** ส่วนสำเนาที่ถูกแก้ตรวจได้ว่า**ไม่ถูกต้อง**

### ข้อจำกัด

- "ผู้ลงนามที่เชื่อถือ" เป็นรายการที่ผู้อ่านส่งเข้ามาเอง (`--trusted`) ยังไม่มีทะเบียนกุญแจ PQ ของ runner บนเชน
- anchor พิสูจน์ได้ว่าไฟล์มีอยู่แล้ว ณ บล็อกนั้น ไม่ได้พิสูจน์ว่าเนื้อหาถูก

---

## 32 · ประกันการถูกแฮ็กแบบพาราเมตริก (testnet เท่านั้น)

### สิ่งที่สร้าง: `HackInsurance`

1. **pool** ฝากเงินแล้วได้ส่วนแบ่ง การถอนต้องรอ `withdrawDelay` (ค่าเริ่มต้น 7 วัน) governance ตั้งให้สั้นกว่าช่วงโหวตบวกช่วงคัดค้านของเคลมไม่ได้ จึงหนีเหตุการณ์ที่รู้ล่วงหน้าไม่ได้ ส่วนแบ่งที่ขอถอนยังรับความเสียหายจนกว่าจะจ่ายจริง
2. **ความคุ้มครอง** governance ระบุเป้าหมายที่คุ้มครอง (`targetKey(chainId, contract)`) พร้อมเพดานต่อเคลม เบี้ย = จำนวน × `premiumBps` × ระยะเวลา / ปี ความคุ้มครองที่ยังมีผลรวมกันได้ไม่เกิน `maxCoverBps` ของ pool (ค่าเริ่มต้น 3 เท่า)
3. **เคลม** ผู้ถือยื่นแฮชธุรกรรมของการโจมตี (1–16 รายการ) และช่วงบล็อก (อยู่ในช่วงคุ้มครองและเป็นอดีต) พร้อมแฮชของ**รายงานนิติวิทยาของ Neuro จากการ replay แบบกำหนดได้** และความเสียหายที่รายงานคำนวณ และวางเงินประกัน `evidenceHash = keccak256(abi.encode(chainid, target, txHashes, fromBlock, toBlock))`
4. **โหวตของคณะกรรมการ** runner ของ NeuroJobs เป็นผู้โหวต (ต้องยังทำงานอยู่และมีประวัติ แบบเดียวกับ ThreatRegistry) การอนุมัติจะนับก็ต่อเมื่อระบุ**แฮชรายงานและความเสียหายตรงกัน** แบบอื่นนับเป็นการปฏิเสธ
   - อนุมัติครบโควรัม: เคลมผ่าน
   - ปฏิเสธครบโควรัม: เคลมตก เงินประกันเข้า pool
   - ไม่ครบทั้งสองอย่างจนหมดช่วงเวลา: เคลมหมดอายุ คืนเงินประกัน
5. **ช่วงคัดค้าน** ใครก็คัดค้านได้โดยวางเงินประกัน governance เป็นผู้ตัดสิน:
   - คัดค้านสำเร็จ: ผู้คัดค้านได้เงินประกันทั้งสองก้อน
   - เคลมยืน: จ่ายเงินตามขั้นตอน
6. **การจ่าย** = ค่าต่ำสุดของ (ความเสียหาย, วงเงินคุ้มครอง, เพดานของเป้าหมาย, `maxClaimBps` ของ pool (20%), เพดานรายวันที่เหลือ) และไม่เกินที่ pool มี จ่ายได้ครั้งเดียวต่อความคุ้มครอง ใครก็สั่งจ่ายได้
7. **ติดตั้ง:** `zetaphy deploy-assist insurance --jobs 0x…`

### เทสต์

`test/insurance.test.js` 7 เทสต์: pool และเบี้ย, ความจุ, การอนุมัติและการจ่ายตามเพดาน, การปฏิเสธเมื่อ replay ต่างกัน, กฎหลักฐาน, ผลคัดค้านทั้งสองแบบ, การหมดอายุและการรอถอนของ LP, เพดานรายวัน

### สิ่งที่ยังไม่ได้ทำและเหตุผล

- **เครื่องมือ replay** ที่แปลงแฮชธุรกรรมและช่วงบล็อกเป็นรายงานนิติวิทยาแบบกำหนดได้ (fork ที่ `fromBlock-1`, รันซ้ำ, เทียบยอดเงิน) ยังไม่มี ตอนนี้ runner ต้องทำรายงานเองเพื่อให้โหวตตรงกัน นี่คือส่วนที่ขาดหลัก
- คุ้มครองเฉพาะสัญญาบน ZETAPHY เพราะเลขบล็อกเป็นของเชนนี้
- ไม่มีการตั้งราคาตามความเสี่ยง
- ไม่มีการป้องกันความผิดพลาดของ governance ในการตัดสินคัดค้าน
- ไม่ได้ตรวจบนเชนว่าเวลาของบล็อกที่เกิดเหตุอยู่ก่อนความคุ้มครองหมด runner ต้องตรวจเรื่องนี้ใน replay
- ห้ามใส่มูลค่าจริงเด็ดขาด เอกสาร หัวสัญญา และคำสั่งติดตั้ง บอกไว้ทุกที่

---

## 20 · ผู้ช่วยก่อนลงนาม

### สิ่งที่สร้าง

สรุปก่อนลงนามของ hub (`wallet-safety.js confirmTx`) รับ hook `simulate` และ `explain` แล้ว และแสดงผลเมื่อผลมาถึง หน้าต่างจึงไม่ต้องรอ `hub.js send()` ส่ง hook ทั้งสองเข้าไป (`assist.js presignHooks`) สรุปทำงาน 3 ขั้นตามลำดับ:

1. `eth_call` ของธุรกรรมเองจากผู้ใช้: จะล้มเหลวไหม เพราะอะไร (Error(string), Panic, หรือ selector ของ custom error) และ `eth_estimateGas` ให้ค่าแก๊ส
2. **`eth_call` ครั้งเดียวพร้อม state override** วางโค้ด `PresignProbe` (`tools/PresignProbe.sol` คอมไพล์เป็น `presign-probe.js` ด้วย `tools/build-presign.mjs`) ไว้ที่**ที่อยู่ของผู้ใช้เอง** และเรียกจากผู้ใช้ โพรบทำการเรียกแบบเดียวกันแล้วรายงานยอดเงินที่เปลี่ยนของผู้ใช้: เหรียญหลักและโทเคนที่เกี่ยวข้อง (เป้าหมาย, ที่อยู่ใน call data ที่มีโค้ด, โทเคนที่ hub รู้จัก) นี่คือเทคนิค honeypot ของ Neuro: ใช้ state override วางตัวช่วยไว้สำหรับการเรียกแบบอ่านอย่างเดียวครั้งเดียว
3. **ให้ AI อธิบาย (ถ้าต้องการ)** เมื่อผู้ใช้ตั้งค่าโมเดลไว้ในแผง AI ของ Neuro (origin และที่เก็บข้อมูลเดียวกัน) ปุ่ม "ให้ AI อธิบาย" จะส่งสรุปไปยัง**โมเดลของผู้ใช้เอง**ผ่านชั้น AI ของ Neuro (`/neuro/ai/providers.js`) prompt เก็บข้อความจากเชนไว้ใน `<data>` เป็นข้อมูลที่ไม่น่าเชื่อถือ และสั่งไม่ให้โมเดลบอกว่าธุรกรรมปลอดภัย คำตอบแสดงเป็นข้อมูลประกอบ พร้อมหมายเหตุใน 8 ภาษา

ข้อความมี 8 ภาษา: แถวผลจำลองอยู่ใน `assist-i18n.js` คีย์ของหน้าต่าง `cfSim`, `cfSimWait`, `cfExplain`, `cfExplainNote`, `cfExplainErr` อยู่ใน `wallet-safety-i18n.js` ไฟล์เหล่านี้คัดลอกไปทุกเว็บด้วย `npm run sync:shared`

### ทดสอบแล้ว

- `zetaphy-network/test/presign.test.js` บน EVM ในหน่วยความจำผ่าน JSON-RPC จำลอง:
  - โพรบที่ commit ตรงกับการคอมไพล์ใหม่
  - การโอนโทเคน: −25 พอดี พร้อมแก๊ส
  - การส่งเหรียญหลัก
  - โทเคนใน call data ถูกเฝ้าดู
  - การเรียกที่ล้มเหลวพร้อมเหตุผล
  - โหนดที่ไม่รับ override ถอยไปใช้การเรียกธรรมดาและบอกผู้ใช้
  - การเข้ารหัส
  - prompt ของ AI (แยกข้อมูลออกจากคำสั่ง, คำตอบแบบ JSON และข้อความธรรมดา)
- **บนโหนด ZETAPHY จริง** (devnet `zetaphyd` ในเครื่อง): โพรบ override รายงาน `−7` สำหรับการโอน TestToken และรายงาน custom error ของการโอนเกินยอด
- e2e ของ hub ตรวจแถวผลจำลองและคำอธิบายของ AI ภายใต้ CSP ของเว็บ

### ข้อจำกัด

- `eth_call` ไม่คิดค่าแก๊ส
- ผลเป็นของบล็อกล่าสุด
- ระหว่างการเรียก บัญชีผู้ใช้มีโค้ด สัญญาที่ตรวจ `extcodesize(msg.sender) == 0` หรือ `tx.origin` อาจทำงานต่างไป
- ไม่ได้ติดตามการอนุมัติ NFT และโทเคนที่ไม่อยู่ในรายการ (สรุปอ่านการอนุมัติเอง)
- โหนด ZETAPHY ไม่ให้บริการ `debug_traceCall` หรือ `eth_simulateV1` (ตรวจบน devnet แล้ว) ถ้ามี จะเห็นการโอนทุกรายการ
- แอป DEX และ NFT ยังไม่ส่ง hook มีแค่ hub โมดูลที่ใช้ร่วมกันรองรับแล้ว

---

## 21 · ผู้ช่วยธรรมาภิบาล

### สิ่งที่สร้าง: แท็บ **ธรรมาภิบาล** ใน hub (`govassist.js`, `assist.js`)

- **ข้อเสนอ**ที่อยู่ในช่วงวางมัดจำหรือโหวต (Cosmos REST) ถอดความข้อความ:
  - `MsgUpdateParams` ของ gov, staking, slashing, mint, distribution, bank, evm, erc20, feemarket: แต่ละฟิลด์**เทียบกับพารามิเตอร์ปัจจุบันของโมดูล** และติดธงเมื่อกฎบอกว่าต้องอ่านให้ละเอียด:
    - ลดเวลาโหวตหรือเวลาถอน stake ลงมาก
    - ลดโควรัมหรือเกณฑ์
    - ทำให้ยื่นข้อเสนอถูกลงมาก
    - ลดจำนวน validator
    - ลงโทษหนักขึ้น
    - เพิ่มเงินเฟ้อ
    - เพิ่มภาษีชุมชน
    - ปิดการโอน
    - ปิด precompile ของ EVM
    - เปลี่ยนสิทธิ์การเข้าถึง EVM
    - ปิดค่าธรรมเนียมพื้นฐาน
  - `MsgEVMCall` จาก gov module: บอกชื่อฟังก์ชัน (setGovernance, upgradeTo, setIsm, grantRole, … แต่ละตัวมีระดับความเสี่ยง) แล้ว**จำลองด้วย `eth_call` จาก gov module** บนสถานะปัจจุบัน
  - การอัปเกรดซอฟต์แวร์, การใช้เงิน และข้อความที่ไม่รู้จัก ก็ติดธงด้วย
- **คิวของ ZetaphyTimelock:**
  - เหตุการณ์ `CallScheduled` ที่ยังไม่ถูกรันหรือยกเลิก (ตั้งแต่ `timelockBlock` ของการเปิดตัว) พร้อม `getTimestamp` ว่ารันได้เมื่อไหร่
  - จำลองแต่ละคำสั่ง**ในฐานะ timelock** และติดธงแบบเดียวกัน
- ธงหมายถึง "อ่านให้ละเอียด" **ไม่เคย**หมายถึง "โหวตเห็นด้วย" หรือ "ไม่เห็นด้วย"
- 8 ภาษา (`assist-i18n.js` และชื่อแท็บใน `i18n.js`)

### เทสต์

- `zetaphy-hub/test/assist.test.mjs` ด้วย mock:
  - ทุก selector และ topic เท่ากับ keccak ของ signature
  - กฎพารามิเตอร์
  - การอ่าน `MsgEVMCall` (data แบบ base64, gov module แบบ bech32)
  - `reviewProposals` (เทียบค่าและการจำลองที่ล้มเหลวจาก gov module)
  - `reviewTimelock` (ตั้งเวลาไว้ vs รันแล้วหรือยกเลิกแล้ว, จำลองในฐานะ timelock)
- `assist.e2e.mjs`: ถอดความข้อเสนอและติดธงในเบราว์เซอร์ รวมถึงภาษาไทย

### ข้อจำกัด

- กฎเป็นรายการตายตัว การเปลี่ยนที่เสี่ยงแต่อยู่นอกรายการจะแสดงเป็นการเทียบค่าธรรมดา ไม่ติดธง
- ยังไม่ถอดความข้อเสนอแบบเก่า `MsgExecLegacyContent`
- `eth_call` ใช้สถานะปัจจุบัน ไม่ใช่สถานะตอนที่รันจริง

---

## 22 · ผู้ช่วย validator

`sudo zetaphy-validator status` ตอนนี้ปิดท้ายด้วย**การวินิจฉัย** แต่ละข้อมีคำแนะนำเป็นภาษาง่าย:

- **sync:** กำลังตามบล็อก หรือ sync แล้วพร้อมวินาทีต่อบล็อกที่วัดได้ (จากบล็อกแรกและบล็อกล่าสุดของโหนด)
- **peers:** จาก `net_info` ถ้าไม่มีหรือมีน้อย แนะนำให้เปิดพอร์ต 26656
- **ดิสก์:** การใช้ดิสก์ของโหนด ที่ 85% แนะนำให้ลบข้อมูล ที่ 95% บอกว่า "ด่วน"
- **บล็อกที่พลาด:** จาก `q slashing signing-info` และพารามิเตอร์ slashing
- **ความเสี่ยงถูก jail** พร้อมเวลาโดยประมาณ validator ถูก jail เมื่อพลาดเกิน window − ceil(window × min_signed_per_window) บล็อก (`jail_eta`) เวลาโดยประมาณคือจำนวนบล็อกที่เหลือคูณเวลาต่อบล็อก หมายถึงอีกนานแค่ไหนจะถูก jail ถ้าโหนดหยุดตอนนี้ ระดับ:
  - ต่ำ / ปานกลาง (เหลือไม่ถึงหนึ่งในสี่ของโควตา) / สูง (พลาดอีกบล็อกเดียวก็ถูก jail)
  - ถูก jail อยู่ (พร้อมคำสั่ง unjail)
  - TOMBSTONED

เทสต์: `zetaphy-network/test/validatorstatus.test.js` ใช้ตัวแทนของ zetaphyd, curl และ df ครอบคลุมการคำนวณ, โหนดปกติ, ปัญหาแต่ละแบบพร้อมคำแนะนำ, ถูก jail, tombstoned และยังไม่เป็น validator ส่วน `joinvalidator.test.js` เดิมยังผ่าน

ข้อจำกัด:

- เวลาต่อบล็อกเป็นค่าเฉลี่ยจากบล็อกที่โหนดเก็บไว้
- การวินิจฉัยอ่านจากโหนดในเครื่องเท่านั้น โหนดที่ขึ้นว่า "sync แล้ว" อาจอยู่บน fork ก็ได้ ใช้ `zetaphy pq verify-block` ตรวจเรื่องนั้น

---

## เทสต์ที่รัน

| แพ็กเกจ | คำสั่ง | ผล |
|---|---|---|
| zetaphy-network | `npm test` | ผ่าน 463 / 463 (ใหม่: neurooracle 10, neuroattest 4, insurance 7, pqattest 5, assist 4, presign 6, validatorstatus 4) |
| zetaphy-network | dry run `saphan-dryrun.js --neuro-oracle --kit` บน devnet zetaphyd 2 ตัวในเครื่อง | NEURO ORACLE DRY RUN OK |
| neuro-oracle-osmo | `cargo test` | ผ่าน 3 / 3 |
| zetaphy-hub | `npm test`; e2e `hub`, `safety`, `mine`, `assist` | 50 / 50; e2e ผ่านทั้งหมด |
| zetaphy-dex | `npm test` | ผ่าน 111 / 111 (ใหม่: badge 2) |
| zetaphy-launch | `npm test` | ผ่าน 20 / 20 |

## สิ่งที่เหลือ (ตามลำดับ)

1. หลัง 2026-11-01:
   - ติดตั้ง sender และ receiver แล้วต่อเส้นทาง (`scripts/neuro-oracle.js`)
   - เพิ่ม sender ใน whitelist ของ relayer
   - เพิ่มโหมด `deploy` ใน `neuro-oracle.yml` และเขียน `neuro-oracle.json`
   - ติดตั้ง NeuroAttest และ NeuroAnchor แล้วใส่ใน state ของการเปิดตัวและ `deployments.json`
2. รัน dry run ของ workflow ที่ใช้แกน Hyperlane จริง (anvil + Hyperlane CLI) อย่างน้อยหนึ่งครั้ง
3. Osmosis:
   - build และตรวจ wasm (`cosmwasm/optimizer`, `cosmwasm-check`)
   - อัปโหลดไป osmo-test-5
   - instantiate ด้วย `wasm-sender` ที่เชนรายงานเอง
   - `setIbcRoute`
4. เครื่องมือ replay นิติวิทยาแบบกำหนดได้สำหรับข้อ 32 ถ้าไม่มี โหวตประกันจะตรงกันได้ยากในทางปฏิบัติ
5. ให้แอป DEX และ NFT ส่ง hook ก่อนลงนามด้วย
6. ทะเบียนกุญแจ PQ ของ runner บนเชน เพื่อให้ "ผู้ลงนามที่เชื่อถือ" ไม่ต้องขึ้นกับรายการของผู้อ่าน
