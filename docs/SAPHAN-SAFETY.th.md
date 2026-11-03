# ZETAPHY Saphan: ทางหนีฉุกเฉิน และการคัดค้านแบบวางเงินค้ำประกัน

**ใช้บน testnet เท่านั้น ยังไม่ผ่าน audit** ตาข่ายความปลอดภัย 2 ชั้นรอบทุกเส้นทางของ Saphan (docs/SAPHAN-MULTICHAIN.md)
เพิ่มจากที่เส้นทางมีอยู่แล้ว (2 ช่องทางรับรองอิสระ, ระยะกักตัว, Neuro veto, threat registry, วงเงินรายวัน):

- **ทางหนีฉุกเฉิน** (บนเชนต้นทาง): ถ้า ZETAPHY หยุด (ล่ม ถูกเซ็นเซอร์ หรือถูกตัดขาด) ผู้ถือยังได้ ETH คืนจาก lockbox
  ของเส้นทางได้เอง ไม่ต้องขอใคร
- **การคัดค้านแบบวางเงินค้ำประกัน** (บน ZETAPHY): ใครก็หยุดธุรกรรมที่ผิดได้ก่อนเหรียญจะถูกสร้าง และช่องทาง (lane)
  ที่รับรองธุรกรรมนั้นจะถูกริบเงินค้ำประกัน

## ทางหนีฉุกเฉิน

```
 ZETAPHY                                              เชนต้นทาง X
 SaphanCheckpointer.beat()  ── สัญญาณชีพ (validator ของเราลงนาม เหมือน release) ──▶ HyperlaneLockBoxV2
   ใครก็เรียกได้ ไม่เกินชั่วโมงละครั้ง จ่ายค่า Mailbox                                    lastHeard = ตอนนี้

 ไม่มีสัญญาณชีพและไม่มี release เลยนาน ESCAPE_AFTER (14 วัน): lockbox เข้าโหมด ESCAPING
   - lock() ปฏิเสธ (ไม่รับเงินใหม่)
   - submitExitRoot(root, total, sigs): validator ของเรา (ชุดเดียวกับ ISM ของ lockbox ตาม threshold)
     ลงนาม exitDigest(root, total) ทำได้ครั้งเดียว
   - escape(owed, proof): แต่ละที่อยู่ถอนส่วนของตัวเอง ถ้าเงินหนุนไม่พอจะได้ตามสัดส่วน ถอนได้ครั้งเดียว
   - หลังมี root แล้ว claim() และข้อความทุกอย่างจาก ZETAPHY จะถูกปฏิเสธ (root นับรวมไว้แล้ว)
 ถ้ามีสัญญาณชีพมาก่อนจะมี root โหมดหนีจะจบเอง และ governance สั่งยกเลิกการหนีที่เริ่มแล้วไม่ได้ (setCheckpointer ปฏิเสธ)
```

**exit root นับอะไรบ้าง** (`src/saphansafety.js exitEntitlements`): ยอด token(X) บน ZETAPHY ณ บล็อกสุดท้าย
(อ่านจาก event Transfer), release ที่รออยู่บน lockbox แต่ยังไม่มีคนรับ (ให้ผู้รับ), และ lock ที่ ZETAPHY ยังไม่ได้สร้างเหรียญให้
(ให้ผู้ส่ง) ที่อยู่ละ 1 บรรทัด: leaf = `keccak256(keccak256(abi.encode(address, owed)))` เป็น Merkle tree แบบเรียงคู่
ทุกคนสร้างใหม่ได้จากข้อมูลสาธารณะ และตรวจได้ว่า validator ลงนามอะไรไป

**ต้องเชื่อใจใคร**: validator ชุดเดียวกับที่ลงนามทุก release อยู่แล้ว (ซึ่งปล่อยเงินได้อยู่แล้ว) ไม่มีใครเพิ่ม
root ปลอมต้องใช้ validator ครบ threshold เท่ากับการปลอม release ช่องทาง light client (Saphan PR 3) จะตัดความเชื่อใจนี้
ออกสำหรับขาเข้า

คำสั่ง (ใน zetaphy-network):

```
node scripts/saphan.js heartbeat --chain sepolia                      # ส่งสัญญาณชีพ 1 ครั้ง (deployer จ่ายค่าธรรมเนียม)
node scripts/saphan.js exit-root --file owed.json                     # root และยอดรวมของ [[address, wei], ...]
node scripts/saphan.js exit-root --file owed.json --chain sepolia --sign yes   # validator ลงนาม (KEYFILE)
node scripts/saphan.js exit-proof --file owed.json --account 0x…      # proof ของผู้ถือ สำหรับ escape()
```

