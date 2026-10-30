[English](useful-work.md) | **ภาษาไทย**

# งานที่มีประโยชน์: งานสแกนในเบราว์เซอร์ ชื่อเสียงของผู้ทำงาน การล่าบั๊ก และการออกรางวัลที่หนุนด้วยความปลอดภัย

เฉพาะเทสต์เน็ตเท่านั้น ไม่มีส่วนใดถือหรือจ่ายเงินจริง สถานะของแต่ละข้ออยู่ท้ายหัวข้อ และหัวข้อ "สิ่งที่ยังขาด" บอกสิ่งที่ยังไม่ได้ทำ

| ข้อ | สิ่งที่มีแล้ว | สถานะ |
|---|---|---|
| 5 · Proof of useful work ในเบราว์เซอร์ | `UsefulWork.sol` + โหมด "งานที่มีประโยชน์" ในหน้า Mine ของฮับ (`work.js`, `work-worker.js`), `zetaphy deploy-useful-work`, feeder (`zetaphy work feed`, `.github/workflows/useful-work.yml`) | **พร้อม deploy**: มีทาง deploy (หยุดไว้ก่อน เป็นของ timelock), feeder ตามตารางเวลา และสถานะในฮับ ยัง-ไม่-deploy / deploy-แต่-หยุด / เปิด ทดสอบครบ **ยังไม่ได้ deploy**: เจ้าของต้องรัน workflow หนึ่งครั้ง (ด้านล่าง) |
| 10 · ชื่อเสียงบนเชน | `WorkerReputation.sol` (ชื่อเสียงแบบ ERC-8004 ผูกกับเอเจนต์ใน `NeuroIdentity` และอ่านประวัติรันเนอร์ของ NeuroJobs) | เสร็จสำหรับตลาดใหม่ NeuroJobs ไม่ได้เขียนเข้า (ถูกอ่านแทน) |
| 17 · ล่าบั๊กในเบราว์เซอร์ | `BugBounty.sol`, `VulnerableVault.sol` (ตั้งใจให้มีช่องโหว่), `fuzz-core.js` + `fuzz-hook.js`, `vendor/evm.js`, `zetaphy work fuzz`, `zetaphy bounty check` | **fuzzer แบบนำทางด้วย coverage และมีสถานะ** มี invariant 7 แบบ reentrancy ผ่านสัญญาของผู้โจมตี การย่อ seed corpus และไฟล์ทำซ้ำ พบบั๊กทุกตัวใน VulnerableVault และในสัญญาทดสอบที่ตั้งใจให้มีช่องโหว่อีก 5 ตัว ไม่พบอะไรในสัญญาปลอดภัย 3 ตัว (มีเทสต์) |
| 34 · การออกรางวัลที่หนุนด้วยความปลอดภัย | `UsefulIssuance.sol` (ผู้รับจาก RewardVault, แบ่งเป็นถังมีเพดาน, ดึงได้อย่างเดียว, อยู่หลัง timelock) | เสร็จในระดับโมดูลสัญญาบนเทสต์เน็ตพร้อมเทสต์ เศรษฐศาสตร์อยู่ด้านล่าง ยังไม่ deploy และยังไม่อยู่ใน `zetaphy-launch` |

## ชิ้นส่วนต่อกันอย่างไร

```
RewardVault (กองรางวัล 500 ล้าน ปล่อยปีละ 10% ของที่เหลือ เปลี่ยนส่วนแบ่งได้หลังรอ 7 วัน)
   │ ส่วนแบ่งหนึ่ง (governance เลือก เช่น 10%) ผ่าน fund()
   ▼
UsefulIssuance ── ถัง (bps, เพดาน) ──► UsefulWork  (งานสแกน)         ──┐ draw() ได้เมื่องาน
   │                               ──► BugBounty   (สิ่งที่พบเป็นบั๊ก) ──┤ ผ่านการตรวจแล้วเท่านั้น
   │                               ──► (อนาคต: ประเมินโมเดล)         ──┘
   └── ส่วนเกิน (ส่วนที่ไม่มีถังรับ หรือเกินเพดาน) ──► เช่น บัญชีก๊อกน้ำ PoW / validator

เบราว์เซอร์ (ฮับ หน้า Mine → "งานที่มีประโยชน์")
   ตราประทับ (PoW) → สแกน (Neuro src ใน Web Worker) → commitMany → revealMany → settle → withdraw
   ล่า (EVM ใน Web Worker) → commitFinding → revealFinding → รันเนอร์รับรอง → claim

WorkerReputation ◄── ผลลัพธ์จาก UsefulWork และ BugBounty (+ อ่าน agreed/rejected ของ NeuroJobs)
```

สัญญาทั้งหมดอยู่ใน `zetaphy-network/contracts/` คอมไพล์เป็น `artifacts/` (`npm run build`) ทดสอบใน
`zetaphy-network/test/usefulwork.test.js` (16 เทสต์) และ `zetaphy-hub/test/work.test.mjs` + `work.e2e.mjs`

## ข้อ 5 · Proof of useful work ในเบราว์เซอร์ (`UsefulWork`)

