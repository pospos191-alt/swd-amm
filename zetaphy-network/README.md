# zetaphy-network: ขั้น 1–5 ของ ZETAPHY (testnet)

| ขั้นในแผน | สิ่งที่มีให้แล้ว |
|---|---|
| 1 · ทุกคนรันร่างได้ | `zetaphy node start` ตรวจเครื่องเองแล้วรับงานจากตลาดงาน NeuroJobs ตรวจคำตอบแบบ 2 ใน 3 และจ่ายรางวัลเป็น ZETAPHY |
| 2 · ZETAPHY จ่ายค่า AI | ผู้ใช้จ่ายค่าตรวจสัญญาเป็น ZETAPHY ให้คนรันร่าง |
| 2 · จ่ายค่าธรรมเนียมเป็น USDC/USDT | StableGateway + relay: คนที่ไม่มี ZETAPHY เลยก็ใช้งานได้ โดยจ่ายเป็น test USDC/USDT |
| 2 · โหวตอัปเกรดในตัว | `zetaphy-chain/gov.sh` เสนอและโหวตอัปเกรดบนเชน |
| 2 · เตรียมแจกให้คนถือ SWD | `airdrop/`: snapshot ผู้ถือ SWD, แบ่งสัดส่วน และทำ Merkle root |
| 2 · ปล่อยรางวัลปีละ 10% | `RewardVault`: กองรางวัล 500 ล้านอยู่ในสัญญา ปล่อยรายวันรวมปีละ 10% ของที่เหลือ ไม่มีฟังก์ชันถอน |
| ประตู 1 | `zetaphy gate` รายงานความคืบหน้าจากข้อมูลบนเชน |
| 3 · สะพาน: จำกัดยอดต่อวัน + ปุ่มหยุดเฉพาะสะพาน | `BridgeGuard` + `BridgedToken` |
| 3 · หลายสะพาน + Neuro เป็นสะพาน + สะพานหลอก | `BridgeAirlock` + `NeuroLane` + `DecoyBridge` + `zetaphy bridge watch` |
| 4 · ระบบภูมิคุ้มกัน | `ThreatRegistry`: คนรันร่างที่มีผลงานโหวตว่าโค้ดไหนอันตราย Neuro จะเตือนโค้ดนั้นทุกที่ |
| 4 · ตลาดพลัง AI จ่ายเป็น ZETAPHY | `ComputeMarket`: วางเงินมัดจำงาน AI ไว้กับสัญญาจนกว่าจะส่งงานและยอมรับ |
| 5 · ต้านควอนตัม | precompile ML-DSA (FIPS 204) ในเชน + `QuantumWallet` + `zetaphy pq` + บัญชี PQ แท้ (`zetaphy pq native`) |

**ยังไม่มีเงินจริงในขั้นไหนเลย:** ขั้น 3 ขึ้นไปบน mainnet ต้องผ่านประตูในหัวข้อ "ก่อนเงินจริง" ท้ายไฟล์ก่อน

ทั้งหมดนี้ผ่านการทดสอบบนเชน ZETAPHY จริงแล้ว (`npm run test:devnet`)

ใครก็รัน Neuro ได้ด้วยคำสั่งเดียว แล้วรับรางวัลเป็น ZETAPHY บน testnet

## ทำงานอย่างไร

1. ผู้ใช้ส่งงาน "ช่วยตรวจสัญญานี้" พร้อมจ่ายค่าบริการเป็น ZETAPHY
2. ระบบจับฉลากว่าใครมีสิทธิ์รับงาน โดยถ่วงน้ำหนักตามเงินค้ำ ผู้ที่ได้สิทธิ์ 3 คนแรกได้ที่นั่ง แต่ละคนรัน Neuro บนเครื่องตัวเอง
3. แต่ละคนส่ง **commit** คือรหัสลับของคำตอบ จึงมองเห็นคำตอบของคนอื่นไม่ได้ และลอกกันไม่ได้
4. เมื่อที่นั่งเต็ม หรือหมดเวลา commit ทุกคนก็ **reveal** เปิดคำตอบ
5. คำตอบใดที่ **ตรงกัน 2 ใน 3** ถือเป็นผลตรวจ
   - คนที่ตอบตรงจะแบ่งค่าบริการกัน และได้รางวัลจากกองกลาง (ไม่เกิน 1 ZETAPHY และไม่เกิน 1/4 ของค่างาน ภายใต้เพดานต่อวัน)
   - คนที่ตอบไม่ตรง หรือ commit แล้วไม่ reveal จะถูกหักเงินค้ำ 10%
6. ถ้าไม่มี 2 คำตอบไหนตรงกัน หรือหมดเวลา ผู้ใช้จะได้ค่าบริการคืน

คำตอบที่ใช้เทียบเรียกว่า "verdict" สร้างโดย `zetaphy-neuro/src/verdict.js`
ซึ่งเก็บเฉพาะสิ่งที่กฎของ Neuro ตัดสิน และไม่เก็บค่าที่เปลี่ยนได้ระหว่างการอ่านสองครั้ง เช่น supply
คนรันร่างที่ซื่อสัตย์ทุกคนจึงได้ verdict เดียวกัน

## คนรันร่าง (node runner)

```
npm i -g ./zetaphy-network          # หรือ: node zetaphy-network/cli.js ...
zetaphy node start --rpc http://<โหนด ZETAPHY>:8545 --jobs 0x<NeuroJobs>
```

- ครั้งแรกระบบจะสร้างกุญแจของคนรันร่างไว้ที่ `~/.zetaphy/worker.key` (สิทธิ์ 0600)
  - ใช้กับ testnet เท่านั้น ห้ามเอากุญแจที่มีเงินจริงมาใช้
  - กุญแจไม่ถูกส่งออกจากเครื่อง
- ระบบตรวจเครื่องให้เอง: เครื่อง CPU ธรรมดาจะรันโหมด light ส่วนเครื่องที่มี GPU NVIDIA 8 GB ขึ้นไปจะรันโหมด heavy
  - ตอนนี้งานทุกงานยังเป็น Neuro ชั้น 1 ซึ่งใช้แค่ CPU
