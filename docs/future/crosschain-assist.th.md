[English](crosschain-assist.md) | **ภาษาไทย**

# ความปลอดภัยข้ามเชนและผู้ช่วย (testnet)

สายงาน `fut-crosschain` มี 8 รายการ: oracle ความปลอดภัยข้ามเชนของ Neuro (18), ภูมิคุ้มกันหมู่ (28), ใบรับรอง "Neuro-checked" (19),
การรับรอง AI ที่ทนควอนตัม (30), ประกันการถูกแฮ็กแบบพาราเมตริก (32), ผู้ช่วยก่อนลงนาม (20), ผู้ช่วยธรรมาภิบาล (21) และผู้ช่วย validator (22)

ทุกอย่างในนี้ใช้กับ **testnet เท่านั้น** ไม่มีเงินจริง และไม่ต้องมีเซิร์ฟเวอร์ที่เปิดตลอดเวลา งานทั้งหมดเกิดในสัญญา ในเบราว์เซอร์ (hub)
บน runner และ validator ที่มีคนรันอยู่แล้ว หรือใน GitHub Actions

| # | รายการ | สถานะ | อยู่ที่ |
|---|---|---|---|
| 18 | oracle ความปลอดภัยข้ามเชนของ Neuro | **สร้างแล้ว ทดสอบบนเชนในเครื่อง และพร้อมติดตั้ง** โหมด `deploy` ของ workflow (sender, receiver, wire, บันทึก, ตรวจ) รอ RPC ของ ZETAPHY (หยุดถึง 1 พฤศจิกายน) ฝั่ง Osmosis มีสัญญา, workflow build และคำสั่งพร้อม แต่ยังไม่ได้อัปโหลด | `contracts/NeuroOracle.sol`, `src/neurooracle.js`, `scripts/neuro-oracle.js`, `scripts/saphan-dryrun.js --neuro-oracle`, `.github/workflows/neuro-oracle.yml`, `.github/workflows/neuro-oracle-osmo.yml`, `cosmwasm/neuro-oracle-osmo/`, `zetaphy-chain/hyperlane/neuro-oracle.json` |
| 28 | ภูมิคุ้มกันหมู่ + ความครอบคลุมต่อเชน | **สร้างแล้ว**: ตัว push และมาตรวัดความครอบคลุม (CLI และ hub) แสดงว่า "ยังไม่ได้ติดตั้ง" จนกว่าข้อ 18 จะติดตั้ง | `src/neurooracle.js`, `zetaphy immune push/coverage`, แท็บ **ภูมิคุ้มกัน** ใน hub |
| 19 | ใบรับรอง "Neuro-checked" | **สร้างแล้ว**: สัญญา, CLI, `--attest` ของ DEX, ป้ายในแถบกระเป๋าและหน้าสวอป, การค้นใน hub ยังไม่ได้ติดตั้ง | `contracts/NeuroAttest.sol`, `zetaphy certify`, `zetaphy-dex/cli.js deploy --attest`, `walletbar.js`, `zetaphy-dex/web` |
| 30 | การรับรอง AI ที่ทนควอนตัม | **สร้างแล้ว**: ไฟล์เก็บถาวรลงนาม ML-DSA-44, การยึดบนเชน, ตัวตรวจแบบ CLI และในเบราว์เซอร์, เทสต์การแก้ไขไฟล์ | `zetaphy-hub/pqattest.js`, `src/pqattest.js`, `contracts/NeuroAttest.sol` (`NeuroAnchor`), `zetaphy attest-pq` |
| 32 | ประกันการถูกแฮ็กแบบพาราเมตริก (testnet) | **สัญญาต้นแบบและเครื่องมือ replay แบบกำหนดได้ พร้อมเทสต์** (EVM ในหน่วยความจำและ anvil) ยังไม่ได้ติดตั้ง | `contracts/HackInsurance.sol`, `src/replay.js`, `zetaphy insurance replay/vote`, `.github/workflows/insurance-replay.yml` |
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
  - `wire --sender 0x… --receivers a=0x…,b=0x… [--handover]`: ตั้งเส้นทางที่ยังขาด ถ้าใส่ `--handover` จะส่ง governance ให้ timelock ของ ZETAPHY ต่อ เมื่อ timelock เป็น governance ของ sender แล้ว `wire` จะไม่ส่งอะไรให้เส้นทางใหม่ แต่พิมพ์การเรียกนั้นออกมาเป็นข้อเสนอของ timelock (`proposals`: `to`, `data`) ให้ใช้กับ `timelock.yml`
  - `verify --chain <name>`: อ่านอย่างเดียว อ่านทุกที่อยู่ใน `neuro-oracle.json` กลับจากทั้งสองเชน ได้แก่ registry, NeuroJobs, Mailbox, เส้นทาง และ governance ของ sender กับ Mailbox, domain และ chain id ต้นทาง, sender, ISM (ที่อยู่ที่ factory ให้สำหรับ validator ของเรา พร้อมชุด validator และ threshold), governance, guardian ของ mirror และดูว่า mirror ไม่ได้หยุดอยู่ ถ้าอะไรไม่ตรงจะออกด้วย exit 1
  - `record --chain <name> …`: เขียนผลการติดตั้งลง `neuro-oracle.json`
  - `coverage`