**งาน** งานสแกนระบุเชน (`zetaphy` หรือเชน EVM ของ Neuro) ที่อยู่สัญญา และ `codeHash` (keccak256 ของโค้ดรันไทม์) ที่ผู้โพสต์เห็น
ผู้ทำงานอ่านโค้ด ตรวจแฮช แล้วรัน **ตัวอ่านของ Neuro เอง** (`zetaphy-neuro/src/reader.js` โค้ดเดียวกับที่รันเนอร์ใช้) ผ่าน RPC
ที่รู้จักแค่ไบต์โค้ดนั้น (`work-core.js` `codeOnlyRpc`: อ่าน storage ได้ค่าว่าง ทุก `eth_call` revert ปิด sourcify และการจำลองซื้อขาย)
ผลตัดสินคือแฮชจาก `zetaphy-neuro/src/verdict.js` ของสิ่งที่กฎตัดสิน ขึ้นกับโค้ดอย่างเดียว ผู้ทำงานที่ซื่อสัตย์ทุกคนจึงได้ 32 ไบต์เดียวกัน
(ทดสอบแล้ว: ผลในเบราว์เซอร์ = ผลใน Node) **ผลตัดสินแบบโค้ดอย่างเดียวนี้ไม่ใช่ผลตัดสินของ NeuroJobs** ซึ่งอ่านเจ้าของและสถานะโทเค็นด้วย

**ขั้นตอน** (ทุกขั้นอยู่บนเชน ยกเว้นการสแกน):

1. **ตราประทับ** (ต้นทุนกัน Sybil): `sha256(chainId u64 ‖ seed ‖ worker ‖ nonce u64)` ต้องขึ้นต้นด้วยบิตศูนย์ `stampBits` บิต
   รูปแบบเดียวกับก๊อกน้ำ PoW หน้าเว็บจึงใช้ `mine-core.js`/`mine-worker.js` ซ้ำ seed คือ `keccak(blockhash(h), UsefulWork)`
   (`stampSeed(h)` โดย h อยู่ใน 256 บล็อกล่าสุด) หลักฐานของก๊อกน้ำจึงใช้เป็นตราประทับไม่ได้ และคำนวณล่วงหน้าไม่ได้
   ตราประทับหนึ่งอันได้ `stampSeats` ที่นั่ง ใช้ได้ `stampLife` วินาที แต่ละที่อยู่รับได้ไม่เกิน `seatsPerDay` ที่นั่งต่อวัน (UTC)
2. **ที่นั่งและความซ้ำซ้อน**: แต่ละงานมี `seats` ที่นั่ง (2–5 ค่าเริ่มต้น 3) และจ่ายเฉพาะคำตอบที่ `quorum` ที่นั่ง (เกินครึ่ง) เปิดเผยตรงกัน
   แต่ละที่นั่งวางมัดจำ `seatDeposit`
3. **Commit-reveal**: ค่าผูกมัดคือ `keccak(abi.encode(verdict, worker, salt, jobId))` ผูกกับผู้ทำงานและงาน ใครก็ลอกหรือนำคำตอบที่ปิดผนึกของคนอื่นไปใช้ซ้ำไม่ได้
   การเปิดเผยเริ่มเมื่อที่นั่งเต็ม (หรือหมดเวลา commit) `commitMany` / `revealMany` รวมหลายงานในธุรกรรมเดียว (ยืนยันในวอลเล็ตครั้งเดียว)
4. **Settle** (ใครก็เรียกได้): ที่นั่งที่ตรงกันได้มัดจำคืนพร้อมส่วนแบ่งเท่ากันของค่าธรรมเนียมผู้โพสต์ (บวก `subsidy` ต่อที่นั่งถ้าเป็นงาน feeder ที่มีเงินอุดหนุน)
   คำตอบผิดและไม่เปิดเผยเสียมัดจำเข้ากองสำรองเงินอุดหนุน ถ้าไม่มีเสียงข้างมาก: ผู้โพสต์ได้ค่าธรรมเนียมคืน ผู้เปิดเผยได้มัดจำคืน ไม่มีใครถูกตัดสิน
5. **งานนกขมิ้น (canary)**: feeder (ที่อยู่ที่ governance กำหนด เช่น GitHub Action ที่โพสต์สัญญาใหม่จากรายการเฝ้าดูของ Neuro)
   โพสต์งานพร้อมค่าผูกมัดที่ซ่อนคำตอบที่รู้อยู่แล้วได้ หลังปิด commit จะเปิดเผยคำตอบ ที่นั่งที่ไม่ตรงจะถูก **slash** แม้จะตรงกันเอง
   (จับคนสมรู้ที่ขี้เกียจตอบค่าคงที่)
6. **รางวัล** เป็น ZETAPHY เทสต์เน็ต: ค่าธรรมเนียมผู้โพสต์ มัดจำที่ถูกริบ และถังของ UsefulIssuance (ข้อ 34) ไม่มีการ mint ใหม่
   แต้ม BZTPHY: ยังไม่ได้เชื่อม (ดู "สิ่งที่ยังขาด")

"ผลลัพธ์ที่ลงนาม": ทุกผลลัพธ์เป็นธุรกรรมที่ลงนามด้วยกุญแจวอลเล็ตของผู้ทำงานเอง ผลตัดสินที่ยอมรับเก็บบนเชน (`getJob(id).result`) และทุกการเปิดเผยเป็น event