- ขั้นตอน:
  1. โอน ZETAPHY testnet เข้าที่อยู่ของคนรันร่าง แล้ว `zetaphy node register` เพื่อวางเงินค้ำ (ค่าเริ่มต้น 100 ZETAPHY)
  2. `zetaphy node start` เพื่อเริ่มรับงาน
  3. `zetaphy node status` ดูรายได้และสถิติ แล้ว `zetaphy node withdraw` เพื่อถอนรายได้
  4. จะเลิกรัน: `zetaphy node unbond` แล้วรอ 1 ชั่วโมง จากนั้น `zetaphy node withdraw-bond` และ `zetaphy node withdraw`
- ไฟล์ `~/.zetaphy/jobs-*.json` เก็บคำตอบที่ commit ไว้แล้ว ห้ามลบระหว่างที่มีงานค้าง เพราะถ้า reveal ไม่ได้จะถูกหักเงินค้ำ

## ผู้ใช้: ส่งงานตรวจสัญญา

```
zetaphy job request bsc 0xc1ed4b78071e7c9a84958d8be0215a10984fc28f --fee 0.1
zetaphy job get 0
```

เชนที่รองรับ: `eth`, `bsc`, `base`, `arbitrum`, `sol` และ `zetaphy` (ตัว ZETAPHY testnet เอง)

## ผู้ใช้ที่ไม่มี ZETAPHY: จ่ายเป็น test USDC/USDT (ขั้น 2)

```
zetaphy faucet usdc --relay http://<relay>:8080                       # รับ 1,000 tUSDC ต่อวัน (relay จ่ายค่า gas ให้)
zetaphy job request-stable bsc 0x... --relay http://<relay>:8080      # ส่งงาน จ่ายเป็น tUSDC
```

1. กระเป๋าของผู้ใช้เซ็น 2 อย่าง ได้แก่ คำขอส่งงาน (EIP-712) และ permit อนุญาตให้หักเหรียญ (EIP-2612)
2. relay ส่งธุรกรรมขึ้นเชนให้และจ่ายค่า gas เอง แล้วได้ทิปเป็น tUSDC ตามจำนวนที่ผู้ใช้ตกลงไว้
3. StableGateway หัก tUSDC ตามราคาที่ตั้งไว้ (testnet: 1 ZETAPHY = 0.01 tUSDC)
4. Gateway จ่ายค่างานเป็น ZETAPHY จากเงินสำรองของตัวเอง ถ้างานไม่สำเร็จ ZETAPHY จะคืนให้ผู้ใช้

ข้อควรรู้:
- ผู้ใช้กำหนดยอดสูงสุดที่ยอมจ่ายไว้ใน `maxCost` ได้
- relay ใช้คำขอซ้ำ แก้คำขอ หรือใช้คำขอที่หมดเวลาแล้วไม่ได้
- คนรันร่างคนไหนก็เปิด relay ได้: `zetaphy relay start --port 8080`
- USDC/USDT ตัวจริงจะมาผ่านสะพานในขั้น 3

## โหวตอัปเกรดเชน (ขั้น 2)

บนโหนด: `zetaphy-chain/gov.sh`

```
gov.sh propose-upgrade v2 <ความสูงบล็อก> "สรุป"   # มัดจำ 1,000 ZETAPHY
gov.sh vote 1 yes
gov.sh status 1
gov.sh plan
```

## กองรางวัลปล่อยปีละ 10% (ขั้น 2)

```
zetaphy deploy-vault --validators 0x<สัญญาหรือบัญชีรางวัล validator> --validators-share 30 \
  --fund 500000000 --governance 0x<multisig>
zetaphy vault status        # กองเหลือเท่าไร ปล่อยได้เท่าไรตอนนี้
zetaphy vault release       # ใครก็กดได้ และ `node start --vault 0x...` กดให้เองราวชั่วโมงละครั้ง
```

- แต่ละวันปล่อย 1 − 0.9^(1/365) ของที่เหลือ (ราว 0.0289%) รวมหนึ่งปีได้ 10% พอดี กองจึงอยู่ได้หลายสิบปี
- **ไม่มีฟังก์ชันถอน** ผู้ดูแล (multisig) ทำได้แค่เลือกผู้รับ และการเปลี่ยนผู้รับมีผลหลังประกาศ 7 วัน
  ส่วนที่ครบกำหนดก่อนเปลี่ยนจ่ายให้ผู้รับเดิม
- ผู้รับที่ปฏิเสธเงินไม่ทำให้คนอื่นไม่ได้รับ ส่วนของมันค้างอยู่ในกองต่อ
- ส่วนของ NeuroJobs จ่ายผ่าน `fund()` เข้ากองรางวัลคนรันร่างโดยตรง

## เตรียมแจก ZETAPHY ให้คนถือ SWD (ขั้น 2: เตรียม ยังไม่แจกจริง)

```
node airdrop/cli.js snapshot --mint <SWD mint> --exclude <ที่อยู่ vault ของ pool,...> > snapshot.json
node airdrop/cli.js allocate snapshot.json --min 1000000 --cap-bps 100 > allocations.json
node airdrop/cli.js merkle allocations.json > merkle.json
```

- **snapshot** รวมยอด SWD ของทุกบัญชี (SPL และ Token-2022) ต่อเจ้าของกระเป๋า อ่านจาก Solana อย่างเดียว
  - ใส่ที่อยู่ vault ของ pool ใน `--exclude` ด้วย เพราะเหรียญใน pool เป็นของผู้ให้สภาพคล่อง ไม่ใช่ของ PDA
- **allocate** แบ่ง 200,000,000 ZETAPHY ตามสัดส่วน
  - กรองยอดเล็กมากทิ้งด้วย `--min`
  - จำกัดส่วนแบ่งต่อคนได้ด้วย `--cap-bps` (100 = 1%) ส่วนที่เกินเพดานจะแบ่งให้คนที่เหลือ
  - เศษจากการปัดจะแสดงใน `dust` ไม่หายไป
- **merkle** สร้าง root ขนาด 32 ไบต์ พร้อม proof ของแต่ละคน
  - root นี้ใช้กับสัญญาแจกเหรียญในขั้น 3
  - สัญญานั้นต้องตรวจลายเซ็น Solana ของเจ้าของกระเป๋า และต้องผ่าน audit ก่อน

## ประตู 1

```
zetaphy gate
```

รายงาน:
- เชนรันมาแล้วกี่วัน
- บล็อกเคยค้างไหม
- คนรันร่างที่เปิดคำตอบในรอบ 30 วันมีกี่ที่อยู่

