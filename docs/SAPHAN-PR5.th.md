# ZETAPHY Saphan: อ่านข้อมูลข้ามเชน, ชุดคำสั่งหลายเชน, intent และบัญชีเดียวทุกเชน (testnet)

**ใช้บน testnet เท่านั้น ยังไม่ผ่านการ audit ยังไม่ได้ deploy ไม่ใช้เงินจริง** Saphan PR 5 เพิ่มสี่อย่างบนเส้นทาง
Saphan และ Gateway (docs/SAPHAN-GATEWAY.md, docs/SAPHAN-SAFETY.md, docs/SAPHAN-PROOFS.md) ไม่มีอย่างไหนเพิ่มผู้ลงนาม
(signer) ใหม่, relayer ที่ต้องไว้ใจ หรือกุญแจแอดมิน: ทุกอย่างถูกตรวจโดย lane เดิมของเส้นทาง (validator ของ Hyperlane,
validator ของเรา, ช่วงกักตัว, Neuro, เพดานรายวัน) หรือด้วยหลักฐานทางคณิตศาสตร์ (proof)

| ความสามารถ | สัญญา (zetaphy-network/contracts) | ตัวช่วย JS (src) | เทสต์ (test) |
|---|---|---|---|
| S5 อ่านข้อมูลข้ามเชน | `SaphanReads.sol` (SaphanReads, SaphanReadResponder, SaphanZetaphyReads, SaphanMpt) | `saphanreads.js` | `saphanreads.test.js` |
| D ชุดคำสั่งหลายเชน (bundle) | `SaphanBundles.sol` | `saphanbundles.js` | `saphanbundles.test.js` |
| E Intent + ความเสี่ยงจาก Neuro | `SaphanIntents.sol` (SaphanIntents, SaphanFillRelay) | `saphanintents.js` | `saphanintents.test.js` |
| C บัญชีเดียวทุกเชน | `SaphanAccounts.sol` (SaphanAccount, SaphanAccountFactory) | `saphanaccounts.js` | `saphanaccounts.test.js` |

อะไรใช้งานได้จริง อะไรยังเป็นต้นแบบ (prototype):

- **การอ่าน**: คำตอบผ่าน lane ครบและทดสอบตั้งแต่ต้นจนจบแล้ว คำตอบแบบพิสูจน์ (proven) เกี่ยวกับเชนต้นทางต้องมี light
  client ของเชนนั้นบน ZETAPHY ซึ่ง **ยังไม่มี**: ตัวตรวจ Merkle-Patricia เสร็จแล้วและทดสอบกับ proof จริงของ EVM แต่บน
  testnet จะ deploy `SaphanReads` โดยไม่มี light client (ใช้คำตอบผ่าน lane อย่างเดียว) การอ่าน ZETAPHY จากเชนต้นทางใช้
  STARK light client ซึ่งยังเป็นต้นแบบ (docs/SAPHAN-PROOFS.md)
- **Bundle**: ครบและทดสอบแล้ว "ทั้งหมดหรือไม่มีเลย" แม่นยำบน ZETAPHY (ธุรกรรมเดียว) ส่วนคำสั่งที่ส่งต่อไปเชนอื่นยังอาจ
  ล้มเหลวที่เชนนั้นได้ และ Gateway จะคืนเงินที่นั่น (ดูด้านล่าง)
- **Intent**: ครบและทดสอบแล้ว ทางเร็ว (optimistic) ต้องมีผู้เฝ้าดูที่ซื่อสัตย์อย่างน้อยหนึ่งคนในช่วงเวลาท้วง คะแนนของ
  Neuro ดีได้เท่ากับผู้ป้อนข้อมูล (feeder) ที่ส่งมัน
- **บัญชี**: ครบและทดสอบแล้ว "ที่อยู่เดียวกันทุกเชน" ต้อง deploy factory ด้วยกุญแจใหม่หนึ่งดอกเป็นธุรกรรมแรกบนทุกเชน
  ยังไม่ได้ deploy อะไร