**วิธีใช้** ฮับ → Mine → **🧠 งานที่มีประโยชน์** (`?tab=mine` แล้วกดสลับโหมด) ระหว่างที่สัญญายังไม่อยู่ใน `hub-config.json`
หน้าเว็บจะรัน **สแกนฝึกหัด** (โค้ดของ vault จาก `bounties/sample-scan.json`) และ **ล่าฝึกหัด**: ไม่ส่งอะไรและไม่จ่ายอะไร
เมื่อตั้งค่าสัญญาแล้ว (`usefulWork`, `bugBounty`, `workerReputation` จาก launch state) ปุ่ม **รับงานสแกน** จะทำตราประทับ สแกนงานที่เปิดสูงสุด 3 งาน
commit พร้อมมัดจำ รอที่นั่งอื่น เปิดเผย settle และแสดงรายได้ (**ถอนรายได้**) salt ถูกบันทึกใน `localStorage` ก่อน commit
(ถ้าไม่มี salt จะเสียมัดจำ) ถ้าแท็บปิดไป กดปุ่มอีกครั้งจะทำการเปิดเผยต่อ รันเนอร์เทียบผลด้วย `zetaphy work verdict <chain> <address>`

**พารามิเตอร์** (`setParams` โดย governance ควร deploy โดยให้ ZetaphyTimelock เป็น governance): `stampBits` (8–48), `stampSeats`,
`stampLife`, `seatsPerDay`, `seats`, `quorum`, `commitWindow`, `revealWindow`, `seatDeposit`, `subsidy`, `priorityScore`, `priorityWindow`
ความเร็ว PoW ที่วัดได้ (README ของฮับ): ประมาณ 2.4 MH/s ต่อเธรดเบราว์เซอร์ ดังนั้น 20 บิต ≈ 0.4 วินาที 24 บิต ≈ 7 วินาที 28 บิต ≈ 2 นาทีด้วยเธรดเดียว

### นำขึ้นเทสต์เน็ต

ทุกอย่างด้านล่างสร้างและทดสอบแล้ว (`test/usefulwork-deploy.test.js`: ธุรกรรมที่เซ็นจริงบนเชนในหน่วยความจำที่ chain id 77390 และ CLI
ผ่านโหนด JSON-RPC) **ยังไม่มีอะไรถูก deploy**: เป็นการรันด้วยมือหนึ่งครั้งโดยเจ้าของ

1. **Deploy แบบหยุดไว้ก่อน เป็นของ timelock** `zetaphy deploy-useful-work [--feeder 0x…]` (หรือ Actions → **Useful work** → Run workflow
   โหมด `deploy`: environment `testnet-deploy` เจ้าของกดอนุมัติ ใช้ secret `ZETAPHY_DEPLOYER_KEY` ที่อยู่ของ feeder มาจาก *variable* ของ repo ชื่อ
   `USEFUL_WORK_FEEDER`) อ่าน ZetaphyTimelock, NeuroJobs, NeuroIdentity, multisig ผู้พิทักษ์ และ RewardVault (overflow ของ issuance) จาก
   `zetaphy-launch/state/77390.json` ปฏิเสธ timelock ที่หน่วงน้อยกว่า 2 วัน และเชนอื่นนอกจาก 77390 แล้ว deploy WorkerReputation,
   UsefulIssuance, UsefulWork และ BugBounty เชื่อมกัน (reporter, feeder, ผู้พิทักษ์) **หยุด** UsefulWork และ BugBounty และโอนสิทธิ์ผู้ดูแลทุกอย่าง
   ให้ timelock (ตรวจก่อนจบ) ผู้ deploy ไม่เหลือสิทธิ์ใด เขียน `zetaphy-network/deployments/useful-work-77390.json` และ workflow เปิด pull request ให้
2. **หยุด** หมายถึง: ไม่รับตราประทับ ไม่รับงานหรือที่นั่งใหม่ ไม่รับเงินรางวัลหรือสิ่งที่พบใหม่ แต่การเปิดเผย นกขมิ้น settle การโหวต การเคลม
   การคืนเงิน และการถอนยังทำได้ มัดจำจึงไม่ค้าง **ผู้พิทักษ์** (multisig) หยุดได้ทันที แต่เปิดได้เฉพาะ governance (timelock)
3. **เปิด** ไฟล์ deploy มีรายการการดำเนินการของ timelock (`proposals`): `UsefulIssuance.setBuckets` (งานสแกน 60% เงินรางวัลบั๊ก 40% เพดาน
   500 ZETAPHY ทดสอบ), `UsefulWork.setPaused(false)`, `BugBounty.setPaused(false)` แต่ละรายการมี operation id และ calldata ของ `schedule` /
   `execute` ผู้เสนอ schedule ใครก็ execute ได้หลังครบเวลาหน่วง