ข้อมูลบนเชนบอกไม่ได้ว่า "คนละคนกันจริง" ตัวเลขนี้จึงเป็นเพดานบน ต้องให้คนตรวจยืนยันอีกที

## ขั้น 3: สะพานที่เสียหายได้ไม่เกินเพดานต่อวัน

`BridgeGuard` คั่นระหว่างสะพานทุกสาย (Hyperlane, IBC) กับเหรียญที่ข้ามมา เช่น USDC บน ZETAPHY

- **adapter ของสะพานแต่ละสาย** เป็นผู้เดียวที่สั่งผลิต (ขาเข้า) หรือเผา (ขาออก) เหรียญของสายนั้นได้
  - แต่ละทิศมีเพดานต่อวันแยกกัน ถ้าสะพานถูกแฮ็ก จะเสียได้ไม่เกินเพดานของวันนั้น
- **guardian** กดหยุดสะพานได้ทันที แต่เปิดคืนไม่ได้และโยกเงินไม่ได้
  - คนที่เปิดคืนได้คือ governance เท่านั้น (gov module หรือ multisig)
  - การหยุดสะพานไม่ทำให้เชนหยุด
- ฝั่ง IBC (USDC ของแท้ผ่าน Noble) มีเพดานระดับเชนด้วย (`x/ratelimit`) ตั้งโดย governance ด้วย `zetaphy-chain/gov.sh propose-ratelimit` (ดู zetaphy-chain/README.md ขั้น 3)

### ด่านก่อนเข้า ZETAPHY: หลายสะพาน, Neuro เป็นสะพาน, สะพานหลอก

```
เชนต้นทาง (LockBox)
   │  ล็อกเหรียญ
   ├──► สะพาน 1: Hyperlane ─────────┐
   ├──► สะพาน 2: Neuro (คนรันร่าง 2/3) ─┤──► BridgeAirlock (ห้องกักกัน) ──► BridgeGuard (เพดานต่อวัน) ──► ZETAPHY
   └──► (สะพานอื่นในอนาคต) ─────────┘          ▲ Neuro / guardian กดยับยั้งได้ระหว่างกักกัน
                                                 ▲ ที่อยู่ที่ไปแตะ DecoyBridge = ห้ามออก
ผู้โจมตี ──► DecoyBridge (สะพานหลอก ไม่มีเงิน) ──► ทำเครื่องหมายผู้โจมตี
```

1. **ต้องมีหลายสะพานยืนยันตรงกัน:** การโอนหนึ่งรายการต้องได้รับการยืนยันจากสะพานอิสระอย่างน้อย `threshold` สาย (ค่าเริ่มต้น 2) และรายละเอียดต้องตรงกันทุกตัว
   - ถ้าสะพานสายเดียวถูกแฮ็ก ก็ปลอมเงินไม่ได้ แม้รอนานแค่ไหน
2. **Neuro เป็นสะพานหนึ่งสาย:** คนรันร่างใช้ `zetaphy bridge watch` เฝ้า LockBox บนเชนต้นทาง
   - รอให้บล็อกถูกยืนยันพอก่อน (`--confirmations`) แล้วจึงยืนยันการโอน
   - คนรันร่างที่มีผลงานครบ quorum (ค่าเริ่มต้น 2) ยืนยันตรงกัน `NeuroLane` จึงยืนยันต่อให้ห้องกักกัน
3. **ห้องกักกัน:** เมื่อได้รับการยืนยันครบแล้ว ต้องรอ `quarantine` วินาทีก่อน
   - ระหว่างนั้นคนรันร่างโหวตยับยั้งได้ (quorum) และ guardian ก็ยับยั้งได้
4. **สะพานหลอก:** `DecoyBridge` หน้าตาเหมือนสะพาน (`mint`, `release`, `withdraw`, `handle`, `upgradeTo`, …) แต่ไม่มีเงิน
   - ใครเรียกฟังก์ชันที่เปลี่ยนสถานะ จะถูกทำเครื่องหมาย ทั้งผู้เรียกและ `tx.origin`
   - การโอนจากหรือถึงที่อยู่ที่ถูกทำเครื่องหมายจะไม่ถูกปล่อยออก
   - สะพานหลอก **ไม่สั่งหยุดสะพานจริง** เพราะถ้าสั่งได้ ใครก็ป่วนระบบได้ด้วยการกดสะพานหลอก
   - governance ปลดเครื่องหมายที่ทำผิดพลาดได้
5. เงินที่ผ่านทุกด่านแล้วยังต้องผ่านเพดานต่อวันของ `BridgeGuard` อีกชั้น

```
zetaphy deploy-bridge --quarantine 3600 --lane 0x<Hyperlane adapter> --guardian 0x<guardian>
zetaphy bridge watch --source-rpc https://<เชนต้นทาง> --lockbox 0x... --confirmations 12 --release
```

## ขั้น 4: ระบบภูมิคุ้มกันและตลาดพลัง AI

**ThreatRegistry**
- คนรันร่างที่ยัง active และมีคำตอบที่ถูกยอมรับแล้ว โหวตว่า "โค้ดลายนิ้วมือนี้อันตราย"
- ครบ 3 เสียงจากคนละที่อยู่ก็ติดธง
- Neuro อ่านธงนี้ผ่าน `threatLookup` แล้วเตือนระดับ **สูง** ให้ทุกสัญญาที่ใช้โค้ดเดียวกันในทุกเชน
- ปลดธงต้องใช้ 3 เสียงเช่นกัน (อุทธรณ์ต่อเครือข่าย ไม่ใช่ต่อคนคนเดียว)

**ComputeMarket**
- คำตอบจาก AI ไม่ได้ออกมาเหมือนกันทุกครั้ง จึงใช้วิธี 2 ใน 3 แบบ Neuro ชั้น 1 ไม่ได้
- ใช้การวางเงินมัดจำกับสัญญาแทน:
  1. ผู้ใช้จ่ายเงินล่วงหน้า
  2. คนรันร่างที่มีผลงานรับงานไปทำ แล้วส่งผล (hash + URI)
  3. ผู้ใช้ยอมรับ หรือปฏิเสธภายใน 1 วัน ถ้าเงียบ คนรันร่างได้เงิน
- จำนวนครั้งที่ถูกปฏิเสธเปิดให้เห็นทั้งสองฝั่ง

