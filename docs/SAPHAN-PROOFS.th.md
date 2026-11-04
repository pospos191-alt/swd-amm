# ZETAPHY Saphan: release ที่พิสูจน์ได้, ฝาก Bitcoin ด้วย proof of work, พิสูจน์เงินสำรอง

**ใช้บน testnet เท่านั้น ยังไม่ผ่าน audit** Saphan PR 3: จุดที่เส้นทางเลิกเชื่อใจคน แล้วเชื่อคณิตศาสตร์แทน

| เรื่อง | เดิม | ตอนนี้ |
|---|---|---|
| ZETAPHY -> เชนต้นทาง | validator ของเราลงนามทุก release (ECDSA ผ่าน ISM) | release **พิสูจน์จาก state ของ ZETAPHY**: STARK light client ของ ZETAPHY บนเชนต้นทาง (นับเสียงยืนยันแบบ ML-DSA-44), เส้นทาง IAVL / multistore ไปถึง app hash ของบล็อก และเส้นทาง Merkle ใน ZetaphyOutbox ถ้าเปิด `requireProof` ไม่มีผู้ลงนามคนไหนปล่อยเงินได้ |
| Bitcoin -> ZETAPHY | (ไม่มีเส้นทาง) | lane ที่รับรองการฝากด้วย **proof of work ของ Bitcoin** (BtcLightClient, SPV พร้อมจำนวน confirmation) |
| เงินสำรอง | อ่านสองเชนเอง | ทุกสัญญาณชีพพกยอดเหรียญ token(X) บน ZETAPHY มาด้วย `lockbox.reserves()` แสดงยอดที่ถือ / ยอดเหรียญ / bps |

## release ที่พิสูจน์ได้ (ZETAPHY -> X)

```
 ZETAPHY                                                   เชนต้นทาง X
 SaphanProvableOutbox(X).send(to, amount)
   ├─ HyperlaneOutbox.send ── release ทาง Hyperlane ─────▶ HyperlaneLockBoxV2.handle   (ถูกปฏิเสธเมื่อ requireProof)
   └─ ZetaphyOutbox.send(X, lockbox, body เดียวกัน)
         root ของมันอยู่ใน state ของ ZETAPHY
                         StarkLightClient (บน X): บล็อก H final ─▶ SaphanReleaseVerifier.prove(H, state proof, leaf)
                                                                     └─▶ lockbox.queueProven(body)
 body เดียวกัน = release id เดียวกัน: ทางไหนมาถึงก่อนจะถูกบันทึก อีกทางจะถือเป็นการส่งซ้ำ
 หลังบันทึกแล้ว ยังมีช่วงรอ, veto, pause, เพดานรายวัน และการเช็กเงินหนุนของ lockbox ตามปกติ
```

- `SaphanProvableOutbox` มี `send` / `quoteSend` เหมือน outbox ทุกประการ Gateway และกระเป๋าจึงใช้แทนได้เลย
  (approve token(X) ให้มันก่อน) มันเขียน body ที่ outbox กำลังจะส่ง (nonce เดียวกัน) ลง ZetaphyOutbox ด้วย
- `SaphanReleaseVerifier` รับ leaf จาก provable outbox ที่ส่งมายัง lockbox นี้บนเชนนี้เท่านั้น
- `lockbox.setProofVerifier(verifier, requireProof)` (governance) ถ้า `requireProof = false` ใช้ได้ทั้งสองทาง
  (proof ไม่ได้ทำให้เร็วขึ้น แต่ก็ไม่ได้ตัดอะไรออก) ถ้า `true` ต้องมี proof เท่านั้น
- **ทนควอนตัมตั้งแต่ต้นจนจบ**: STARK ใช้ hash ส่วน certificate ยืนยันบล็อกของ ZETAPHY เป็นเสียงโหวต ML-DSA-44
  (โหมด pq ของมัน, docs/future/trustless-bridge.md) ไม่มีกุญแจ ECDSA อยู่บนเส้นทางของ release ที่พิสูจน์แล้วเลย
- สิ่งที่ relayer ต้องสร้าง: `src/starkbridge` (proof light client ของบล็อก H, ICS23 proof จาก `abci_query
  store/evm/key` ที่ H-1, เส้นทาง leaf จาก event `MessageSent` ของ ZetaphyOutbox) และ `src/saphanproofs.js`

## การฝาก Bitcoin (BtcSpvLane)

การฝากคือธุรกรรม Bitcoin ที่มี output จ่ายเข้า custody script ของเส้นทาง และมี OP_RETURN
`"ZTPHY" || <ที่อยู่ ZETAPHY ผู้รับ 20 ไบต์>` ใครก็ส่งเข้ามาได้พร้อมบล็อกและ Merkle branch light client
จะเช็ก proof of work และจำนวน confirmation (ค่าเริ่มต้น 6) แล้ว lane รับรอง
`(BTC_CHAIN_ID, custody id, keccak256(txid, vout), 0, ผู้รับ, sats x 10^10)` ให้ airlock ของเส้นทาง BTC
airlock ยังต้องรออีก lane (Neuro runner ที่เฝ้า Bitcoin), ระยะกักตัว และการเช็กภัยคุกคามเหมือนเดิม
แต่ละ output รับรองได้ครั้งเดียว การส่ง BTC กลับต้องมีกุญแจบน Bitcoin จึงยังไม่ทำจนกว่าจะผ่าน audit ภายนอก
(ลำดับ 6 มีต้นแบบ BitVM2)

## พิสูจน์เงินสำรอง

ตอนนี้ `SaphanCheckpointer` ใส่ `totalSupply()` ของ token(X) บน ZETAPHY ลงในทุกสัญญาณชีพ (body 192 ไบต์)
lockbox บันทึกไว้พร้อมเวลา `reserves()` คืนค่า `(held, supply, asOf, bps)` ถ้า bps >= 10000 แปลว่าทุกเหรียญที่ข้ามสะพาน
มีเงินหนุนครบ ถ้ามีการ burn ที่กำลังเดินทางอยู่ จะเห็นเป็นหนุนเกินชั่วคราว ไม่มีทางเห็นเป็นหนุนขาด
สัญญาณชีพลงนามโดย validator ของเราเหมือน release และเมื่อใช้ STARK light client ก็อ่านยอดเหรียญจาก state ของ ZETAPHY ได้
ด้วยวิธีเดียวกับ release

## ที่ไม่ได้อยู่ใน PR นี้

- **IBC (Cosmos Hub / Osmosis)**: ต้องมี relayer (Hermes) ทำงานตลอดเวลา เกินกำลังโหนดฟรี ย้ายไปไว้ Saphan PR 6 (เพิ่มเชน)
- light client ของ Ethereum บน ZETAPHY (ขาเข้าโดยไม่ต้องพึ่ง validator ของ Hyperlane): sync committee ของ Ethereum
  ใน STARK อยู่ในลำดับ 4 (หลักฐานเดียวต่อข้อความ)

สัญญา: `contracts/SaphanProofs.sol`, `contracts/BtcSpvLane.sol`, `contracts/HyperlaneLockBoxV2.sol`
(`queueProven`, `requireProof`, `reserves`), `contracts/SaphanCheckpointer.sol` เทสต์: `test/saphanproofs.test.js`