4. **feeder** (`zetaphy work feed`, Actions → **Useful work** ทุก 3 ชั่วโมง): เปิดเผยนกขมิ้นที่ปิดรับ commit แล้ว settle งานที่เสร็จ และโพสต์งาน
   สแกนใหม่ (สัญญาที่สร้างใน 300 บล็อกล่าสุดของ ZETAPHY สัญญาใน launch state และไฟล์ `--targets` ถ้ามี) ทุกงานที่ 3 เป็นนกขมิ้น ไม่เก็บสถานะ:
   salt ของนกขมิ้นคือ `keccak(คีย์, UsefulWork, jobId)` คำนวณใหม่ตอนเปิดเผย ข้ามสัญญาที่เพิ่งโพสต์ด้วยโค้ดเดียวกัน ใช้ environment
   `testnet-automation` และ secret **`USEFUL_WORK_FEEDER_KEY`** (คีย์เทสต์เน็ตเฉพาะ มี ZETAPHY ทดสอบเล็กน้อย governance ตั้งให้เป็น feeder ผ่าน
   `--feeder` ตอน deploy หรือ `setFeeder` ผ่าน timelock) ถ้าไม่มี secret จะเป็น dry run ถ้ายังไม่มีไฟล์ deploy จะไม่ทำอะไร
5. **ฮับ** อ่านที่อยู่จาก `hub-config.json` ซึ่ง `build.mjs` เติมจากไฟล์ deploy ด้วย (เฉพาะ chain id ของเทสต์เน็ต) มีสามสถานะ ทดสอบใน Chromium
   ทุกสถานะ: *ยังไม่ deploy* (ฝึกหัด และบอกไว้) *deploy แล้วแต่หยุด* ("เปิดหลังการโหวตผ่าน timelock" ฝึกหัด ไม่ส่งอะไร) *เปิด* (งานมีค่าตอบแทน)

สิ่งที่เจ้าของต้องทำ (การเปลี่ยนแปลงนี้ไม่ได้เพิ่ม secret ใด): ตั้ง variable `USEFUL_WORK_FEEDER` (ที่อยู่ของ feeder) และ secret
`USEFUL_WORK_FEEDER_KEY` ใน `testnet-automation` (ดู docs/SECRETS-HARDENING.md) รันโหมด `deploy` หนึ่งครั้ง merge pull request นั้น และให้
timelock ดำเนินการ proposal ที่เปิดตลาด

**สถานะ: พร้อม deploy** (ทาง deploy, feeder และสถานะในฮับ มีเทสต์) ยังไม่ได้ deploy

## ข้อ 10 · ชื่อเสียงบนเชน (`WorkerReputation`)

- บันทึกต่อผู้ทำงาน: `agreed`, `disagreed`, `missed`, `slashed`, `bugValid`, `bugInvalid`, `lastAt` เขียนได้เฉพาะ **reporter**
  ที่ governance กำหนด (สัญญา UsefulWork และ BugBounty) และทุกผลลัพธ์มาจากรอบ commit-reveal ที่ settle บนเชนแล้ว governance `slash` ด้วยมือได้
- `scoreOf(worker)` (0–1000) = `1000·good / (good + bad + 5)` โดย good = agreed + 3·bugValid + `agreed` ของ NeuroJobs,
  bad = disagreed + 2·missed + 5·slashed + 3·bugInvalid + `rejected` ของ NeuroJobs ค่า prior 5 ทำให้ที่อยู่ใหม่เริ่มที่ 0
  รันเนอร์ NeuroJobs จึงพกประวัติมาได้โดยไม่ต้องแก้ NeuroJobs
- **งานสำคัญไปก่อน**: `minScore` ของงานเป็นพื้นขั้นต่ำ และช่วง `priorityWindow` หลังโพสต์ รับที่นั่งได้เฉพาะผู้ที่มีคะแนน `priorityScore` ขึ้นไป
- **ERC-8004**: ผู้ทำงานที่เป็นเจ้าของเอเจนต์ใน `NeuroIdentity` เรียก `linkAgent(agentId)` ได้ แล้ว `getSummary(agentId)` จะตอบ
  `(count, averageScore 0–100)` ในรูปแบบชื่อเสียงของ ERC-8004 ลิงก์ตามเจ้าของเอเจนต์ไป
- ข้อจำกัดตามจริง: คะแนนวัด **ความตรงกันกับผู้ทำงานอื่นและนกขมิ้น ไม่ใช่ความจริง** เสียงข้างมากที่สมรู้กันยกคะแนนตัวเองได้ (ดูเศรษฐศาสตร์)

**สถานะ: เสร็จ** สำหรับ UsefulWork และ BugBounty (มีเทสต์) NeuroJobs ถูกอ่านอย่างเดียว

## ข้อ 17 · ล่าบั๊กในเบราว์เซอร์ (`BugBounty`)

- ผู้สนับสนุนโพสต์เงินรางวัล: `specHash` (keccak256 ของไฟล์ spec ที่ฮับให้บริการ เช่น `zetaphy-hub/bounties/vulnerable-vault.json`) และรางวัล
  spec มีโค้ดสร้างสัญญา ฟังก์ชันที่เรียกได้ การตั้งค่า (เหยื่อฝาก 5 ZETAPHY) และ invariant (`attacker-profit`: ผู้โจมตีต้องไม่จบด้วยเงินมากกว่าตอนเริ่ม
  ≥ `minProfit` ในการเล่นซ้ำค่าแก๊สเป็นศูนย์ จึงแม่นยำ)