## S5 อ่านข้อมูลข้ามเชน: "ค่า V บนเชน X ที่บล็อก B คืออะไร"

```
 เชนต้นทาง X                                                 ZETAPHY
 ──────────                                                  ───────
 ใครก็ได้ ── SaphanReadResponder.answer(target, data) ──┐      SaphanReads(X)
   staticcall target (แก๊สคงที่ 500k ตรวจก่อนเรียก)        │        requestCall / requestSlot / requestAccount: เงินรางวัล (ผู้ถามจ่าย)
   (ผลลัพธ์, block.number, block.timestamp, ผู้ตอบ)        │
   Mailbox ของ X ── Hyperlane ────────────────────────────┼─▶ Mailbox + ISM ของเส้นทาง ─▶ handle(): เก็บคำตอบที่ใหม่ที่สุด
                                                          │
 eth_getProof(account, slots, B) จากโหนดใดของ X ─────────┼─▶ proveSlot / proveAccount: proof แบบ Merkle-Patricia ใต้
                                                               state root ของ X ที่ B (light client ของ X: `stateRoots`)
                                                             read(query, minBlock, maxAge): ปฏิเสธเมื่อเก่าเกิน
                                                             collect(request): รางวัลไปที่ผู้นำคำตอบมา
```

- **คำตอบบอกบล็อกของมันเสมอ** ทุกคำตอบมีเลขบล็อกและเวลาของ X ที่มันมาจาก คำตอบใหม่แทนคำตอบเก่า คำตอบเก่าที่มาถึงช้า
  จะถูกเพิกเฉย (และไม่ทำให้ Mailbox ค้าง)
- **ปฏิเสธคำตอบที่เก่าเกิน** `read` / `readCall` / `readSlot` / `readBalance` รับ `minBlock` และ `maxAge`: คำตอบจากบล็อกที่
  เก่ากว่า หรือเก่ากว่า `maxAge` วินาที จะ revert `Stale` สัญญาที่อ่านเป็นผู้กำหนดเองว่าสดพอแค่ไหน
- **ผู้ถามจ่าย** `requestCall(target, data, minBlock, ttl)` (และ `requestSlot`, `requestAccount`) ฝากเงินรางวัลเป็น ZTPHY
  ใครนำคำตอบที่เข้าเงื่อนไขมาก่อนคำขอหมดอายุ (`ttl` ไม่เกิน 7 วัน) จะได้รับเครดิต (`collect` แล้ว `claim`) ถ้าไม่มีใครตอบ
  ผู้ถามถอนคืนหลังหมดอายุ (`cancel`, `claim`) ผู้ตอบจ่ายค่า Mailbox ของ X เอง (จำนวนต้องตรงพอดี, `quote`)
- **ปลอมหรือบีบคำตอบไม่ได้** มีแต่ responder บน X (ผู้ deploy ตั้งได้ครั้งเดียว) ที่พูดแทน X ได้ และ Mailbox บน ZETAPHY
  ตรวจ ISM ของเส้นทางก่อน responder ให้แก๊สเท่ากันทุกการเรียกและตรวจว่ามีพอ ผู้ตอบจึงจงใจทำให้การเรียกล้มไม่ได้
  ผลลัพธ์ที่ยาวเกิน 1024 ไบต์ถือว่าล้มเหลว
- **อ่านกลับทาง** `SaphanZetaphyReads.verify` บนเชนต้นทางตรวจ storage slot ใดก็ได้ของ ZETAPHY ที่ความสูงที่ STARK light
  client ยืนยันแล้ว (เส้นทาง IAVL ไปยัง evm store และเส้นทาง multistore ไปยัง app hash เหมือน proven release) เป็นฟังก์ชัน
  view: สัญญาบน X เรียกพร้อม proof ภายในธุรกรรมของตัวเอง และกำหนดเองว่าความสูงต้องใหม่แค่ไหน (`minHeight`) พิสูจน์ได้
  เฉพาะ slot ที่มีค่าอยู่ (ยังพิสูจน์ "ไม่มีค่า" ไม่ได้)