`owed.json` เป็นได้ทั้ง `[[address, wei], ...]` หรือ `{ "balances": [...], "unclaimedReleases": [...], "unmintedLocks": [...] }`

## การคัดค้านแบบวางเงินค้ำประกัน

```
 ใครก็ได้ ── open(transfer, เหตุผล) + เงินค้ำ ──▶ SaphanChallenges ── hold(id) ──▶ BridgeAirlock   (release ต้องรอ)
 Neuro runner (NeuroJobs: active, ประวัติดี) ── vote(id, uphold?) ภายใน votingPeriod
 resolve(id):
   uphold ครบ quorum ──▶ airlock.veto(id): ไม่มีวันสร้างเหรียญ ผู้คัดค้านได้เงินค้ำคืน + ครึ่งหนึ่งของเงินค้ำ lane ที่ถูกริบ
                         lane ทุกเส้นที่รับรองธุรกรรมนี้ถูกริบเงินค้ำ (อีกครึ่งเข้ากองสำรอง)
   reject ครบ quorum หรือหมดเวลาโดย uphold ไม่ครบ
                     ──▶ airlock.unhold(id): ธุรกรรมไปต่อ เงินค้ำของผู้คัดค้านตกเป็นของผู้รับปลายทาง (ชดเชยที่ต้องรอ)
```

- **ผู้คัดค้าน (challenger) ทำได้แค่ถ่วงเวลา** `BridgeAirlock.hold` / `unhold` แตะได้แค่ release ของธุรกรรมเดียว
  และเฉพาะธุรกรรมที่มี lane รับรองแล้ว ยังไม่ถูกปล่อยหรือ veto ไม่สามารถรับรอง ปล่อย สร้างเหรียญ หยุดระบบ หรือย้ายเงินได้
  เหมือน marker governance เป็นคนตั้ง (`setChallenger`) และตั้งเป็น vetoer (`setVetoer`) เพื่อให้ veto ได้เมื่อคัดค้านสำเร็จ
- **เงินค้ำของ lane**: ผู้ดูแล lane วางเงินค้ำ (`bondLane`) จะถอนออกต้องรอ `UNBOND_DELAY` (14 วัน นานกว่าทุกการโหวต)
  และถูกริบได้จนกว่าจะถอนออก
- **การจ่ายเงินเป็นแบบมารับเอง** (`claim()`) เงินค้ำที่ริบเข้ากองสำรองจะส่งไปกองประกัน (`payReserve` โดย governance)
  เช่นกอง HackInsurance
- **ค่าเริ่มต้น** (`safety-deploy`): เงินค้ำ 10 ZTPHY, โหวต 2 วัน, quorum 2 runner ที่มีงานผ่านอย่างน้อย 3 งาน

ที่ยังไม่ทำ: ธุรกรรมที่สร้างเหรียญไปแล้วจะไม่ถูกย้อนกลับ กรณีนั้นใช้วงเงินและการหยุดของ guard กับกองประกันแทน
runner ตัดสินจากหลักฐานนอกเชน ช่องทาง light client (PR 3) จะให้การคัดค้านแนบหลักฐานได้ว่า lock นั้นไม่มีอยู่จริงบน X

## เปิดใช้กับเส้นทาง

1. Actions -> **saphan-route** เลือก `mode = safety` (หลัง deploy เส้นทางแล้ว): deploy SaphanCheckpointer และ
   SaphanChallenges บน ZETAPHY สรุปของ run จะบอกคำสั่ง governance ที่ต้องทำต่อ ส่วนที่อยู่สัญญาจะถูกส่งไปที่
   `saphan/<chain>-safety` (merge branch นั้น)
2. Governance:
   - บนเชนต้นทาง (timelock 48 ชม.): `lockbox.setCheckpointer(checkpointer)`
   - บน ZETAPHY (timelock): `airlock.setChallenger(challenges)` และ `airlock.setVetoer(challenges, true)`
3. สัญญาณชีพ: รัน `mode = heartbeat` (หรือ `node scripts/saphan.js heartbeat`) อย่างน้อยวันละครั้ง relayer จะส่งต่อให้

สัญญา: `contracts/HyperlaneLockBoxV2.sol` (ทางหนีฉุกเฉิน), `contracts/SaphanCheckpointer.sol`,
`contracts/SaphanChallenges.sol`, `contracts/BridgeAirlock.sol` (hold / unhold) เทสต์: `test/saphansafety.test.js`