- เบราว์เซอร์ทำ fuzzing ใน **EthereumJS EVM** (EVM เดียวกับที่เทสต์สัญญาใช้) ซึ่งรวมเป็น `zetaphy-hub/vendor/evm.js` ด้วย `npm run build:evm`
  (437 KB, gzip 132 KB ไม่มี eval ไม่มี WebAssembly: precompile bn254 ถูกแทนด้วย stub) โหลดเฉพาะตอนเริ่มล่า `fuzz-core.js` เป็น **fuzzer ที่นำทาง
  ด้วย coverage และมีสถานะ** (ไฟล์เดียวกันรันใน Web Worker ของเบราว์เซอร์ ในการเล่นซ้ำของรันเนอร์ และใน `zetaphy work fuzz`):
  - **coverage**: บันทึกทุก edge ของ JUMP/JUMPI ที่รันในสัญญาเป้าหมายจาก event `step` ของ EVM ลำดับการเรียกที่ไปถึง edge ใหม่จะเข้า corpus และ
    ลำดับใหม่ 3 ใน 4 เป็นการกลายพันธุ์ของสมาชิก corpus (เปลี่ยนอาร์กิวเมนต์หรือ value แทรก / ลบ / สลับ / ซ้ำขั้น ต่อสองลำดับ ส่งขั้นผ่านสัญญาของ
    ผู้โจมตี ตั้งการเรียกซ้ำ) หน้าเว็บแสดงสัดส่วนจุดกระโดดของสัญญาที่ไปถึงแล้ว
  - **ลำดับที่มีสถานะ** 1–8 การเรียกโดยผู้โจมตี โดยตรงหรือผ่าน **FuzzHook** (`fuzz-hook.js` จาก `zetaphy-network/test/fixtures/fuzz/FuzzHook.sol`)
    สัญญาของผู้โจมตีเอง ที่เรียกเป้าหมายพร้อม value และเมื่อถูกตั้งไว้จะ **เรียกเป้าหมายซ้ำ (re-enter)** จาก `receive`/`fallback` ได้ถึง N ครั้ง ขั้นที่ทำให้
    เป้าหมายเรียกกลับมาที่ hook จะถูกเก็บไว้และถูกตั้งการเรียกซ้ำบ่อยขึ้น
  - **อาร์กิวเมนต์** จากพจนานุกรม: ผู้เล่น hook เป้าหมาย ค่าขอบ ยอดเงินของเป้าหมาย ตัวเลขที่การตั้งค่าใน spec ใช้ และค่าคงที่ที่ bytecode ของเป้าหมาย
    PUSH เอง อาร์กิวเมนต์ `bytes` ได้ selector ของ spec และของ hook
  - **invariant** (spec เวอร์ชัน 2 สิ่งที่พบถูกต้องเมื่อการเล่นซ้ำละเมิดอย่างน้อยหนึ่งข้อ): `attacker-profit` (ผู้โจมตี + hook จบด้วยเงินมากขึ้น ≥ `minProfit`),
    `victim-can-exit` (หลังการโจมตี เหยื่อรัน `exit` แล้วได้คืน `exitMin`), `balance-conservation` (เป้าหมายถือเงินอย่างน้อยเท่าผลรวม
    `solvency(actor)` ของผู้เล่น), `privileged-unchanged` (view ใน `watch` เช่น `owner()` ตอบเหมือนเดิม), `no-selfdestruct`,
    `no-delegatecall-to-attacker` (DELEGATECALL / CALLCODE ไปยังผู้โจมตีหรือ hook), `token-drain` (ผู้โจมตีได้โทเคนในรายการ ≥ `minTokenProfit`
    หรือเหยื่อเสียโทเคน) การละเมิดที่เป้าหมายถูกเรียกซ้ำขณะยังทำงานจะติดป้าย `reentrancy` ด้วย
  - **การย่อ**: ย่อการละเมิดให้เหลือขั้นน้อยสุด เรียกซ้ำน้อยสุด value เล็กสุด และเรียกตรง โดยยังละเมิด invariant เดิม
  - **ทำซ้ำได้**: ตัวสุ่มเดียวที่มี seed (xorshift32) และสภาพบล็อกคงที่ seed, spec และตัวเลือกเดียวกันให้ผลเหมือนกันทุกไบต์ (มีเทสต์) corpus ที่ย่อแล้ว
    (set cover แบบละโมบของ edge) บันทึกและใช้ต่อได้ (`--save-corpus`, `--corpus`)
  - **ส่งออกไฟล์ทำซ้ำ**: บันทึกสิ่งที่พบแต่ละรายการได้ (หน้าเว็บ: **บันทึกไฟล์ทำซ้ำ** CLI: `--out`) เป็น JSON `zetaphy-fuzz-repro/1`: แฮชของ spec, seed,
    สภาพแวดล้อม, การละเมิด, trace รายขั้น (สำเร็จไหม / ยอดของผู้โจมตีและเป้าหมาย) และสิ่งที่พบตรงตามที่จะเปิดเผย `zetaphy work verify-finding <spec>
    <reproducer.json>` เล่นซ้ำได้
  การล่าทำต่อหลังพบครั้งแรก (หนึ่งรายการต่อ invariant) หน้าเว็บส่งรายการที่ร้ายแรงสุด (ผู้โจมตีได้เงินก่อน) spec เวอร์ชัน 1 (มีแค่ `attacker-profit`)
  ยังเล่นซ้ำได้เหมือนเดิม