- `zetaphy-chain/hyperlane/neuro-oracle.json` commit ไว้แล้วด้วย `sender: null` (ยังไม่ได้ติดตั้ง) การติดตั้งจะเติมเป็น `{ sender, zetaphy: { threats, jobs, mailbox, governance, tx, fromBlock }, receivers: { <chain>: { oracle, ism, governance, guardian, tx, fromBlock, workflowRun } } }` ผู้อ่าน 3 รายตามไฟล์นี้ได้เลยโดยไม่ต้องแก้อะไรอีก:
  - แท็บ **ภูมิคุ้มกัน** ของ hub (`zetaphy-hub/build.mjs` `immuneMirrors`)
  - `neuro-oracle.js coverage`
  - relayer: `saphan.js whitelist` / `relayer-env` เพิ่ม `{ originDomain: 77390, senderAddress: <sender>, destinationDomain: <chain> }` ต่อ mirror ลงใน `HYP_WHITELIST` และเพิ่มเชนลงใน `HYP_RELAYCHAINS` ถ้าไม่มีส่วนนี้ validator ของเราจะลงนามข้อความแต่ไม่มีใคร relay
- โหมดของ `.github/workflows/neuro-oracle.yml`:
  - **check**: อ่านอย่างเดียว
  - **dry_run**: บนเชนในเครื่อง pull request จะรันของ Base Sepolia
  - **verify**: อ่านอย่างเดียว รันเมื่อไรก็ได้ ใช้ขั้นตรวจของ deploy กับไฟล์บน branch ที่รัน
  - **deploy**: testnet จริง รันเองบน `main` เท่านั้น job ใช้ environment `testnet-deploy` (เจ้าของกดอนุมัติ กุญแจคือ `ZETAPHY_DEPLOYER_KEY` อ้างถึงด้วยชื่อเท่านั้น ดู docs/SECRETS-HARDENING.md) รูปแบบเดียวกับ job deploy ของ `saphan-route.yml`
  - `chain = all` ติดตั้งทุกเชนในตารางในการรันครั้งเดียว

#### คู่มือ: การติดตั้งหลัง 2026-11-01 (เจ้าของกดปุ่มเดียว)

เตรียมก่อน (ครั้งเดียว):

1. `zetaphyValidators.validators` ใน `saphan-chains.json` มีที่อยู่ของ `ZETAPHY_VALIDATOR_KEY` (**saphan-route** `mode = check` แสดงให้) ถ้ารายการว่าง การติดตั้งจะไม่ทำ
2. deployer `0x6af5…a245` มีเหรียญ ZETAPHY testnet และ ETH จาก faucet ในแต่ละเชน อย่างน้อยหนึ่งในสี่ของ `faucetEth` ในตาราง (Sepolia 0.1, Base Sepolia 0.02, Arbitrum Sepolia 0.02) **neuro-oracle** `mode = check` แสดงยอดเงิน
3. มี environment `testnet-deploy` ที่มี secret `ZETAPHY_DEPLOYER_KEY` จำกัดเฉพาะ branch `main` และเจ้าของเป็นผู้อนุมัติ (docs/SECRETS-HARDENING.md หัวข้อ 3)

ปุ่ม: **Actions → neuro-oracle → Run workflow** บน `main` เลือก `chain = all`, `mode = deploy`, `handover = true` → **Review deployments → Approve** จากนั้น job จะทำตามลำดับ:

1. **ตรวจก่อน** (อ่านอย่างเดียว) RPC ของ ZETAPHY ต้องตอบ chain id `0x12e4e` ไม่อย่างนั้นจะไม่ติดตั้งอะไรเลย (ก่อน 1 พฤศจิกายนจะไม่ตอบ) และตรวจยอดเงินของ deployer บน ZETAPHY และทุกเชน กับดูว่าตั้ง validator ของเราไว้แล้ว
2. **sender** บน ZETAPHY อ่าน ThreatRegistry และ NeuroJobs ตามตาราง ถ้า `neuro-oracle.json` มีอยู่แล้วจะข้ามขั้นนี้
3. **receiver** ต่อเชน: ISM ของเราผ่าน factory ของเชนนั้น แล้ว NeuroOracle governance คือ timelock v2 ของเชน และ guardian คือ multisig ของเชน (ของเส้นทาง Saphan ถ้าติดตั้งแล้ว ไม่อย่างนั้นสร้างใหม่) เชนที่มีในไฟล์แล้วจะข้าม
4. **wire** `setReceiver` ต่อเชนใหม่ แล้ว (เมื่อใส่ `handover`) ส่ง governance ของ sender ให้ timelock ของ ZETAPHY
5. **บันทึก** ลง `neuro-oracle.json`
6. **ตรวจ** อ่านกลับตามที่อธิบายข้างบนทุกเชน พร้อมรายการ whitelist ของ relayer และตัววัดความครอบคลุม
7. **push** ไฟล์ไป branch `neuro-oracle/all` ขั้นนี้ทำแม้ขั้นตรวจจะล้มเหลว ที่อยู่ที่ติดตั้งแล้วจึงไม่หาย log จะพิมพ์ลิงก์ compare ให้เปิด pull request แล้ว merge จากนั้น hub, coverage และ relayer จะอ่านไฟล์จาก `main` เอง

หลังจากนั้น:

- รัน **hyperlane-relayer** เองหนึ่งครั้ง (หรือรอรอบตามตาราง) เพื่อให้ข้อความที่ push ถูก relay
- push ธงด้วย `zetaphy immune push --sender <sender>` (ข้อ 28)
- **เพิ่มเชนภายหลัง** (หลังส่ง governance แล้ว): รัน `mode = deploy` ของเชนนั้น receiver จะถูกติดตั้งและบันทึก ส่วน `wire` จะพิมพ์การเรียก `setReceiver` เป็นข้อเสนอของ timelock ขั้นตรวจจะไม่ผ่านที่เส้นทาง จนกว่าข้อเสนอจะถูก schedule และ execute (workflow **timelock** `schedule` แล้ว `execute` เมื่อพ้นเวลารอ) แล้ว **neuro-oracle** `mode = verify` จะผ่าน
- ทีละเชนแทน `all`: ติดตั้งแต่ละเชนด้วย `handover = false` แล้ว merge pull request ของแต่ละเชนก่อนรันเชนถัดไป (ไฟล์บน `main` เก็บ sender ไว้) แล้วส่ง governance ตอนท้าย (`mode = deploy`, `handover = true` กับเชนที่บันทึกแล้ว ซึ่งจะทำแค่การส่ง governance)

#### Osmosis: build, store และ instantiate

การ build คือ `.github/workflows/neuro-oracle-osmo.yml` รันบน pull request ที่แตะสัญญา หรือรันเอง ขั้นตอนคือ:

- `cargo test`
- wasm ที่ optimize แล้วจาก `cosmwasm/optimizer:0.17.0` ตรึงด้วย digest `sha256:7e0b9229…7f85` image นี้ใช้ Rust 1.86.0 ส่วน image รุ่น 0.16.x ที่เก่ากว่า (Rust 1.81) อ่าน lockfile ไม่ได้ เพราะ dependency ปัจจุบันบางตัวใช้ edition 2024
- `artifacts/checksums.txt` และตรวจว่า wasm ไม่เกิน 819200 ไบต์
- `cosmwasm-check` 2.1.4
- artifact `neuro-oracle-osmo-wasm` ที่มี wasm และ checksum

จากนั้นคนที่มีกุญแจ Osmosis testnet และ OSMO testnet เล็กน้อยเป็นผู้ store และ instantiate บน osmo-test-5 ไม่มีค่าใช้จ่าย เพราะ OSMO testnet ได้จาก faucet คำสั่งเป็นดังนี้ โดยใช้ `NODE=https://rpc.testnet.osmosis.zone:443`:

```sh
# 0. testnet ต้องเปิดให้ทุกคนอัปโหลดโค้ดได้ (ไม่อย่างนั้นต้องยื่นข้อเสนอ governance บน testnet)
osmosisd q wasm params --node $NODE            # code_upload_access: Everybody
# 1. store wasm จาก artifact ของ workflow หลังเทียบ sha256 กับ checksums.txt แล้ว
osmosisd tx wasm store neuro_oracle_osmo.wasm --from <key> --chain-id osmo-test-5 --node $NODE \
  --gas auto --gas-adjustment 1.4 --gas-prices 0.025uosmo -y
osmosisd q tx <txhash> --node $NODE -o json | jq -r '.events[] | select(.type=="store_code") | .attributes[] | select(.key=="code_id") | .value'
osmosisd q wasm code-info <code_id> --node $NODE  # data_hash = sha256 ใน checksums.txt
# 2. sender ในมุมของ ibc-hooks: คำตอบของเชนเอง เทียบกับ ibcHooksSender() ก่อนจะไว้ใจค่าใดค่าหนึ่ง
ZSENDER=$(node -e 'import("./src/neurooracle.js").then(m => console.log(m.zetaphyBech32(process.argv[1])))' <NeuroOracleSender 0x…>)
osmosisd q ibc-hooks wasm-sender <osmosis channel-N> $ZSENDER --node $NODE
node -e 'import("./src/neurooracle.js").then(m => console.log(m.ibcHooksSender(process.argv[1], process.argv[2])))' <channel-N> $ZSENDER
# 3. instantiate: admin = admin ฝั่ง Osmosis ของเรา (pause, setHookSender) ไม่มี wasm admin (migrate ไม่ได้ แก้ไขด้วยสัญญาใหม่)
osmosisd tx wasm instantiate <code_id> '{"admin":"osmo1<admin>","hook_sender":"<osmo1… จากขั้น 2>","src_chain":77390}' \
  --label zetaphy-neuro-oracle --no-admin --from <key> --chain-id osmo-test-5 --node $NODE \
  --gas auto --gas-adjustment 1.4 --gas-prices 0.025uosmo -y
osmosisd q wasm list-contract-by-code <code_id> --node $NODE
```

4. บน ZETAPHY ให้ governance (timelock หลังส่งต่อแล้ว) เรียก `setIbcRoute("channel-N", "osmo1<contract>", 600)` บน sender โดย `channel-N` ตรงนี้คือฝั่ง ZETAPHY ของ channel Osmosis ของ Saphan (`zetaphy-chain/ibc`, `ROUTE=osmosis`)
5. ตรวจ: `zetaphy immune push` ด้วยธงหนึ่งอัน แล้ว `osmosisd q wasm contract-state smart osmo1<contract> '{"stats":{}}'`

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
- **dry run บนเชนจริง 2 เชนในเครื่อง** `node scripts/saphan-dryrun.js --chain basesepolia --neuro-oracle --kit` รันกับ devnet ของ `zetaphyd` สองตัว (chain id 77390 และ 84532 ผ่าน `scripts/devnet.sh`) โดยใช้ Mailbox และ ISM ของชุดทดสอบแทนแกน Hyperlane ผลคือ `NEURO ORACLE DRY RUN OK` พร้อมการปฏิเสธและความครอบคลุม 100.0% ถ้าไม่ใส่ `--kit` จะใช้ Mailbox และ ISM factory จริง ซึ่งเป็น dry_run ของ workflow ส่วนนี้ยัง**ไม่ได้รันที่นี่** เพราะต้อง fork RPC ของ testnet สาธารณะ ซึ่งสภาพแวดล้อมนี้เข้าไม่ถึง (ตอนนี้ติดตั้ง anvil 1.2.3 ตามเวอร์ชันที่ตรึงไว้ที่นี่แล้ว) CI ของ pull request เป็นผู้รัน
- `cargo test` ใน `cosmwasm/neuro-oracle-osmo` (`npm run test:cosmwasm`) 3 เทสต์: ตรวจผู้ส่ง, กฎรอบใหม่สุด, การหยุดชั่วคราว, รูปแบบคีย์, และการอ่าน memo ที่ ZETAPHY สร้าง ยังผ่านหลังการเปลี่ยนแปลงนี้
- **ขั้นตอนการติดตั้ง** (เพิ่มมาพร้อมโหมด `deploy`):
  - dry run (`saphan-dryrun.js --neuro-oracle`) ตอนนี้รันสิ่งที่ deploy ทำหลังสัญญาถูกสร้างด้วย คือ `recordDeployment` แล้ว `verifyDeployment` (อ่านกลับ 17 จุดก่อนส่ง governance) แล้วส่ง governance ให้ตัวแทน timelock แล้ว `verify` อีกรอบ และเส้นทางใหม่หลังส่ง governance ออกมาเป็นข้อเสนอของ timelock ใช้ `--kit` กับ anvil ในเครื่องสองตัว (77390 และ 84532): `NEURO ORACLE DRY RUN OK`
  - ขั้นตอน shell ของ job deploy เองถูกรันกับ anvil ในเครื่องสามตัว (ZETAPHY 77390, Base Sepolia 84532, Sepolia 11155111) โดยใช้ ISM factory ตัวแทน สามรอบ คือติดตั้งเชนแรก, รอบที่สองเพิ่มเชนพร้อม `handover` และรันซ้ำ (ไม่มีอะไรต้องทำ) ทุกขั้นผ่าน ขั้นตรวจผ่าน และ neuro-oracle.json ออกมาในรูปที่ hub อ่าน การรันนี้ไม่ได้ commit (ต้องใช้ HTTPS ตัวแทนในเครื่องแทน RPC ในตาราง)
  - `test/saphanconfig.test.js`: `neuro-oracle.json` ที่ commit ไว้ (ไม่มี sender) ไม่เพิ่มรายการให้ relayer และ hub แสดง "ยังไม่ติดตั้ง" การบันทึกรวมกันได้ถูกต้อง (เก็บ sender เดิม, หนึ่งรายการต่อเชน, การปฏิเสธ) whitelist และค่าตั้งของ relayer มี ZETAPHY → แต่ละ mirror และ `immuneMirrors` ของ hub อ่านไฟล์เดียวกัน