## ขั้น 5: ต้านควอนตัม

เชน ZETAPHY มี precompile ตรวจลายเซ็น **ML-DSA** (FIPS 204 มาตรฐาน NIST ที่ต้านคอมพิวเตอร์ควอนตัม) อยู่ที่ `0x…0900`
- ใช้ Cloudflare CIRCL v1.6.3 และติดตั้งผ่าน patch ใน `zetaphy-chain/setup-node.sh`
- ชุดทดสอบของ precompile รันใน CI ทุกครั้งที่แก้ส่วนเชน
- **สำหรับผู้เขียนสัญญา:** ถ้าลายเซ็นไม่ถูกต้อง precompile คืนค่าว่าง (ไม่ revert) เหมือน P256 (RIP-7212) ต้องตรวจว่าค่าที่คืนเป็น 1 ไม่ใช่ดูแค่ว่าเรียกสำเร็จ (`QuantumWallet` ตรวจแบบนี้อยู่แล้ว)

```
zetaphy deploy-pq                 # ผู้ดูแล: ติดตั้ง QuantumWalletFactory
zetaphy pq new                    # กระเป๋าที่ใช้ ML-DSA อย่างเดียว ไม่มีกุญแจ ECDSA เลย
zetaphy pq new --hybrid           # ต้องเซ็นทั้ง ML-DSA และ ECDSA
zetaphy pq address
zetaphy pq send 0x... 1.5
```

- รู้ที่อยู่กระเป๋าได้ก่อนสร้าง จึงรับเงินได้ตั้งแต่ก่อนมีตัวกระเป๋า
- seed 32 ไบต์เก็บที่ `~/.zetaphy/pq.seed` (0600) หรือแบบเข้ารหัสที่ `pq.seed.json` เมื่อตั้ง `ZETAPHY_PASSPHRASE`
  - ถ้าหาย ย้ายเงินออกไม่ได้ ต้องสำรองไว้
- ทดสอบแล้วว่าลายเซ็นจาก JavaScript (@noble/post-quantum) ผ่านการตรวจของ Go (CIRCL) บนเชนจริง

### บัญชี PQ แท้ (native): ไม่มีกุญแจ ECDSA และไม่ต้องมีคนจ่ายค่าแก๊สแทน

`zetaphy pq new|address|send` ข้างบนเป็นสัญญาบน EVM จึงยังต้องมีบัญชี ECDSA จ่ายค่าแก๊ส
บัญชีแบบ native ต่างออกไป: เป็นบัญชี Cosmos ธรรมดาที่เชนตรวจลายเซ็น ML-DSA-44 เอง

```
zetaphy pq native                              # ที่อยู่ zetaphy1… และ 0x… (บัญชีเดียวกัน) + ยอดเงิน
zetaphy pq native send zetaphy1... 1.5         # หรือ 0x... ก็ได้
zetaphy pq native send 0x... 1.5 --gas 500000  # ค่าเริ่มต้น 400000

# เรียกสัญญาบน EVM ด้วยบัญชีนี้ (msg.sender = ที่อยู่ 0x… ของบัญชีนี้)
zetaphy pq native call 0x<สัญญา> 0x<calldata> [--value 0.5] [--gas 200000]   # --gas คือ gas ฝั่ง EVM
zetaphy pq native token-balance 0x<token>                  # ยอด ERC-20 (อ่านอย่างเดียว)
zetaphy pq native token-send 0x<token> 0x... 12.5          # โอน ERC-20 (ผู้รับเป็น zetaphy1… ก็ได้)

# stake กับ validator
zetaphy pq native stake zetaphyvaloper1... 100             # --gas ค่าเริ่มต้น 500000
zetaphy pq native unstake zetaphyvaloper1... 40            # ได้คืนหลังพ้นช่วง unbonding
zetaphy pq native rewards zetaphyvaloper1...               # ถอนรางวัล stake

# สร้างสัญญาใหม่ (deploy) ด้วยบัญชีนี้ พิมพ์ที่อยู่สัญญาที่ได้
zetaphy pq native deploy 0x<init code> [--value 0.5] [--gas 3000000]
```

**ใช้สัญญา EVM และ stake ได้โดยไม่มีกุญแจ ECDSA เลย**
- `call` และ `token-send` ส่งข้อความ `/zetaphy.pq.v1.MsgEVMCall` (ธุรกรรม Cosmos ที่เซ็นด้วย ML-DSA-44)
  - เชนรันคำสั่งนั้นบน EVM โดยให้ `msg.sender` เป็นที่อยู่ 0x… ของบัญชีนี้ (20 ไบต์เดียวกัน)
  - จึงใช้ token, DeFi และสัญญาอื่น ๆ ได้เหมือนบัญชี ECDSA
- `stake`, `unstake`, `rewards` เป็นข้อความมาตรฐานของ Cosmos SDK (`MsgDelegate`, `MsgUndelegate`, `MsgWithdrawDelegatorReward`)
  - ที่อยู่ validator ต้องขึ้นต้นด้วย `zetaphyvaloper1` และตรวจ checksum ทุกครั้ง
- `token-send` อ่าน `decimals()` และ `symbol()` ของ token ด้วย `eth_call` แล้วแสดงก่อนส่ง
- ก่อนเซ็น คำสั่งจะลองรันการเรียกด้วย `eth_call` จากบัญชีนี้ก่อน
  - ถ้าจะ revert (เช่น token ไม่พอ) จะไม่ส่งอะไรเลย
  - ถ้าส่งไปแล้ว revert บนเชน ธุรกรรมล้มทั้งก้อน เงินและ token ไม่ขยับ เสียแค่ค่าธรรมเนียม
- ค่าแก๊ส: เชนคิดแก๊ส EVM รวมในมิเตอร์แก๊สของธุรกรรม Cosmos
  - gas ของธุรกรรม = gas EVM (`--gas`, ค่าเริ่มต้น 200000) + 400000 (ตรวจลายเซ็นและขนาดธุรกรรม)
  - gas EVM ต้องอยู่ระหว่าง 21000 ถึง 10,000,000
  - อย่าตั้ง `--gas` สูงเกินจำเป็น: เชนคิดอย่างน้อยสัดส่วนหนึ่งของ gas ที่ตั้งไว้