คำสั่ง (ออฟไลน์): `node scripts/saphan.js read-query --chain-id <X> --target 0x… (--data 0x… | --slot <n>)`

## D ชุดคำสั่งหลายเชน: ทำครบทุกขั้น หรือคืนเงินทั้งหมด

```
 Sepolia: alice ── depositAndCall(SaphanBundles, data = (id, 0)) ─▶ เส้นทาง ─▶ ZetaphyGateway ─▶ onSaphanCall: ขา 0 มาแล้ว
 Base:    bob   ── depositAndCall(SaphanBundles, data = (id, 1)) ─▶ เส้นทาง ─▶ ZetaphyGateway ─▶ onSaphanCall: ขา 1 มาแล้ว
 ZETAPHY: carol ── fund(id, 2) ──────────────────────────────────────────────────────────────▶ ขา 2 มาแล้ว
 ใครก็ได้ ── execute(id, plan): ธุรกรรมเดียว: ทุกขั้นบน ZETAPHY (โอนโทเคน + onSaphanBundle)
                                             + ทุกคำสั่งไปเชนอื่น (ZetaphyGateway.withdrawAndCall)
          ขั้นใดล้ม ─▶ ทั้งธุรกรรม revert (ลองใหม่ได้ก่อนเส้นตาย)
 เลยเส้นตายแล้วยังไม่ได้รัน ─▶ refund(id): เงินแต่ละขาค้างจ่ายให้ refundTo ของขานั้น ─▶ claim(token)
```

- `create(legs, plan, deadline)`: ไม่เกิน 8 ขา 8 ขั้น เส้นตายไม่เกิน 30 วัน แผน (plan) ถูกล็อกตั้งแต่ตอนนี้ (เก็บ hash) และต้อง
  ใช้เงิน **พอดี** กับที่ขาทั้งหมดนำมา แยกตามโทเคน ถ้าไม่พอดีจะถูกปฏิเสธ
- **หลักฐานการส่งถึงของแต่ละขา** ขาจากเชนอื่นมาถึงเป็นการเรียกผ่าน Gateway: lane ของเส้นทางรับรอง deposit address ของมัน
  ซึ่งก็คือ hash ของคำสั่งทั้งหมด (ผู้ส่ง, จำนวน, data = bundle และขา) bundle ยังตรวจว่าโทเคนอยู่ในมือจริง (ยอดคงเหลือเกิน
  กว่าที่ค้างจ่ายอยู่) "gateway" ปลอมจึงเติมเงินขาใดไม่ได้ ขาที่มาช้า จ่ายซ้ำ หรือมาจากผู้ส่งผิดคนจะถูกปฏิเสธ และ Gateway
  คืนเงินให้ที่เชนต้นทาง
- **คำสั่งไปเชนอื่น** มี call hash ของ Gateway เอง (event `OutSent`): ปลายทางได้ `abi.encode(bundle id, creator, data)` จาก
  Gateway โดย `sender` = SaphanBundles
- **"atomic" ในที่นี้หมายถึงอะไร** ทุกอย่างบน ZETAPHY และ *การส่ง* ทุกคำสั่งไปเชนอื่น เกิดในธุรกรรม ZETAPHY เดียว หรือไม่เกิด
  เลย คำสั่งที่ส่งไปแล้วยังอาจล้มที่เชนปลายทาง (target revert) แล้ว Gateway จะจ่ายเงินให้ `revertTo` ของขั้นนั้นที่นั่น
  การทำให้คำสั่งปลายทางทั้งหมด "ทั้งหมดหรือไม่มีเลย" ต้องให้เชนอื่นรอกัน (two-phase commit) ซึ่งยังไม่ได้ทำ