### ข้อจำกัด

- DEX บนเชนอื่นต้อง**เลือก**เรียก `check(token)` เอง เราบังคับ Uniswap ไม่ได้
- ตอนหยุดชั่วคราว mirror จะ fail open (ตอบว่า "ไม่ติดธง") เพื่อให้ DEX ยังทำงานได้ถ้า validator ของเราถูกยึด แลกกับการไม่มีการป้องกันช่วงที่หยุด
- mirror เป็นปัจจุบันเท่ากับการ push ครั้งล่าสุดเท่านั้น เรื่องความเร็วดูข้อ 28
- เส้นทาง ICS-20 ใช้ 1 azetaphy ต่อข้อความ ถ้ารันบน Osmosis ไม่สำเร็จ การโอนจะถูกคืนและข้อความหายไป ตัว push ไม่ได้ติดตามการส่งผ่าน IBC ให้ส่ง `pushIbc` ใหม่
- wasm ที่ optimize แล้ว (`cosmwasm/optimizer`) และ `cosmwasm-check` รันเฉพาะใน `neuro-oracle-osmo.yml` บน GitHub เพราะที่นี่ไม่มี Docker daemon และไม่ได้รับอนุญาตให้ติดตั้ง `cosmwasm-check` ที่นี่ ส่วน `cargo build --target wasm32-unknown-unknown` ธรรมดาด้วย Rust 1.86.0 (toolchain ของ optimizer) build ได้ (245 KB ก่อน `wasm-opt`) สัญญายังไม่อยู่บน osmo-test-5
- ตัวกำหนดรอบของ relayer (`saphan.js gate`) ดูเฉพาะเส้นทาง bridge ไม่ได้ดู oracle ข้อความของ oracle อยู่ใน whitelist และถูก relay ทุกครั้งที่ relayer รัน หลัง push ถ้าไม่มีอะไรอื่นเคลื่อนไหว ให้รัน **hyperlane-relayer** เอง

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

### replay แบบกำหนดได้: รายงานนิติวิทยาของ Neuro (`src/replay.js`, `zetaphy insurance`)

เคลมระบุธุรกรรมและช่วงบล็อก replay แปลงสิ่งนี้เป็นรายงานที่ runner ทุกคนที่สุจริตคำนวณแฮชได้ตรงกัน แฮชนั้นคือ `reportHash` ที่เคลมยื่นและที่การโหวตต้องระบุซ้ำ

1. **ดึงข้อมูล** ธุรกรรมที่เคลมแต่ละรายการและ receipt มาจาก RPC ของเชน ทุกรายการต้องอยู่ใน `[fromBlock, toBlock]` และ `toBlock` ต้องห่างจากหัวเชนอย่างน้อย `--confirmations` บล็อก (ค่าเริ่มต้น 12) เพราะ RPC สาธารณะที่กระจายโหลดอาจยังไม่มีบล็อกใหม่สุด และบล็อกพวกนั้นยัง reorg ได้
2. **fork และ replay** anvil fork เชนที่ `fromBlock - 1` เวอร์ชัน foundry ตรึงไว้ที่ **v1.2.3** เหมือน workflow และเวอร์ชันอื่นจะถูกปฏิเสธ replay เฉพาะธุรกรรมที่เคลม ตามลำดับบนเชน:
   - แต่ละรายการรันในบล็อกที่มีเลขบล็อก เวลา base fee และ coinbase เดิม (anvil `--no-mining --order fifo` เติมบล็อกว่างระหว่างนั้น) ส่งจากผู้ส่งเดิม (impersonate) ด้วย data, value, gas และค่าธรรมเนียมเดิม
   - ธุรกรรมอื่นในช่วงนั้นตั้งใจไม่ใส่ รายงานบอกว่าธุรกรรมเหล่านี้ทำอะไร