- ข้อจำกัด
  - log ของ EVM จากคำสั่งเหล่านี้ **ไม่ขึ้นใน `eth_getLogs`** เพราะเป็นธุรกรรม Cosmos ไม่ใช่ธุรกรรม EVM
    - ยอดเงินและยอด token ถูกต้องเสมอ แต่หน้าเว็บหรือ indexer ที่ดูจาก event `Transfer` จะไม่เห็นรายการนี้
- `deploy` คือ `MsgEVMCall` ที่ไม่มี `to` (data = init code) ธุรกรรมละหนึ่งสัญญา
  - ที่อยู่สัญญา = `CREATE(บัญชีนี้, nonce)` โดย nonce = sequence ที่เซ็น + 1 (ante handler เพิ่มให้ก่อน) CLI คำนวณและพิมพ์ให้
  - การสร้างใช้ nonce นั้นไปด้วย sequence ของบัญชีจึงจบที่ sequence ที่เซ็น + 2 (CLI อ่าน sequence จาก `zetaphy_pqAccount` ทุกครั้งก่อนเซ็น)
  - กับ `--as` ที่อยู่ = `CREATE(บัญชีที่ล็อก, sequence ปัจจุบันของบัญชีนั้น)`
  - event `zetaphy_evm_call` ของธุรกรรมมี attribute `created` เป็นที่อยู่เดียวกัน

### ล็อกควอนตัม: ยกบัญชี ECDSA (MetaMask) ให้บัญชี ML-DSA-44 ดูแล แบบถาวร

บัญชี ECDSA เดิม (ที่อยู่, ยอดเงิน, token, stake, สิทธิ์ในสัญญา) อยู่ที่เดิม แต่จากนี้ไปมีแต่บัญชี ML-DSA-44 ที่เป็นผู้ควบคุม (controller) ที่สั่งได้

```
# ล็อกกุญแจ ECDSA ของเครื่องนี้ (~/.zetaphy/worker.key) ให้บัญชี pq native ของเครื่องนี้ (หรือบัญชีที่ระบุ)
zetaphy pq native lock-ecdsa [zetaphy1<controller>] --yes      # ถาวร! ไม่มี --yes จะแสดงคำเตือนแล้วไม่ส่งอะไร

# ผู้ควบคุมทำรายการแทนบัญชีที่ล็อก: เติม --as <ที่อยู่บัญชีนั้น>
zetaphy pq native --as 0x<owner>                               # ยอดเงิน และล็อกให้ใคร (quantumLockedTo)
zetaphy pq native send 0x... 1.5 --as 0x<owner>                # โอน ZETAPHY ออกจากบัญชีนั้น
zetaphy pq native token-send 0x<token> 0x... 12.5 --as 0x<owner>
zetaphy pq native stake zetaphyvaloper1... 100 --as 0x<owner>  # ผ่าน staking precompile 0x…0800
zetaphy pq native rewards zetaphyvaloper1... --as 0x<owner>    # ผ่าน distribution precompile 0x…0801
zetaphy pq native call|deploy|unstake|token-balance ... --as 0x<owner>

# ยกการควบคุมต่อให้บัญชี ML-DSA-44 อีกบัญชี (ผู้ควบคุมปัจจุบันเป็นคนเซ็น)
zetaphy pq native handover 0x<owner> zetaphy1<controller ใหม่>
```

- ล็อกจาก MetaMask: ส่งธุรกรรม EVM ไปที่ `0x0000000000000000000000000000000000005051` value 0 และ data = ที่อยู่ 20 ไบต์ของผู้ควบคุม (ไม่มี selector)
  - กระเป๋าเว็บ (`zetaphy-wallet`) ทำให้ได้ผ่าน `window.ethereum`
  - ล้มเหลวถ้า data/value ผิด, ผู้ควบคุมไม่ใช่บัญชี ML-DSA-44 ที่เคยส่งธุรกรรมแล้ว, เป็นบัญชีตัวเอง หรือถูกล็อกอยู่
  - ล็อกบัญชี ML-DSA-44 ไม่ได้ (ต้านควอนตัมอยู่แล้ว)
- หลังล็อก เชนปฏิเสธทุกธุรกรรมที่กุญแจ ECDSA นั้นเซ็น (EVM, Cosmos, authorization ของ EIP-7702) ตั้งแต่ตอนส่ง (`eth_sendRawTransaction` ตอบ error ที่มีคำว่า quantum-locked) และ `ecrecover` คืน `address(0)` สำหรับลายเซ็นของกุญแจนั้น (permit, meta-transaction ใช้ไม่ได้)
- ผู้ควบคุมทำรายการแทนด้วย `MsgEVMCall` ที่มี `as_owner` = บัญชีที่ล็อก (`msg.sender` = บัญชีนั้น) ค่าธรรมเนียมจ่ายจากผู้ควบคุม
  - กับ `--as`, `--gas` คือ gas ฝั่ง EVM เสมอ; stake/unstake/rewards ค่าเริ่มต้น 300,000 (ราว 1.5 เท่าของ `eth_estimateGas` ที่วัดบน devnet: undelegate ~190k, delegate ~114–154k, rewards ~98k)
- ดูสถานะ: `zetaphy_pqAccount(ที่อยู่).quantumLockedTo` (ที่อยู่ `zetaphy1…` ของผู้ควบคุม หรือ null)
  - เชนเก็บสำเนาไว้ใน storage ของ `0x…5051` ด้วย: slot = ที่อยู่บัญชี (เติม 0 ข้างหน้าเป็น 32 ไบต์), ค่า = ผู้ควบคุม
- ถ้า seed ของผู้ควบคุมหาย บัญชีที่ล็อกก็หายด้วย

- ใช้ seed เดียวกับ `zetaphy pq` (`~/.zetaphy/pq.seed` หรือ `pq.seed.json`)
- ที่อยู่ = `sha256("zetaphy/mldsa44\0" + public key)[0:20]` (มีคำนำหน้าเพื่อไม่ให้ซ้ำกับที่อยู่แบบอื่นของ Cosmos SDK)
  - เขียนได้ทั้ง `zetaphy1…` และ `0x…` เพราะเป็น 20 ไบต์เดียวกัน
- บัญชีจะมีบนเชนหลังได้รับเงินครั้งแรกเท่านั้น
  - ถ้ายังไม่มี คำสั่งจะบอกให้โอน ZETAPHY เข้าที่อยู่นี้ก่อน