- **มีเทสต์** (`zetaphy-network/test/fuzz.test.js`): บั๊กทุกตัวใน **VulnerableVault** (ยึดความเป็นเจ้าของด้วย `initialize()` ขโมยด้วย
  `initialize(); sweep(attacker)` เหยื่อถอนไม่ได้ สัญญาติดหนี้) และในสัญญาทดสอบที่ตั้งใจให้มีช่องโหว่อีกห้าตัว (`test/fixtures/fuzz/Vulnerable.sol`):
  **ReentrantBank** (ดูดเงินด้วย reentrancy ผ่าน hook), **OpenDelegate** (delegatecall ไปยังโค้ดผู้โจมตี), **KillSwitch** (ใครก็ selfdestruct ได้),
  **LeakyToken** (transferFrom ไม่ตรวจ allowance: ดูดโทเคน), **OwnerTakeover** (`transferOwnership` ไม่มีการป้องกัน) ทุกรายการเล่นซ้ำแล้วถูกต้องและ
  ไม่เกิน 3 ขั้น **ไม่มี false positive** กับเวอร์ชันที่แก้แล้ว (`Safe.sol`: SafeBank, SafeVault, SafeToken) และ: seed เดียวกันได้ผลเดียวกัน
  การย่อ corpus คง coverage และใช้ต่อได้ ไฟล์ทำซ้ำเล่นซ้ำผ่าน CLI ได้ สิ่งที่พบผิดรูปถูกปฏิเสธ ฝั่งเบราว์เซอร์: `zetaphy-hub/test/work.e2e.mjs`
  ล่าใน Chromium และดาวน์โหลดไฟล์ทำซ้ำ
- **Commit-reveal**: `commitFinding(bountyId, keccak(findingHash, finder, salt, bountyId))` พร้อมมัดจำ แล้ว `revealFinding` ในบล็อกถัดไป
  ภายใน `revealWindow` ใส่สิ่งที่พบ (ลำดับการเรียกแบบ JSON) ใน calldata และ event รันเนอร์จึงไม่ต้องมีเซิร์ฟเวอร์ สิ่งที่พบเรียงตามลำดับ commit
  **สิ่งที่พบที่ถูกต้องและมาก่อนสุดชนะ** (ที่ซ้ำภายหลังได้แค่มัดจำคืน) การดูการเปิดเผยของคนอื่นจึงไม่ช่วยคนลอก
- **ตรวจโดยรันเนอร์**: รันเนอร์ NeuroJobs ที่มีประวัติ (active, `agreed ≥ minAgreed`, `rejected ≤ agreed` เกณฑ์เดียวกับ ThreatRegistry)
  เล่นซ้ำ (`zetaphy bounty check <id> --bounty 0x… --spec file --attest` หรือแบบออฟไลน์ `zetaphy work verify-finding spec.json finding.json`)
  แล้ว `attest` เสียงตรงกันครบ `quorum` จะยอมรับหรือปฏิเสธ ยอมรับ: `claim` จ่ายรางวัล + เงินอุดหนุนของรางวัลนั้น (UsefulIssuance) + มัดจำ
  ปฏิเสธ: มัดจำเพิ่มเข้ารางวัล ผลลัพธ์ส่งไป WorkerReputation
- **สัญญาที่ตั้งใจให้มีช่องโหว่** `VulnerableVault.sol` (สำหรับทดสอบเท่านั้น): `initialize()` ไม่มีการควบคุมสิทธิ์ และการ deploy ไม่เคยเรียกมัน
  ใครก็เป็นเจ้าของได้แล้ว `sweep` เงินฝากทั้งหมด spec ของมัน (`bounties/vulnerable-vault.json` เวอร์ชัน 2) ตรวจหก invariant fuzzer พบการยึด
  ความเป็นเจ้าของทันที และ `initialize(); sweep(attacker)` ภายในไม่กี่สิบลำดับ
- **ใช้วิจัย**: `zetaphy work fuzz <spec.json> [--seed n --runs n --all --out repro.json --save-corpus c.json]`

**สถานะ: fuzzer จริง มีเทสต์** (นำทางด้วย coverage ลำดับที่มีสถานะพร้อม reentrancy, 7 invariant, การย่อ, seed, corpus, ไฟล์ทำซ้ำ ครบวงจร: เบราว์เซอร์พบ
commit เปิดเผยในบล็อกถัดไป รันเนอร์เล่นซ้ำแล้วยอมรับ สิ่งที่พบก่อนสุดได้รับเงิน) ข้อจำกัดอยู่ใน "สิ่งที่ยังขาด"

## ข้อ 34 · การออกรางวัลที่หนุนด้วยความปลอดภัย (`UsefulIssuance`)

- **ไม่มีการ mint** เป็นผู้รับของ `RewardVault` (`fund()`) ส่วนแบ่งของรางวัลใหม่ที่ได้คือส่วนแบ่งใน RewardVault ซึ่ง governance เปลี่ยนได้ผ่าน
  `proposeShares` + การรอ 7 วันของ vault เท่านั้น