3. **ส่วนต่างยอดเงิน**ของเป้าหมาย:
   - ก่อน คือสถานะที่จุด fork (`evm_snapshot` / `evm_revert`) หลัง คือสถานะหลัง replay
   - สินทรัพย์ที่นับ: เหรียญหลักของเชน, ERC-20 ทุกตัวที่ให้ด้วย `--tokens` และ ERC-20 ทุกตัวที่ธุรกรรมที่ replay โอนเข้าหรือออกจากเป้าหมาย (จาก log `Transfer`)
4. **ราคา** เป็น wei ของเหรียญหลักของเชน มีที่มาได้แค่สองทาง:
   - ราคาที่ระบุตรง ๆ: `--price 0x<token>=1.5` หมายถึง 1.5 เหรียญหลักต่อโทเคนหนึ่งหน่วยเต็ม
   - ข้อมูลบนเชนที่อ่าน**ที่สถานะ fork** ซึ่งเป็นก่อนการโจมตี: `price(token) / price(native asset)` ของ ZetaphyOracle ทั้งคู่เป็น USD ทศนิยม 18 ตำแหน่ง (`--price-oracle 0x… --native-asset 0x<WZETAPHY>`)

   สินทรัพย์ที่ไม่มีราคาจากทั้งสองทาง หรือที่ oracle ปฏิเสธ (เก่าเกิน, หยุด, เบรกเกอร์ตัด) จะอยู่ใน `unpriced` และนับเป็นศูนย์ ข้อมูลราคาเป็นส่วนหนึ่งของรายงาน ราคาต่างกันจึงได้แฮชต่างกัน
5. **ความเสียหาย** = max(0, −(ผลรวมส่วนต่างที่มีราคา)) เป็น wei ปัดเศษเข้าหาศูนย์ทีละสินทรัพย์
6. **JSON แบบ canonical**:
   - เรียงคีย์ ไม่มีช่องว่าง ใช้แค่ ASCII ที่พิมพ์ได้
   - จำนวนเต็มทุกตัวเป็นสตริงฐานสิบ ไม่มีทศนิยม ไม่มีเวลาของเครื่อง host, path หรือ output ของเครื่องมือ
   - ข้อมูลในรายงาน: หลักฐาน (พร้อม `evidenceHash` และ `targetKey` ที่คำนวณเหมือน `HackInsurance` ทุกประการ), บล็อก fork และแฮชของมัน, ของแต่ละธุรกรรมคือบล็อกเดิม, ลำดับ, เวลา, สถานะ และสถานะตอน replay (`matchesOriginal`), สินทรัพย์พร้อมค่าก่อน, หลัง, ส่วนต่าง, ราคา และมูลค่า, `unpriced` และ `loss`

   ไฟล์ถูกเขียนเป็นไบต์เหล่านั้นตรง ๆ ดังนั้น `keccak256(ไฟล์)` คือแฮชของรายงาน

คำสั่ง (testnet เท่านั้น):

```sh
zetaphy insurance replay --target 0x<สัญญาที่คุ้มครอง> --tx 0x…,0x… --from-block N --to-block M \
  [--price 0x<token>=1.5 | --price-oracle 0x<ZetaphyOracle> --native-asset 0x<WZETAPHY>] [--tokens 0x…] \
  [--source-rpc <EVM เชนอื่น> --chain-id <id ของเชนนั้น>] [--confirmations 12] [--anvil <path>] [--out report.json]
zetaphy insurance hash report.json                  # คำนวณใหม่และตรวจรายงาน (ข้อมูลหลักฐาน, แฮช)
zetaphy insurance claim --insurance 0x… --cover <id> --report report.json [--uri <ที่เผยแพร่รายงาน>]
zetaphy insurance vote --insurance 0x… --claim <id> --report <รายงานของผู้เคลม> [--accept-explicit-prices] [--dry-run]
```

**ตัวช่วยโหวตของคณะกรรมการ** (`vote`) ทำงานดังนี้:

1. อ่านเคลม ความคุ้มครอง และ event `ClaimEvidence` ของเคลมนั้น
2. เอาข้อมูลราคาจาก flag ของ runner เอง ถ้าไม่มีก็เอาจากรายงานของผู้เคลม รายงานที่ใส่ราคาเองจะถูกปฏิเสธและไม่ส่งโหวต เว้นแต่ runner ตรวจราคาเหล่านั้นแล้วใส่ `--accept-explicit-prices`
3. replay หลักฐานเองแล้วตรวจว่า:
   - เป้าหมายตรงกับของความคุ้มครอง
   - แฮชหลักฐานตรงกับของเคลม
   - ทุกธุรกรรมจบแบบเดียวกับบนเชน
   - ไม่มีธุรกรรมหลังความคุ้มครองหมด
   - ความเสียหายไม่เป็นศูนย์
   - แฮชและความเสียหายที่คำนวณใหม่ตรงกับของเคลม
4. โหวตอนุมัติ (ระบุแฮชและความเสียหายซ้ำ) เฉพาะเมื่อผ่านทุกข้อ ไม่อย่างนั้นโหวตปฏิเสธ

### เทสต์

- `test/insurance.test.js` 7 เทสต์: pool และเบี้ย, ความจุ, การอนุมัติและการจ่ายตามเพดาน, การปฏิเสธเมื่อ replay ต่างกัน, กฎหลักฐาน, ผลคัดค้านทั้งสองแบบ, การหมดอายุและการรอถอนของ LP, เพดานรายวัน
- `test/replay.test.js` 7 เทสต์บน EVM ในหน่วยความจำ ตรงนี้ "fork" คือการสร้างสถานะเริ่มต้นแบบกำหนดได้ชุดเดิมขึ้นใหม่ และเหตุการณ์เป็น fixture ทดสอบที่เขียนสคริปต์ไว้ (`test/helpers/ReplayKit.sol`: vault ที่ `sweep()` ลืมตรวจเจ้าของ มีธุรกรรม fixture 3 รายการ หนึ่งรายการใช้ได้เฉพาะที่เวลาของมันเอง และมีธุรกรรมที่ไม่เกี่ยวข้องคั่น) ครอบคลุม:
  - JSON แบบ canonical
  - `targetKey` และ `evidenceHash` ตรงกับของสัญญา
  - ความเสียหาย = เหรียญหลัก 50 + โทเคน 2 × 1.5 = 53 รันสองครั้งได้รายงานที่ไบต์ตรงกันและแฮชเดียวกัน หาโทเคนได้จาก log โทเคนที่ไม่มีราคาถูกระบุไว้ และธุรกรรมที่ไม่เกี่ยวข้องไม่ถูก replay ถ้า replay ผิดเวลาจะได้ `matchesOriginal: false` และแฮชอื่น
  - ราคาบนเชน (price stub) ได้ความเสียหายเท่าราคาที่ระบุตรง ๆ แต่ได้แฮชอื่น
  - การปฏิเสธ: อยู่นอกช่วง, ใกล้หัวเชนเกินไป, เชนผิด, ธุรกรรมที่ไม่มีอยู่
  - การจับรายงานที่ถูกแก้
  - คณะกรรมการบน `HackInsurance` ตัวจริง: runner คำนวณใหม่แล้วอนุมัติ เคลมจึง**ผ่าน** เคลมที่ใส่ความเสียหาย +1 ถูก runner ทั้งสองปฏิเสธ จึง**ตก** และธุรกรรมที่อยู่หลังความคุ้มครองหมดจะถูกปฏิเสธ
- `npm run test:anvil` (`scripts/insurance-replay-e2e.js` ใน CI คือ `.github/workflows/insurance-replay.yml` ที่ใช้ foundry v1.2.3) เป็นเหตุการณ์เดียวกันบนเชน anvil ในเครื่อง (77390) ผ่าน CLI:
  - `zetaphy insurance replay` สองครั้ง แต่ละครั้ง fork ด้วย anvil ตัวใหม่ ได้ไฟล์ที่ไบต์ตรงกัน แฮชเดียวกัน `keccak256(ไฟล์)` = แฮช และความเสียหาย 53
  - การรันที่ใช้ราคาจาก oracle
  - `claim` แล้ว `vote` ของ runner สองคน เคลมจึง**ผ่าน** เคลมที่แก้ความเสียหายถูก `vote` ปฏิเสธสองเสียง จึง**ตก**

  รันที่นี่แล้วด้วย anvil 1.2.3 (ติดตั้งจาก release ที่ตรึงไว้): `INSURANCE REPLAY E2E OK`

### สิ่งที่ยังไม่ได้ทำและเหตุผล