- `send` เป็น `MsgSend` ของ Cosmos SDK; ทุกคำสั่งเซ็นแบบ SIGN_MODE_DIRECT ด้วย ML-DSA-44 (pubkey `/zetaphy.crypto.mldsa44.PubKey`)
  - ส่งผ่าน JSON-RPC พอร์ต 8545 เดิม (`zetaphy_pqAccount`, `zetaphy_sendCosmosTx`)
- ค่าธรรมเนียม = gas limit × (`eth_gasPrice` × 1.2) หน่วย `azetaphy`
- โค้ดอยู่ที่ `src/pqtx.js` (ใช้ได้ทั้ง Node และเบราว์เซอร์)
  - ทดสอบโดยถอดรหัสด้วย protobuf ทางการของ Cosmos SDK (`cosmjs-types`) และตรวจลายเซ็นทุกครั้ง
- กระเป๋าบนเว็บสำหรับบัญชีแบบนี้อยู่ที่ `zetaphy-wallet/` (แยกจาก zetaphy-neuro ซึ่งสัญญาว่าไม่แตะกุญแจ)
- กุญแจใน MetaMask: `zetaphy-snap/` (MetaMask Snap) สร้างบัญชีจาก Secret Recovery Phrase และเซ็นธุรกรรมเอง
  - ทุกข้อความที่ `msg*` สร้างมี `intent` (ข้อความเดียวกันเป็น JSON ไม่มีผู้ส่ง) และ `messageFromIntent(intent, sender)` สร้างกลับได้ไบต์เดิม
  - ทุกคำสั่งของ `pqClient` รับ `signTx(request)` แทน `sign(bytes)` ได้ (`buildTxWith`): ผู้เซ็นภายนอกได้แค่ intent ไม่เคยได้ไบต์
    แล้ว `pqClient` สร้าง tx เองรอบลายเซ็นที่ได้ ถ้า `txHex` ที่ผู้เซ็นส่งกลับไม่ตรงจะไม่ส่ง
- ทดสอบบนเชนจริงแล้ว (`npm run test:devnet:pq`, รันใน CI ด้วย): ส่งได้ และเชนปฏิเสธธุรกรรมที่ใช้กุญแจอื่นสวมบัญชี ลายเซ็นที่ถูกแก้ และธุรกรรมเก่าที่ส่งซ้ำ
  - ชุดเดียวกันมีทดสอบ `token-send`, `call --value`, `stake`, `rewards`, `unstake` และการเรียกที่ revert ต้องไม่ขยับเงิน (ต้องใช้ `zetaphyd` ที่มี `MsgEVMCall`)
- เชนทดลองในเครื่อง (chain id ไม่ใช่ `zetaphy_77390-1`): ตั้ง `ZETAPHY_CHAIN_ID`
- validator เซ็นโหวตด้วย ML-DSA-44 เพิ่มจาก ed25519 และทุกบล็อกมีใบรับรอง ML-DSA ของบล็อกก่อนหน้า (ตรวจด้วย `zetaphy pq verify-block`)

### ตรวจบล็อกแบบต้านควอนตัม: `zetaphy pq verify-block`

validator ที่ลงทะเบียนกุญแจโหวต ML-DSA-44 แล้ว เซ็นทุกบล็อกด้วย ML-DSA-44 คู่กับ ed25519 และผู้เสนอบล็อก H+1 รวมลายเซ็นของบล็อก H ไว้เป็นธุรกรรมแรก (`MsgPQCertificate`)
คำสั่งนี้ตรวจใบรับรองนั้นเองด้วย `@noble/post-quantum` โดยใช้แค่ CometBFT RPC

```
zetaphy pq verify-block 12345                        # --rpc ค่าเริ่มต้น http://127.0.0.1:26657 (หรือ ZETAPHY_COMET_RPC) ไม่ใช่พอร์ต 8545
zetaphy pq export-vote-keys > pinned.json            # ทำบนโหนดที่เชื่อถือ (--height h ได้)
zetaphy pq verify-block 12345 --rpc http://<โหนดใดก็ได้>:26657 --keys pinned.json
zetaphy pq verify-block 12345 --json                 # ผลแบบ JSON; --chain-id ใช้กำหนด chain id เอง
```

- **สิ่งที่พิสูจน์:** validator ที่ถือ voting power มากพอเซ็น ML-DSA-44 รับรอง (chain id, ความสูง H, hash ของบล็อก H) ตามกติกาเดียวกับที่ทุกโหนดบังคับ
  - กติกา: 3 × power ที่เซ็นถูกต้อง > 2 × power ทั้งหมด − 3 × power ของ validator ที่ยังไม่มีกุญแจ (ถ้าฝั่งขวาติดลบ ไม่ต้องมีลายเซ็น)
  - นับ validator ละครั้งเดียว ข้ามที่อยู่ที่ไม่ใช่ validator และลายเซ็นที่ไม่ถูก
  - header และธุรกรรมของบล็อก H ที่โหนดส่งมาต้อง hash ได้ตรงกับ hash ที่เซ็น จึงเชื่อข้อมูลบล็อกได้ด้วย
  - ใบรับรองอยู่ในบล็อก H+1: บล็อกล่าสุดยังตรวจไม่ได้ ต้องรอบล็อกถัดไป
- **ผล:**
  - `VERIFIED post-quantum`: ผู้เซ็น ML-DSA ถือเกิน 2/3 ของ power ทั้งหมด
  - ผ่านกติกาแต่ต้านควอนตัมได้บางส่วน: มี validator ที่ยังไม่ลงทะเบียนกุญแจ
  - `NOT post-quantum`: validator ที่มีกุญแจถือไม่ถึง 1/3 เชนจึงยังไม่บังคับลายเซ็น (exit 0 เพราะผ่านกติกา)
  - `NOT VERIFIED`: ไม่ผ่าน พร้อมเหตุผล และ exit code 1