- การคืนเงินเป็นแบบดึง (`claim(token)`) บน ZETAPHY โดย `refundTo` ของแต่ละขา จากนั้นใช้เส้นทางนำกลับบ้าน
- ผู้รัน (executor) จ่ายค่า Mailbox ของขั้นขาออก (`fees` ตรงพอดี) ส่วนที่ Gateway คืนกลับมาจะคืนให้ผู้รัน

## E Intent พร้อมความเสี่ยงจาก Neuro

```
 Sepolia: alice ── depositAndCall(SaphanIntents, data = order) ─▶ เส้นทาง ─▶ เปิด intent บน ZETAPHY, A อยู่ในเอสโครว์
          order: ให้ A (token(Sepolia)) ต้องการ ETH บน Base อย่างน้อย B ให้ bob ภายในเวลา T
 Neuro:   NeuroScore(bob) สูง หรือ ThreatRegistry กัก/บังคับ bob ─▶ ปฏิเสธ (Gateway คืนเงิน alice)
          ปานกลาง ─▶ การเติม (fill) จะนับหลัง riskDelay เท่านั้น (notBefore)
 Base:    solver ── SaphanFillRelay.fill(id, bob, B') ─▶ bob ได้ ETH B' ทันที จากเงินของ solver
                    └─ Mailbox ของ Base ── Hyperlane ─▶ SaphanIntents.handle: fill ที่พิสูจน์แล้ว ─▶ solver ได้ A บน ZETAPHY
 ทางเร็ว: solver ── claimFill(id) + เงินค้ำ ─▶ ไม่มีใครท้วงใน challengeWindow ─▶ settle(): solver ได้ A และเงินค้ำคืน
          ผู้เฝ้าดู ── challenge(id) + เงินค้ำ ─▶ ข้อความ fill เท่านั้นเป็นตัวตัดสิน:
                       มาถึง (solver คนเดิม)   ─▶ solver ได้เงิน และได้เงินค้ำของผู้ท้วง
                       มาถึง (solver คนอื่น)   ─▶ คนที่เติมจริงได้เงิน เงินค้ำของผู้อ้างถูกริบ
                       ไม่มาใน disputePeriod  ─▶ timeout(): ริบเงินค้ำผู้อ้างให้ผู้ท้วง intent เปิดใหม่
 ไม่มีใครเติมภายใน T + grace ─▶ refund(): A ค้างจ่ายคืนให้ refundTo
```

- เปิดบน ZETAPHY ด้วย `open(order)` หรือจากเส้นทางใดก็ได้ในธุรกรรมเดียว (`depositAndCall` ด้วย
  `data = abi.encode(order)`; `src/saphanintents.js orderData`) ถ้า `dstDomain` = chain id ของ ZETAPHY แปลว่าผู้รับต้องการ
  ERC-20 บน ZETAPHY: `fillLocal` จ่ายและชดใช้ในธุรกรรมเดียว (ไม่ต้องมี proof)
- **Neuro กั้นและหน่วง** ตอนเปิด: `ThreatRegistry.isAddressHeld/isAddressEnforced(เชน Y, ผู้รับ)` ปฏิเสธ;
  `NeuroScore.scoreOf(ผู้รับ)` ระดับ 3 (สูง) ปฏิเสธ ระดับ 2 (กลาง) หน่วงทุก fill ไป `riskDelay` การเติมบน ZETAPHY ตรวจผู้รับ
  อีกครั้ง solver ที่ ThreatRegistry กักไว้เติมบน ZETAPHY หรือยื่นอ้างไม่ได้ โมเดลและเกณฑ์ของ NeuroScore เปลี่ยนได้ผ่าน
  governance (ZetaphyTimelock) เท่านั้น