- เงินที่เข้ามาแบ่งเป็น **ถัง** (`sink`, `bps`, `cap`): UsefulWork, BugBounty และอื่น ๆ ภายหลัง ส่วนที่เหลือ `10,000 − Σbps` และส่วนที่เกินเพดานถัง
  ไปที่ **overflow** (เช่น บัญชีก๊อกน้ำ PoW หรือ validator) เงินจึงไม่ถูกกักไว้เมื่อมีงานที่มีประโยชน์น้อย
- **ดึงได้อย่างเดียว**: sink `draw` ได้เฉพาะถังของตัวเอง และ sink ดึงเฉพาะเมื่อกฎของตัวเองตรวจงานแล้ว (การตรงกันที่ settle แล้ว สิ่งที่พบที่ยอมรับแล้ว)
  งานที่ไม่ผ่านการตรวจไม่เคยได้รับเงิน
- **governance ต้องเป็น timelock** ที่ `getMinDelay()` อย่างน้อย 2 วัน (ตรวจตอน deploy และตอน `setGovernance`) `setBuckets`, `setOverflow`
  ต้องรอทั้งหมด ไม่มี withdraw ไม่มี mint (มีเทสต์)

### เศรษฐศาสตร์ตามจริง

- **ตัวมันเองไม่ได้เพิ่มความปลอดภัย** ฉันทามติของ ZETAPHY เป็น proof of stake ทั้ง PoW ของก๊อกน้ำและงานเหล่านี้ไม่ได้ปกป้องบล็อก
  "หนุนด้วยความปลอดภัย" ในที่นี้หมายถึง: ส่วนหนึ่งของกองรางวัลที่มีอยู่จ่ายให้งานที่ช่วยความปลอดภัยของผู้ใช้ (สแกนสัญญา พบบั๊ก) แทนการแฮชเปล่า
  เป็นการแบ่งกองที่คงที่ใหม่ ทุก bps ที่ให้ที่นี่ถูกเอามาจาก validator หรือรันเนอร์ NeuroJobs
- **งานสแกนใช้การคำนวณน้อย** การสแกนแบบโค้ดอย่างเดียวใช้เวลาเป็นมิลลิวินาที คุณค่าคือความครอบคลุม (สัญญาจำนวนมาก ตรวจแยกกัน) ไม่ใช่งานหนัก
  ความซ้ำซ้อน ×3 ตั้งใจเพิ่มต้นทุนสามเท่า
- **ตราประทับคือการจำกัดอัตรา ไม่ใช่ตัวตน** 2^20–2^24 แฮชใช้เวลาเบราว์เซอร์ไม่กี่วินาที คนเดียวที่มีหลายเบราว์เซอร์ยังรับได้หลายที่นั่ง
- **การสมรู้คือจุดอ่อนหลัก** ที่นั่งได้ก่อนได้ก่อน คนเดียวที่มีสามที่อยู่รับครบสามที่นั่งของงาน สแกนครั้งเดียว แล้วได้เงินสามครั้ง
  commit-reveal กันการลอกระหว่างคนแปลกหน้า ไม่ได้กันการประสานกัน นกขมิ้นจับคำตอบขี้เกียจ (ค่าคงที่) ได้ แต่ไม่จับ "คำนวณครั้งเดียว ลอกสามครั้ง"
  (ยังได้คำตอบที่ถูก แต่ความซ้ำซ้อนเป็นของปลอม) ตัวจำกัด: เงินอุดหนุนเฉพาะงาน feeder, `minScore`/ช่วงลำดับความสำคัญสำหรับงานสำคัญ,
  เพดานต่อที่อยู่ต่อวัน, เพดานถัง, มัดจำ ทางแก้ (ยังไม่ได้สร้าง) คือการจับฉลากด้วย blockhash แบบ NeuroJobs ในหมู่ผู้ที่มีตราประทับ
- **เงินอุดหนุนเทียบต้นทุน** ถ้าจะฟาร์มเงินอุดหนุนให้มีกำไร `subsidy × seats` ต้องมากกว่าค่าแก๊ส + มัดจำที่คาดว่าจะเสีย + ต้นทุนตราประทับ
  ควรตั้ง `subsidy` ต่ำและเพดานถังต่ำจนกว่าจะมีการจับฉลาก
- **เงินรางวัลบั๊ก** จำกัดด้วยรางวัลของผู้สนับสนุนบวกเงินอุดหนุนที่ governance ตั้ง quorum รันเนอร์ที่สมรู้กันอาจยอมรับสิ่งที่พบปลอมและขโมยรางวัลได้หนึ่งก้อน
  รันเนอร์วางพันธบัตรใน NeuroJobs แต่ BugBounty slash พันธบัตรนั้นไม่ได้
- **"การปรับปรุงโมเดล"**: ยังไม่มีทางบนเชนที่จะตรวจว่าโมเดลดีขึ้นจริง issuance เว้นที่ให้ถังไว้ แต่ยังไม่มีสัญญา sink สำหรับมัน

**สถานะ: เสร็จในระดับโมดูลสัญญาบนเทสต์เน็ต** (เทสต์: ต้องเป็น timelock, การแบ่ง, เพดาน, overflow, ดึงได้อย่างเดียว,
การลบถังส่งเงินเข้า overflow, RewardVault → issuance → เงินอุดหนุนของ UsefulWork)