- **ความเชื่อถือ (trust model):**
  - ไม่ต้องเชื่อโหนดเรื่อง hash, header, ธุรกรรม และตัวใบรับรอง: ถ้าโหนดปลอม ลายเซ็นจะตรวจไม่ผ่าน
  - ที่ต้องเชื่อคือรายชื่อ validator, voting power และกุญแจโหวตของบล็อก H
    - ไม่ใส่ `--keys`: อ่านจากโหนดเดียวกัน (`/validators` และ `abci_query` ที่ `/store/zetaphypq/key`) โหนดที่โกหกสร้าง validator และกุญแจปลอมเองได้ จึงเหมาะกับโหนดของตัวเอง
    - ใส่ `--keys pinned.json`: ใช้ power และกุญแจจากไฟล์ที่ export ไว้จากโหนดที่เชื่อถือ ไม่ต้องเชื่อโหนดที่ถามเลย
  - pinned.json เป็นภาพ ณ ความสูงหนึ่ง ต้อง export ใหม่เมื่อ validator เข้า/ออก power เปลี่ยน หรือเปลี่ยนกุญแจ
    - ไฟล์เก่าทำให้ได้ "ไม่ผ่าน" ไม่ใช่ "ผ่านผิด ๆ" และคำสั่งเตือนเมื่อชุด validator ของโหนดต่างจากไฟล์
  - chain id ที่ตรวจ: `--chain-id` ถ้าไม่มีใช้ค่าในไฟล์ pin ถ้าไม่มีอีกใช้ค่าจาก header
  - ไม่ได้พิสูจน์ว่าธุรกรรมในบล็อกถูกกติกา: ต้องเชื่อว่า validator ส่วนใหญ่สุจริต เหมือน light client ทั่วไป
- บนเครื่องที่ติดตั้งด้วย `setup-node.sh` พอร์ต 26657 ฟังเฉพาะในเครื่อง: รันบนเครื่องนั้น หรือใช้ `ssh -L 26657:127.0.0.1:26657`
- ใช้ในโค้ด: `verifyBlock(rpc, height, { chainId, pinnedKeys })` และ `exportVoteKeys(rpc, { height })` ใน `src/pqcert.js` (เข้ารหัสด้วย `@noble` อย่างเดียว)
- ทดสอบ: `npm test` (RPC จำลอง และบล็อกจริงจาก devnet ที่บันทึกไว้) และ `npm run test:devnet:pqcert` (เชน 2 validator จริง)

## กระเป๋า Cosmos: Keplr, Leap, Cosmostation

บัญชีบน ZETAPHY เป็นแบบ eth_secp256k1 (เชนแบบ Evmos)
- กุญแจ: BIP39 → `m/44'/60'/0'/0/0` (coin type 60)
- ที่อยู่ `zetaphy1…` คือ 20 ไบต์เดียวกับ `0x…`
- pubkey: `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey`

ทดสอบบนเชนจริงแล้ว (`npm run test:devnet:cosmoswallet`, รันใน CI ด้วย)
- ชุดทดสอบทำทีละขั้นแบบที่ Keplr ทำ (อ่านจากซอร์ส `@keplr-wallet` 0.13.41) โดยไม่ใช้ไลบรารีกระเป๋า
- ผลแต่ละวิธีเซ็น:

| วิธีเซ็น | ผล |
|---|---|
| `SIGN_MODE_DIRECT` เซ็น secp256k1 บน keccak256 (วิธีปกติของกระเป๋า) | ใช้ได้ ทั้ง `MsgSend` และ `MsgDelegate` |
| `SIGN_MODE_LEGACY_AMINO_JSON` เซ็นบน keccak256 ของ JSON (Keplr `signAmino`) | ใช้ได้ |
| `LEGACY_AMINO_JSON` เซ็นเป็น EIP-712 (Keplr + Ledger) | ใช้ได้ (domain chainId 77390; domain chainId อื่นถูกปฏิเสธ) |
| เซ็นบน sha256 (แบบเชน Cosmos ทั่วไป) | เชนปฏิเสธ: code 4 `signature verification failed` |

- ส่งได้ทั้งผ่าน REST `POST /cosmos/tx/v1beta1/txs` และผ่าน CometBFT RPC `broadcast_tx_sync`
- อ่านบัญชีและยอดเงินผ่าน REST ได้ และ `eth_getBalance` ตรงกับยอดใน bank, nonce ตรงกับ sequence
- REST เปิดเฉพาะเมื่อสั่ง `REST=1 scripts/devnet.sh …` (บน testnet `setup-node.sh` เปิดไว้แล้ว)

แก้แล้วจากการทดสอบนี้:
- `keplr.json` ที่ `setup-node.sh` สร้างมี feature `"eth-secp256k1-cosmos"`
  - ถ้าไม่มี Keplr จะใส่ pubkey `/ethermint.crypto.v1.ethsecp256k1.PubKey` ซึ่งเชนถอดรหัสไม่ได้
- ธุรกรรมที่เชนถอดรหัสไม่ได้ได้คำตอบเป็น error ทันที (เดิมค้างไม่มีคำตอบ เพราะ cosmos/evm v0.7.3 คืน error ผิดแบบให้ CometBFT)
  - แพตช์ใน `mempool/mempool_handlers.go`
- Keplr + Ledger: chain id เปลี่ยนเป็น `zetaphy_77390-1` (แบบ Ethermint) และ `keplr.json` มี feature `force-enable-evm-ledger`
- genesis ตั้ง `sig_verify_cost_secp256k1 = 21000` ให้ simulate คิดค่าตรวจลายเซ็นเท่ากับของจริง

ยังเหลือ:
- Cosmos SDK v0.54 ให้เลขบัญชี (account number) เป็นค่า hash 64 บิต ซึ่งเกิน 2^53
  - Keplr รองรับ แต่ `@cosmjs/stargate` รุ่น 0.38 ลงไปจะ error ต้องใช้ 0.39 ขึ้นไป

## จุดอ่อนที่แก้แล้ว (ตรวจเอง 19 ต.ค. 2026)