- คุ้มครองเฉพาะสัญญาบน ZETAPHY เพราะเลขบล็อกเป็นของเชนนี้ (ตัวเครื่องมือ replay เองใช้กับ EVM เชนไหนก็ได้ที่มี RPC ให้บล็อก fork)
- ข้อจำกัดของ replay:
  - replay เฉพาะธุรกรรมที่เคลม การโจมตีที่ต้องพึ่งธุรกรรมอื่นในช่วงนั้น (การเตรียมของผู้โจมตี การขยับราคา) ต้องเคลมธุรกรรมนั้นด้วย ได้ไม่เกิน 16 รายการ
  - ความเที่ยง: `PREVRANDAO` และแฮชของบล็อกที่สร้างใหม่เป็นของ anvil ไม่ใช่ของเดิม สัญญาที่อ่านค่าพวกนี้อาจทำงานต่างไป แล้ว `matchesOriginal` จะเป็น false และ runner จะปฏิเสธ
  - ความกำหนดได้ต้องอาศัย anvil ตัวเดียวกัน (ตรึงและบังคับไว้) และ RPC ที่ให้บล็อก fork อย่างซื่อตรง runner ควร replay กับโหนดของตัวเองหรือ RPC ที่ไว้ใจ RPC ที่โกหกเรื่องสถานะจะให้รายงานอื่น โหวตจึงไม่ตรงกัน แทนที่จะตรงกันบนเรื่องเท็จ
  - นับเหรียญหลักและยอด ERC-20 ไม่นับ NFT, สถานะ LP หรือการกู้ยืม และ approval ที่ค้างอยู่
- ไม่มีการตั้งราคาตามความเสี่ยง
- ไม่มีการป้องกันความผิดพลาดของ governance ในการตัดสินคัดค้าน
- ไม่ได้ตรวจบนเชนว่าเวลาของบล็อกที่เกิดเหตุอยู่ก่อนความคุ้มครองหมด รายงาน replay เก็บเวลาเดิมของแต่ละธุรกรรมไว้ และ `zetaphy insurance vote` ปฏิเสธธุรกรรมที่อยู่หลังความคุ้มครองหมด
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
| zetaphy-network | `npm test` หลัง `npm run build` (พร้อมข้อ 18 ที่พร้อมติดตั้งและ replay ของข้อ 32) | ผ่าน 566 / 566, fail 0, cancelled 0 (ใหม่: replay 7, saphanconfig 1) |
| zetaphy-network | `npm run test:anvil` (`scripts/insurance-replay-e2e.js`, anvil 1.2.3) | INSURANCE REPLAY E2E OK |
| zetaphy-network | `saphan-dryrun.js --neuro-oracle --kit` บน anvil ในเครื่องสองตัว (77390, 84532) พร้อมบันทึก / ตรวจ / ส่ง governance | NEURO ORACLE DRY RUN OK |
| neuro-oracle-osmo | `cargo test` (อีกรอบ); `cargo +1.86.0 build --release --target wasm32-unknown-unknown` | ผ่าน 3 / 3; build ได้ |
| zetaphy-hub | `npm test`; e2e `hub`, `safety`, `mine`, `assist` | 50 / 50; e2e ผ่านทั้งหมด |
| zetaphy-dex | `npm test` | ผ่าน 111 / 111 (ใหม่: badge 2) |
| zetaphy-launch | `npm test` | ผ่าน 20 / 20 |

## สิ่งที่เหลือ (ตามลำดับ)

1. หลัง 2026-11-01:
   - กดปุ่ม: **neuro-oracle** → `chain = all`, `mode = deploy`, `handover = true` (คู่มือในข้อ 18) แล้ว merge pull request `neuro-oracle/all` (whitelist ของ relayer และ hub จะตามไฟล์นี้เอง)
   - ติดตั้ง NeuroAttest และ NeuroAnchor แล้วใส่ใน state ของการเปิดตัวและ `deployments.json`
2. รัน dry run ของ workflow ที่ใช้แกน Hyperlane จริง (anvil + Hyperlane CLI) อย่างน้อยหนึ่งครั้ง ผ่าน pull request ที่แตะ oracle หรือรันเอง
3. Osmosis: รัน **neuro-oracle-osmo** แล้ว store, instantiate และ `setIbcRoute` ตามคำสั่งในข้อ 18 (ต้องมีกุญแจ Osmosis testnet และ channel Osmosis ของ Saphan)
4. ประกัน (ข้อ 32): ติดตั้ง HackInsurance บน testnet เมื่อมี runner ที่จะรัน `zetaphy insurance vote` ด้วย anvil 1.2.3 เท่านั้น
5. ให้แอป DEX และ NFT ส่ง hook ก่อนลงนามด้วย
6. ทะเบียนกุญแจ PQ ของ runner บนเชน เพื่อให้ "ผู้ลงนามที่เชื่อถือ" ไม่ต้องขึ้นกับรายการของผู้อ่าน