## เทสต์

```
cd zetaphy-network && npm ci && npm run build && npm test          # รวม usefulwork, usefulwork-deploy, fuzz
cd zetaphy-hub && npm ci && npm test && npm run test:e2e           # รวม work.test.mjs, work.e2e.mjs (Chromium, CSP ของเว็บ)
```

`work.e2e.mjs` รันสัญญาจริงบน EVM ในหน่วยความจำ หลังโหนดจำลองที่ chain id 77390 และวอลเล็ตจำลอง: เบราว์เซอร์ทำตราประทับ สแกน commit
เปิดเผย และ settle ร่วมกับผู้ทำงานอีกสองคน แล้วล่าบั๊กและส่งสิ่งที่พบ (commit แล้วเปิดเผยในบล็อกถัดไป) ในโหมดฝึกหัดจะล่า แสดงบั๊กทุกชนิดที่พบ
แสดง coverage และดาวน์โหลดไฟล์ทำซ้ำ เมื่อ deploy แล้วแต่หยุด หน้าเว็บบอกไว้และอยู่ในโหมดฝึกหัด `usefulwork-deploy.test.js` deploy ผ่าน
`deployUsefulWork` และ CLI `zetaphy deploy-useful-work` (โหนด JSON-RPC ที่พอร์ต 18096) รัน proposal ของ timelock และรัน feeder (หยุด → ไม่มีงาน
เปิด → งานและนกขมิ้น นกขมิ้นเปิดเผยด้วย salt ที่คำนวณใหม่ settle แล้ว) `fuzz.test.js` อธิบายไว้ในข้อ 17

## สิ่งที่ยังขาด

- **ตัวการ deploy เอง**: ทางพร้อมและมีเทสต์ แต่ยังไม่มีอะไรถูก deploy จนกว่าเจ้าของจะตั้ง `USEFUL_WORK_FEEDER` / `USEFUL_WORK_FEEDER_KEY`
  รันโหมด `deploy` หนึ่งครั้ง merge pull request และให้ timelock ดำเนินการ proposal ที่เปิดตลาด ไม่ได้อยู่ใน `zetaphy-launch` (มีไฟล์และ workflow ของตัวเอง)
- **เป้าหมายของ feeder** คือสัญญาที่เพิ่งสร้างบน ZETAPHY และสัญญาที่รู้จักไม่กี่ตัว รายการเฝ้าดูของ Neuro อยู่ในเบราว์เซอร์ของผู้ใช้เท่านั้น จึงใช้ป้อนงานไม่ได้
  เชนอื่นต้องใช้ไฟล์ `--targets`
- **การจับฉลากที่นั่ง** (สุ่มด้วย blockhash ในหมู่ผู้มีตราประทับ) เพื่อกันคนเดียวรับสามที่นั่ง
- **แต้ม BZTPHY** สำหรับงานที่มีประโยชน์: งานแจกแต้มรายวันยังไม่อ่าน `SeatOutcome` / `BountyPaid`
- **รางวัลรันเนอร์สำหรับการตรวจบั๊ก** และการ slash พันธบัตร NeuroJobs ของรันเนอร์ที่รับรองผิด
- **งานสแกนที่ไม่ใช่ EVM** (Solana, Move, TON): การสแกนแบบโค้ดอย่างเดียวรองรับเฉพาะ EVM
- **ข้อจำกัดของ fuzzer**: ไม่มี symbolic execution หรือ SMT (บั๊กที่ซ่อนหลังค่าวิเศษ 32 ไบต์ที่ไม่อยู่ในโค้ด หรือ preimage ของแฮช เข้าไม่ถึง) หนึ่ง
  สัญญาเป้าหมายต่อ spec บวก hook ของผู้โจมตี (ยังไม่รองรับระบบหลายสัญญา หรือ callback ของโทเคนอย่าง ERC-721/1155/777) เวลาไม่เดิน (บั๊กที่ล็อกด้วยเวลา
  ต้องตั้งใน setup ของ spec) ทุก invariant ต้องให้ผู้เขียน spec ระบุ view (`watch`, `solvency`, `exit`, `tokens`) และ view ใน `watch` ที่เปลี่ยนได้อย่างชอบธรรม
  จะถูกรายงาน array และ tuple ลึกได้ไม่มาก ความเร็ว: ราว 10–25 ms ต่อลำดับ (ต้นทุนของ event `step` ต่อ opcode) คือไม่กี่พันลำดับต่อนาที
- **ตลาดประเมินโมเดล** (sink ของถัง "การปรับปรุงโมเดล"): ตอนนี้คือ `TrainingMarket` ดู [useful-work-training.th.md](useful-work-training.th.md) (ฝึก + สุ่มตรวจ + ประเมินบนข้อมูลกันไว้; ยังไม่ได้ deploy)
- การติดตั้งรันเนอร์ (`setup-runner.sh`) ตอนนี้คัดลอกไฟล์แกนกลางสามไฟล์ของเบราว์เซอร์แล้ว แต่การตรวจสิ่งที่พบต้องใช้ EthereumJS EVM ด้วย
  (devDependency ของ zetaphy-network: `npm i` แบบรวม dev dependencies)