| # | จุดอ่อนเดิม | แก้แล้วด้วย |
|---|---|---|
| 1 | คนเดียวสวมหลายที่อยู่ ยึดที่นั่งแบบมาก่อนได้ก่อน แล้วดูดกองรางวัล | **จับฉลากที่นั่งตามน้ำหนักเงินค้ำ**<br>• ใช้ seed จากคำขอ ซึ่งคนอื่นเปลี่ยนไม่ได้<br>• ต้องลงทะเบียนก่อนที่งานจะถูกส่ง<br>• รางวัลไม่เกิน 1/4 ของค่างาน และมีเพดานต่อวัน<br>• ส่งงานเองตอบเองจะขาดทุน ยกเว้นถือเงินค้ำเกิน 2/3 ของทั้งระบบ |
| 2 | สถานะ "คนรันร่างที่มีผลงาน" ปั๊มเองได้ | ผลงานต้องได้จากการถูกจับฉลาก (ข้อ 1) และสะพาน Neuro ต้องการผลงานอย่างน้อย 5 งาน (`--min-agreed`) |
| 3 | สะพานหลอกทำเครื่องหมาย `tx.origin` ทำให้ล่อคนบริสุทธิ์ให้โดนได้ | ทำเครื่องหมายเฉพาะผู้เรียกโดยตรง (`msg.sender`) มีชุดทดสอบด้วยสัญญาล่อเหยื่อ |
| 4 | กุญแจผู้ดูแลมีดอกเดียว | `SimpleMultisig` (k-of-n) + `--governance` ส่งสิทธิ์ผู้ดูแลต่อหลังติดตั้ง |
| 5 | JSON-RPC สาธารณะถูกยิงจนล่มได้ | ตั้งเพดานใน `setup-node.sh`: gas/เวลา eth_call, ขนาด log, batch, ขนาดคำขอ, จำนวนการเชื่อมต่อ และปิด unlock |
| 6 | patch ML-DSA ยังไม่มีใครตรวจ | fuzz test (ข้อมูลเสียทุกแบบต้องไม่ทำให้เชนล่ม) และ benchmark: ML-DSA-44 ใช้ 80 µs, ML-DSA-65 ใช้ 142 µs จึงตั้งค่า gas ไว้สูงกว่างานจริงราว 3–5 เท่า |
| 7 | กุญแจและ seed เป็นไฟล์ธรรมดา | ตั้ง `ZETAPHY_PASSPHRASE` แล้วจะเข้ารหัสอัตโนมัติ (keystore scrypt / AES-256-GCM) และใช้ `zetaphy keys encrypt` แปลงไฟล์เดิมได้ |

ยังเหลือที่ต้องใช้คนจริง: validator หลายราย (ประตู 1) และ audit (ประตู 2–3)

## ก่อนเงินจริง (ห้ามข้าม)

ทุกอย่างในโฟลเดอร์นี้ใช้กับ **testnet เท่านั้น** ก่อน mainnet หรือก่อนรับเงินจริงต้องผ่านเงื่อนไขเหล่านี้ (ตามแผน)

| ประตู | เงื่อนไข | ใครทำ |
|---|---|---|
| 1 | เชน testnet รัน 30 วันไม่ค้าง และมีคนรันร่างที่เป็นคนละคนจริงอย่างน้อย 10 คน | ชุมชน + เครื่อง Oracle |
| 2 | audit ตัวเชน (รวม patch ML-DSA) และสัญญาทุกตัวในโฟลเดอร์นี้ · มีผู้ใช้ Neuro ≥ 1,000 รายต่อเดือน | บริษัท audit (มีค่าใช้จ่าย) |
| 3 | audit สะพาน · ความเห็นด้านกฎหมาย · validator อิสระ ≥ 20 ราย · stake ต่อรายไม่เกิน 33% · วงเงินสะพานน้อยกว่า 1/3 ของ stake | บริษัท audit + ที่ปรึกษากฎหมาย + validator |

## ผู้ดูแล: ติดตั้งสัญญา

```
zetaphy deploy --fund 100000      # ใช้กุญแจของบัญชี rewards และเติมกองรางวัลให้ด้วย
zetaphy deploy-stable --reserve 1000   # tUSDC, tUSDT และ StableGateway (เงินสำรอง 1,000 ZETAPHY)
```

ค่าเริ่มต้น:

| ค่า | ค่าเริ่มต้น |
|---|---|
| เงินค้ำ | 100 ZETAPHY |
| รางวัลต่องาน | 1 ZETAPHY |
| ค่าบริการขั้นต่ำ | 0.1 ZETAPHY |
| เวลา commit | 120 วินาที |
| หมดเวลางาน | 600 วินาที |
| รอถอนเงินค้ำ | 3600 วินาที |

## ทดสอบ

- `npm test`: ทดสอบสัญญาบน EVM ในหน่วยความจำ และทดสอบโปรแกรมคนรันร่าง (CI รันให้ทุกครั้ง)
- `ZETAPHYD=<zetaphyd ที่มี patch ML-DSA> npm run test:devnet:pq`: ทดสอบขั้น 5 บนเชนจริง
- `ZETAPHYD=<zetaphyd ที่มีกุญแจโหวต ML-DSA> npm run test:devnet:pqcert`: เชน 2 validator ลงทะเบียนกุญแจโหวต แล้วตรวจบล็อกด้วย `zetaphy pq verify-block`
- `ZETAPHYD=<zetaphyd> npm run test:devnet:cosmoswallet`: กระเป๋า Cosmos (Keplr, Leap, Cosmostation) เซ็นและส่งธุรกรรมบนเชนจริง
- `npm run test:devnet:bridge`: สะพาน Neuro ข้ามเชนจริง 2 เชน (ต้นทาง และ ZETAPHY)
- `npm run test:devnet`: ทดสอบบนเชน ZETAPHY จริง ต้องมี `zetaphyd`
  - สคริปต์ตั้งเชน 1 โหนด (บล็อกละ 1 วินาที)
  - คนรันร่าง 3 คนรับงานจริงจนได้ผลตรวจ 2 ใน 3 และได้รับเงิน
  - ผู้ใช้ที่มี 0 ZETAPHY จ่ายค่างานเป็น tUSDC ผ่าน relay ได้
  - โหวตอัปเกรดผ่าน และเชนตั้งเวลาอัปเกรดไว้
  - `zetaphy gate` อ่านข้อมูลจากเชนได้

## ข้อจำกัดที่รู้แล้ว (testnet)

- เชน ZETAPHY ไม่มีค่าสุ่มบนเชน (`blockhash` คืนค่า 0) จึงจับฉลากด้วยข้อมูลจากคำขอ
  - คนที่ถือเงินค้ำส่วนใหญ่ของระบบจะได้ที่นั่งส่วนใหญ่ ซึ่งเป็นไปตามที่ออกแบบไว้
  - "ประตู 1" จึงนับคนรันร่างที่เป็น **คนละคนกันจริง** อย่างน้อย 10 ราย ไม่ได้นับจำนวนที่อยู่
- สัญญานี้ยังไม่ผ่าน audit ใช้กับ ZETAPHY testnet เท่านั้น