- **เงินค้ำของ solver และการริบ** ทุกการอ้างแบบ optimistic วาง `claimBond` เป็น ZTPHY (ตรงพอดี) การอ้างเท็จเสียเงินค้ำให้
  ผู้ท้วง (หรือให้ solver ที่เติมจริง) การท้วงวาง `challengeBond` และเสียให้ solver ที่พิสูจน์ได้ว่าเติมจริง ถอนเงินค้ำด้วย
  `withdrawBonds()` solver ต้องยื่นอ้างและเติมจากที่อยู่เดียวกัน (ข้อความ fill ระบุที่อยู่ที่เติมบน Y ถ้าเป็นที่อยู่อื่นจะนับว่าเป็น
  การเติมของคนอื่น)
- **ความไว้ใจ** fill ที่พิสูจน์แล้วไว้ใจเท่ากับที่เส้นทางไว้ใจสำหรับเงินขาเข้าอยู่แล้ว (validator ของ Hyperlane สำหรับ Y) ทางเร็ว
  เร็วกว่าแต่ต้องมีคน (ผู้ใช้เอง, hub, ผู้เฝ้าดูใดก็ได้) ท้วงการอ้างเท็จภายใน `challengeWindow`; `disputePeriod` ต้องยาวกว่า
  เวลาส่งข้อความของ Hyperlane
- **solver ต้องตรวจก่อนเติม** (`intentOf`, `src/saphanintents.js fillProblem`): fill ที่ไม่ตรง (ผู้รับคนอื่น, น้อยกว่า minOut,
  หลังเส้นตาย, ก่อน notBefore, intent ที่ถูกเติมหรือคืนเงินไปแล้ว) จะถูกปฏิเสธบน ZETAPHY และไม่ได้รับเงินชดใช้ แต่ละ intent
  เติมได้ครั้งเดียวต่อ relay
- การจ่ายเงินทั้งหมดเป็นแบบดึง: ชดใช้และคืนเงิน `claim(token)` เงินค้ำ `withdrawBonds()` ผู้รับบน Y ได้เงินทันทีจาก relay
  (ETH ของ solver เอง)

## C บัญชีเดียวทุกเชน

```
 กุญแจใหม่ K ธุรกรรมแรกบนทุกเชน ─▶ SaphanAccountFactory อยู่ที่อยู่เดียวกัน F ทุกที่
 account(owner) = CREATE2(F, salt = owner, SaphanAccount + owner)   (เหมือนกันทุกเชน; src/saphanaccounts.js)

 ZETAPHY:  owner ── account.execute(calls)
 เชน X:    owner ── ZetaphyGateway(X).withdrawAndCall(account, abi.encode(calls), amount, ..., revertTo = account)
           ─▶ เส้นทาง ─▶ SaphanSourceGateway(X).execute ─▶ account.onSaphanCall(77390, owner, data): รันคำสั่ง
```

- ใครก็ deploy บัญชีได้ (`factory.deploy(owner)`) แต่บัญชีเป็นของ owner เสมอ
- **ใครควบคุม** บน ZETAPHY คือ owner โดยตรง ที่อื่นทั้งหมดคือคำสั่งของ owner จาก ZETAPHY ผ่าน Gateway ของเชนนั้นเท่านั้น:
  บัญชีตรวจ Gateway (ของ factory ซึ่งตายตัวตั้งแต่ deploy) เชนต้นทาง (ZETAPHY) และผู้ส่ง (owner) กุญแจของ owner ไม่ถูกใช้บน
  เชนอื่นเลย owner ที่เป็นสัญญาบน ZETAPHY (multisig, QuantumWallet) จึงคุมบัญชีของตนได้ทุกที่ และใครที่ถือที่อยู่เดียวกันบน
  เชนอื่นก็คุมอะไรไม่ได้
- คำสั่งทั้งหมดรันครบหรือไม่รันเลย ถ้าล้ม Gateway เก็บ ETH ไว้ให้ `revertTo` (ตัวบัญชีเองเมื่อใช้ `controlArgs`) และใครก็
  ย้ายเงินนั้นเข้าบัญชีได้ด้วย `pullRefunds()`
- บน ZETAPHY บัญชีรับเงินที่ส่งมาจากเชนอื่นผ่าน Gateway ได้ด้วย (แต่ไม่รันคำสั่งจากเงินนั้น)

คำสั่ง (ออฟไลน์): `node scripts/saphan.js account --owner 0x… (--deployer 0x… | --factory 0x…)`

## เทียบกับ ZetaChain

คำถามเรื่องความไว้ใจเหมือนกับของ Gateway (docs/SAPHAN-GATEWAY.md): การกระทำข้ามเชนของ ZetaChain ถูกรับรองโดย
observer-signer และกุญแจ TSS ของมัน ที่นี่ทุกความสามารถใช้สิ่งที่เส้นทางตรวจอยู่แล้ว:

| | ใครรับรองที่นี่ | ความไว้ใจใหม่ |
|---|---|---|
| คำตอบการอ่าน (lane) | ISM ของเส้นทาง (validator ของ Hyperlane สำหรับ X) | ไม่มี |
| คำตอบการอ่าน (proven) | light client ของ X + proof แบบ Merkle-Patricia | ไม่มี (เมื่อมี light client แล้ว) |
| ขาของ bundle | lane ของเส้นทาง (deposit address ของ Gateway = hash ของคำสั่ง) + โทเคนที่อยู่ในมือจริง | ไม่มี |
| การเติม intent | ข้อความ fill ผ่าน Hyperlane (validator ของ Y) หรือการอ้างที่มีเงินค้ำซึ่งไม่มีใครหักล้างได้ | ผู้เฝ้าดูซื่อสัตย์หนึ่งคนสำหรับทางเร็ว |
| การควบคุมบัญชี | การตรวจขาออกของเส้นทาง (validator ของเรา หรือ proven release, ช่วงหน่วง, veto) | ไม่มี |

## การ deploy (ยังไม่ได้ทำ)

ยังไม่มีอะไรใน PR นี้ถูก deploy ลำดับต่อเชนคือ: `SaphanReads(X)` บน ZETAPHY แล้ว `SaphanReadResponder` บน X และ
`setResponder` (ครั้งเดียว); `SaphanBundles` บน ZETAPHY (ไม่ต้องตั้งค่า); `SaphanIntents` บน ZETAPHY (NeuroScore,
ThreatRegistry, Mailbox, ISM ที่ครอบคลุมเชนที่ใช้เติม, เงินค้ำและช่วงเวลา) แล้ว `SaphanFillRelay` บนแต่ละ Y และ
`setRelay(Y, relay)` (เชนละครั้ง); `SaphanAccountFactory` จากกุญแจใหม่หนึ่งดอกเป็นธุรกรรมแรกบนทุกเชน (ZETAPHY: gateway = ศูนย์;
X: SaphanSourceGateway ของมัน) hub ยังไม่มีหน้าสำหรับสิ่งเหล่านี้

## ข้อจำกัด

- ใช้บน testnet เท่านั้น ยังไม่ผ่าน audit ยังไม่ได้ deploy ใช้เหรียญทดสอบเท่านั้น
- ยังไม่มี light client ของเชน EVM บน ZETAPHY การอ่านแบบพิสูจน์ของเชนต้นทางจึงต้องรอ
- Bundle เป็น atomic บน ZETAPHY ไม่ใช่ข้ามเชนปลายทาง (ดูด้านบน)
- ทางเร็วของ intent ต้องมีผู้เฝ้าดู hub ยังไม่ได้รันตัวเฝ้าดู
- คำตอบผ่าน lane และข้อความ fill ปลอดภัยเท่ากับ validator ของ Hyperlane ของเส้นทาง เหมือนเงินขาเข้าของเส้นทาง
- proof แบบ Merkle-Patricia ที่มีโหนดฝังอยู่ในโหนดแม่ (สั้นกว่า 32 ไบต์) จะถูกปฏิเสธ เมื่อคีย์ถูก hash แล้วกรณีนี้แทบไม่เกิดขึ้นจริง
