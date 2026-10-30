# สะพานแบบไม่ต้องเชื่อใจใคร: ZETAPHY → Ethereum และ Bitcoin (ต้นแบบ)

**ต้นแบบสำหรับ testnet ยังไม่ผ่านการตรวจสอบ (audit)** ใช้คีย์ทดสอบเท่านั้น งานนี้ต่อยอดจากไลต์ไคลเอนต์ STARK
([stark-light-client.th.md](stark-light-client.th.md)) ควรอ่านเอกสารนั้นก่อน เพื่อรู้ว่า STARK พิสูจน์อะไร (Stage A) และไม่ได้พิสูจน์อะไร

เป้าหมายคือย้ายสินทรัพย์ออกจาก ZETAPHY **โดยไม่ต้องมี multisig และไม่ต้องเชื่อ relayer** relayer (ใครก็ได้) มีหน้าที่แค่ขนหลักฐานไปส่ง
ส่วนการตัดสินว่าจะปล่อยเหรียญอะไร หลักฐานเป็นตัวกำหนด เอกสารนี้บอกตรง ๆ ว่าต้นแบบทำได้ถึงไหนในแต่ละโหมด

| ชิ้นส่วน | อยู่ที่ |
|---|---|
| ตัวตรวจ STARK บนเชน (พอร์ตจาก `src/starklc/verifier.js` ใช้ precompile SHA-256 และ modexp) | `zetaphy-network/contracts/StarkVerifier.sol` |
| ไลต์ไคลเอนต์บน Ethereum: ปักหมุด genesis, handoff, header + app_hash, การโต้แย้งลายเซ็นแบบ optimistic | `contracts/StarkLightClient.sol` |
| ฝั่ง ZETAPHY: outbox แบบ Merkle ที่เพิ่มได้อย่างเดียว (เก็บรากไว้ใน storage slot 0) และ lockbox | `contracts/ZetaphyOutbox.sol` |
| ฝั่ง Ethereum: ตรวจหลักฐาน ICS23 IAVL + multistore + outbox, กันส่งซ้ำ, จำกัดยอดรายวัน, ปุ่มหยุด | `contracts/ZetaphyBridgeInbox.sol` |
| header ของ Bitcoin + SPV บน ZETAPHY (ฝาก BTC → ZETAPHY) | `contracts/BtcLightClient.sol` |
| สร้างหลักฐานนอกเชน (แฮช header ของ CometBFT, multistore, IAVL, ต้นไม้ outbox) | `zetaphy-network/src/starkbridge/` |
| ทดสอบ: สองเชนในหน่วยความจำแบบต้นจนจบ, การปลอม, ค่าแก๊ส | `test/starkbridge.test.js`, `test/btclc.test.js` |
| ข้อมูล Bitcoin mainnet จริง (สร้างใหม่และตรวจซ้ำได้จากไฟล์สาธารณะ) | `test/fixtures/btc-mainnet.json`, `scripts/btc-fixture.js` |

## 1. สถาปัตยกรรม (ZETAPHY → Ethereum)

```
ZETAPHY (Cosmos SDK + cosmos/evm)                         Ethereum
───────────────────────────────────                       ─────────────────────────────────────────────
ผู้ใช้ ─lock─> ZetaphyLockbox ─send─> ZetaphyOutbox         StarkLightClient (ปักหมุดรากชุดผู้ตรวจสอบ genesis)
                      slot 0 = sha256(treeRoot‖count)        ▲ submit(proof, app_hash, aunts 4 ตัว)
บล็อก h: state เปลี่ยน                                        │   StarkVerifier: ตรวจ STARK ครบบนเชน
บล็อก H > h: header.app_hash = state หลังบล็อก H-1           │   Merkle ของ header: app_hash → block hash
ผู้ตรวจสอบลงนาม "zetaphy/pq-vote" ‖ chain ‖ H ‖ hash          │   รอหน้าต่างโต้แย้ง / submitChecked → app_hash(H) สิ้นสุด
   (ใบรับรอง ML-DSA-44 อยู่ในบล็อก H+1)                       │
prover (ใครก็ได้): collectFromNode → proveBlock ────────────┘
relayer (ใครก็ได้): abci_query store/evm/key prove=true ──> ZetaphyBridgeInbox.release(H, หลักฐาน state, ข้อความ, path)
                                                           app_hash(H) ─multistore ops─> ราก evm store
                                                           ─IAVL ops─> key 0x02‖outbox‖slot0 = ราก outbox
                                                           ─sibling SHA-256 32 ตัว─> ใบของข้อความ
                                                           ผู้ส่ง = lockbox, ปลายทาง = เชน/สัญญานี้,
                                                           nonce ยังไม่ใช้, ไม่เกินยอดรายวัน, ไม่ถูกหยุด → โอน
```

### มีรากอะไรให้ใช้ และทำไมต้องมี outbox

header ของ CometBFT ผูกมัด `app_hash` (ราก multistore ของ Cosmos คือ **state หลังบล็อกก่อนหน้า**), แฮชชุดผู้ตรวจสอบ และ
`last_results_hash` ส่วนสะพานต้องพิสูจน์ว่า "การล็อกนี้เกิดขึ้นจริง"

- **log ของ EVM ไม่อยู่ใน state** cosmos/evm เก็บ bloom และ receipt ไว้ใน object store ชั่วคราว receipt ที่ JSON-RPC ส่งให้นั้น
  โหนดประกอบขึ้นใหม่ ไม่ได้ผูกมัดอยู่ใน `app_hash`
- **`last_results_hash` ผูกมัด log ได้แบบอ้อม ๆ** มันคือราก Merkle ของ `ExecTxResult` ส่วนที่กำหนดแน่นอน (code, data, gas wanted,
  gas used) และ `data` คือ `TxMsgData` ซึ่งมี `MsgEthereumTxResponse` ที่บรรจุ log อยู่ การพิสูจน์ log ทางนี้ต้องถอด protobuf
  ซ้อนหลายชั้น (`TxMsgData → Any → MsgEthereumTxResponse → Log`) ใน Solidity ซึ่งผูกติดกับโครงสร้างข้อความและเวอร์ชันของ
  cosmos/evm ทำได้แต่เปราะ ต้นแบบนี้จึงไม่ใช้ทางนี้
- **ทางที่เลือก: สัญญาผูกมัด** `ZetaphyOutbox` ต่อข้อความแต่ละอันเข้าต้นไม้ Merkle SHA-256 ลึก 32 ชั้น (แบบเดียวกับ deposit
  contract ของ Ethereum) แล้วเก็บ `sha256(treeRoot ‖ count)` ไว้ใน **storage slot 0** ใน cosmos/evm (`x/vm/types/key.go`)
  slot หนึ่งอยู่ใน IAVL store ชื่อ `evm` ที่ key `0x02 ‖ address ‖ slot` และค่า 32 ไบต์ ดังนั้นเส้นทาง `app_hash → (ICS23
  Tendermint ops) → ราก evm store → (ICS23 IAVL ops) → slot 0 → (Merkle path) → ข้อความ` ใช้แต่รูปแบบมาตรฐานที่นิ่งแล้ว
  (ชุดเดียวกับที่ IBC ใช้) header หนึ่งอันพิสูจน์ได้ทุกข้อความที่ส่งก่อนหน้า (เพราะเพิ่มอย่างเดียว) อัปเดตไลต์ไคลเอนต์ครั้งเดียวจึงใช้ได้ทั้งชุด

รูปแบบแต่ละขั้น และสิ่งที่ใช้ตรวจเทียบ:

| ขั้น | รูปแบบ | ตรวจเทียบกับ |
|---|---|---|
| block hash | `Header.Hash()` ของ CometBFT: simple Merkle (ใบ `0x00` โหนดใน `0x01`) บนฟิลด์ protobuf 14 ตัว | **บล็อก 13 และ 14 จริงของ devnet** ใน `fixtures/pqcert-devnet.json` (ทั้ง JS และ Solidity) |
| app_hash ใน header | ฟิลด์ที่ 10 จาก 14: ใบ `0x0a 0x20 ‖ app_hash`, aunts 4 ตัว | บล็อกจริงชุดเดียวกัน; ฟิลด์ 32 ไบต์อื่นที่ตำแหน่งนี้ใช้ไม่ได้ |
| evm store ใน app_hash | ICS23 `TendermintSpec`: ใบ `0x00 ‖ len‖"evm" ‖ 0x20 ‖ sha256(root)`, ops `0x01‖left` / `0x01`+right | `store/internal/maps` ของ Cosmos SDK |
| slot ใน evm store | ICS23 `IavlSpec`: ใบ `zz(0) zz(1) zz(version) ‖ len‖key ‖ 0x20 ‖ sha256(value)`, โหนดใน `zz(h) zz(size) zz(v) 0x20 [left 0x20]` | `writeHashBytes` ของ cosmos/iavl v1.2.8 และกฎ `validateIavlOps` ของ ics23 |
| ข้อความใน outbox | `sha256(abi.encode(tag, srcChainId, outbox, nonce, sender, dstChainId, receiver, sha256(payload)))`, sibling 32 ตัว | รากที่สัญญาคำนวณเอง (JS = Solidity) |

หลักฐาน IAVL/multistore ในการทดสอบต้นจนจบมาจาก state ของ ZETAPHY ที่ **จำลอง** ขึ้นด้วยการเข้ารหัสแบบเดียวกันทุกไบต์ (block hash
และการเข้ารหัส header เป็นของจริง แต่ app hash สังเคราะห์) ขั้นต่อไปคือพิสูจน์กับ `abci_query(prove=true)` ของโหนดจริง
(ops แปลงตรงตัวเป็น `ZetaphyBridgeInbox.StateProof`)

## 2. การตรวจบนเชนและค่าแก๊ส

`StarkVerifier` เล่น transcript Fiat–Shamir ซ้ำด้วย precompile SHA-256 และตรวจทุกอย่างที่ตัวตรวจ JS ตรวจ (composition ที่ z,
การเปิดเผยลายเซ็น, DEEP, Merkle multi-opening ของ trace/set/Q, ทุกชั้นของ FRI, พหุนามสุดท้าย, grinding) ผลทดสอบตรงกับตัวตรวจ JS,
ปฏิเสธไบต์ที่ถูกแก้กว่า 40 ตำแหน่ง, รากชุดผู้ตรวจสอบผิด, chain id ผิด และพารามิเตอร์อ่อน และตรวจหลักฐานของ **ใบรับรองจริงจาก devnet**
(สร้างด้วย Go) ผ่าน

วัดบน EVM ในหน่วยความจำของ repo (Cancun) พารามิเตอร์ตั้งต้น (28 queries, blowup 16, grinding 16 บิต = 128 บิตแบบ conjectured)
"tx total" = 21,000 + calldata (16/4 แก๊สต่อไบต์) + execution (floor ของ EIP-7623 ไม่มีผลในกรณีเหล่านี้):

| ผู้ตรวจสอบ n | โหมด | ขนาดหลักฐาน | ลายเซ็นที่เปิดเผย | execution | calldata | **tx total** |
|---|---|---|---|---|---|---|
| 4 | none | 22.8 KB | 0 | 1.02 M | 0.33 M | **1.37 M** |
| 4 | all | 38.2 KB | 4 | 1.58 M | 0.57 M | **2.18 M** |
| 21 | none | 30.0 KB | 0 | 1.43 M | 0.45 M | **1.89 M** |
| 21 | all | 111.6 KB | 21 | 4.33 M | 1.74 M | **6.09 M** |
| 21 | sample-128 | 112.3 KB | 21 | 4.72 M | 1.75 M | **6.49 M** |
| 100 | none | 44.6 KB | 0 | 2.26 M | 0.68 M | **2.97 M** |
| 100 | sample-128 | 326.7 KB | 73 | 12.87 M | 5.15 M | **18.05 M** |

งานของสะพาน (n = 4, `test/starkbridge.test.js` พิมพ์ตัวเลขออกมา):

| งาน | tx total |
|---|---|
| `StarkLightClient.submit` บล็อก โหมด all (optimistic) | 2.36 M |
| `submit` บล็อก โหมด none (trusted prover) | 1.60 M |
| `submit` handoff โหมด all | 2.30 M |
| `ZetaphyBridgeInbox.release` (IAVL 4 ชั้น + multistore 4 + outbox 32 + โอนโทเคน) | **0.21 M** |
| `challenge` (โต้แย้งลายเซ็น ML-DSA-44 หนึ่งอัน) | **≈ 14.3 M** (ประมาณ ดูด้านล่าง) |
| `submitChecked` บล็อก ตรวจ ML-DSA 4 อันทันที | ≈ 59 M (ประมาณ) เกินหนึ่งบล็อก |

**ข้อสรุป: ตรวจ STARK ครบบนเชน ไม่ต้องมีเกมแบ่งครึ่ง (bisection) ของ FRI** ทุกกรณีข้างบนใส่ในบล็อก 30 M แก๊สได้ (เพดานของ mainnet
วันนี้สูงกว่านั้น) กรณีหนักสุดคือ n = 100 ที่เปิดเผยลายเซ็น 73 อัน (18 M ส่วนใหญ่เป็น calldata ของลายเซ็น) เกมโต้แย้งแบบโต้ตอบรายชั้น
FRI จะเพิ่มแค่ความหน่วงและข้อสมมติเรื่อง liveness เพื่อประหยัดแก๊สที่ไม่จำเป็นต้องประหยัด จะมีประโยชน์ก็ต่อเมื่อหลักฐานโตเกินหนึ่งบล็อก
(ชุดผู้ตรวจสอบใหญ่มากในโหมด all)

**ML-DSA-44 ใน Solidity** (ใน repo ยังไม่มีตัวตรวจ ส่วน precompile `0x…0900` เป็นของเชน ZETAPHY ไม่มีบน Ethereum)
`test/helpers/MLDSACost.sol` วัดสองส่วนที่กินแก๊สมากที่สุดบน EVM ตัวเดียวกัน: Keccak-f[1600] ของเรา (ตรวจเทียบกับ opcode KECCAK256)
**107 k แก๊ส**, NTT 256 จุด mod q **202 k แก๊ส**, คูณทีละตัว 256 ค่า 26 k การตรวจตาม FIPS 204 ต้องใช้ permutation ราว 100 ครั้ง
(แค่ ExpandA ก็ 16 × 5 บล็อกของ SHAKE128 และ SHAKE ไม่ใช่ opcode KECCAK256), NTT ราว 13 ครั้ง, พหุนามคูณทีละตัวราว 24 ตัว
และงานถอดรหัส/ตรวจช่วงราว 4,000 ครั้ง: **ราว 14 M แก๊สต่อหนึ่งลายเซ็น** ด้วยโค้ดตรงไปตรงมาแบบนี้ ถ้าเขียน assembly อย่างหนักอาจลง
ไปได้ 3–7 M (งานสาธารณะรายงานตัวเลขในช่วงนี้ และมีข้อเสนอ precompile ML-DSA แล้ว) ไม่ว่าทางไหน การตรวจลายเซ็นของผู้ลงนาม 67 %
ขึ้นไปตรง ๆ ก็เกินหนึ่งบล็อกไปไกล ลายเซ็นจึงใช้การโต้แย้งด้านล่าง และเป้าหมายจริงคือ Stage B (ตรวจ ML-DSA ภายใน STARK)

## 3. ความเชื่อใจที่ต้องมีในแต่ละโหมด

สิ่งที่ทุกโหมดมีร่วมกัน (Stage A): **หมุด genesis** (32 ไบต์ ตั้งตอน deploy เปลี่ยนไม่ได้), SHA-256 (การชนกัน + Fiat–Shamir;
128 บิตแบบ conjectured / 72 บิตแบบพิสูจน์ได้ด้วยค่าตั้งต้น — ถ้ามีมูลค่าจริงให้ใช้ preset 60 queries), **ผู้ตรวจสอบสุจริตต่อสิ่งที่ตนลงนาม**
(ไลต์ไคลเอนต์ตรวจฉันทามติ ไม่ได้ตรวจการเปลี่ยน state), กฎใบรับรอง PQ 3S > 2T − 3U ตามที่เชนใช้ (ผู้ตรวจสอบที่ไม่มี vote key
ไม่มีลายเซ็น PQ ให้ใครตรวจ) และ **ต้องส่ง handoff ก่อนช่วง unbonding ของชุดเก่าจะหมด** (การโจมตีระยะไกล เหมือนไลต์ไคลเอนต์ PoS
ทุกตัว — ใครจะส่งก็ได้)

| ทางเลือก | การนับพลังชุดผู้ตรวจสอบ | ความถูกต้องของลายเซ็น ML-DSA | ต้องเชื่อเพิ่ม | ความหน่วง | สถานะ |
|---|---|---|---|---|---|
| โหมด `none` เฉพาะ `trustedProver` | พิสูจน์บนเชน | **เชื่อ prover** | prover อาจอ้างผู้ลงนามที่ไม่ได้ลงนาม | หน้าต่าง | ทำแล้ว; ปิดอยู่เว้นแต่ `trustedProver ≠ 0` |
| โหมด `all` / `sample` ผ่าน `submit` (optimistic) | พิสูจน์บนเชน | ลายเซ็นที่เปิดเผยถูกผูกกับการผูกมัดใบรับรองบนเชน; **ลายเซ็นผิดแม้อันเดียวพิสูจน์ได้ด้วย `challenge`** (ธุรกรรมเดียว ≈ 14.3 M แก๊ส); `sample`: แถวที่ไม่เปิดเผยครอบด้วยการสุ่มถ่วงพลัง 128 บิต | **ผู้เฝ้าดูสุจริต 1 คน** และ Ethereum รับธุรกรรมภายในหน้าต่าง; มัดจำ ≥ ค่าโต้แย้ง | หน้าต่าง | ทำแล้ว ทดสอบแล้ว (ลายเซ็นปลอมถูกปฏิเสธ มัดจำตกเป็นของผู้เฝ้าดู) |
| `submitChecked` | พิสูจน์ | ตรวจบนเชนทันที | ไม่มีเพิ่มจาก Stage A | ทันที | ทำแล้ว; ยังไม่คุ้มจนกว่าจะมี precompile ML-DSA (≈ 14 M แก๊ส × ผู้ลงนาม) |
| Stage B (ML-DSA ใน STARK + recursion) | พิสูจน์ | **พิสูจน์** | ไม่มีนอกจาก SHA-256 + หมุด | ทันที | ออกแบบไว้เท่านั้น ([stark-light-client.th.md §5](stark-light-client.th.md)); คาด 2–4 M แก๊ส |

ไม่ว่าโหมดไหนก็ไม่ต้องเชื่อ: relayer, prover (ยกเว้นเรื่องการมาส่งหลักฐาน), โหนด RPC, governance **governance ของ inbox หยุดและ
จำกัดยอดได้ (ทำให้ช้าได้) แต่ปล่อยเหรียญเองไม่ได้** ส่วนไลต์ไคลเอนต์ไม่มีผู้ดูแลเลย

สิ่งที่ยังทำให้ทั้งระบบ *ยังไม่* trustless ตลอดสาย พูดกันตรง ๆ:

1. **เชนยังไม่ผลิตลายเซ็น handoff** (ต้องแก้ vote extension ดูเอกสาร STARK §2 ข้อ 4) ระหว่างนี้ไลต์ไคลเอนต์ตามการเปลี่ยนชุดผู้ตรวจสอบ
   ของเชนจริงไม่ได้ ในการทดสอบลงนาม handoff ด้วยคีย์ทดสอบ
2. ความถูกต้องของลายเซ็นยังเป็นแบบ **optimistic** (ผู้เฝ้าดู 1 ใน N) จนกว่า `submitChecked` จะจ่ายไหวหรือ Stage B เสร็จ
3. หลักฐานฝั่ง ZETAPHY ทดสอบกับ state จำลองที่เข้ารหัสแบบจริง ยังไม่ได้ทดสอบกับโหนดจริง

**พารามิเตอร์หน้าต่างโต้แย้ง** การโต้แย้งเป็นธุรกรรมเดียวไม่ต้องโต้ตอบ (ไม่มีรอบแบ่งครึ่ง) หน้าต่างจึงต้องครอบแค่เวลาตรวจพบ (ไม่กี่วินาที:
ใครก็คำนวณ `ml_dsa44.verify` ซ้ำได้จาก calldata ของการส่ง) และเวลาที่ธุรกรรมจะเข้าบล็อกได้ในสภาพที่ถูกขัดขวาง แนะนำ **24 ชั่วโมง** บน mainnet
(≈ 7,200 บล็อกของ Ethereum เพื่อให้ธุรกรรม 14.3 M แก๊สหนึ่งอันเข้าได้) และ 1 ชั่วโมงบน testnet (การทดสอบใช้ 1 ชั่วโมง) มัดจำควร ≥ 2 เท่า
ของค่าโต้แย้งตอนแก๊สแพง (เช่น 14.3 M × 50 gwei ≈ 0.72 ETH → **มัดจำ 1.5 ETH**) ซึ่งจ่ายให้ผู้โต้แย้งที่ชนะ ถ้ามีแฮชที่สิ้นสุดแล้วสองค่าสำหรับ
ความสูงเดียวกัน (หรือรากสองค่าสำหรับยุคเดียวกัน) แปลว่าสเตกกว่า 1/3 ลงนามขัดกันเอง ไคลเอนต์จะ **แช่แข็ง** (การปักหมุดใหม่เป็นการตัดสินใจของ
ชุมชน อยู่นอกขอบเขต) ฝั่ง inbox: จำกัดยอดรายวัน (guardian ลดได้ทันที governance เพิ่มได้ทีละไม่เกิน ×2 หลังรอ 7 วัน), หยุด (guardian) /
เริ่มใหม่ (governance), และการปล่อยที่ลองใหม่ได้ (ถ้าเกินยอดวันนี้ ธุรกรรมจะ revert แล้วส่งใหม่ได้ภายหลัง)

## 4. Bitcoin

วันนี้ script บน L1 ของ Bitcoin ตรวจ STARK (หรือ SNARK ใด ๆ) ไม่ได้ ทางเลือกตามจริงมีดังนี้

| ทางเลือก | ได้อะไร | ต้องเชื่ออะไร | สถานะ |
|---|---|---|---|
| **peg แบบสหพันธ์/threshold** (เช่น คีย์ FROST/Taproot ของผู้ตรวจสอบ ZETAPHY; แบบ tBTC, Liquid) | BTC ↔ ZETAPHY ได้ทั้งสองทาง | ผู้ลงนาม t จาก n (และความปลอดภัยของคีย์); secp256k1 **ไม่ทนควอนตัม** | ทำได้ทันที (repo มี FROST secp256k1); *ใช้ชั่วคราวเท่านั้น* |
| **แบบ BitVM2** ตรวจแบบ optimistic | ถอนออกโดย operator ออก BTC ให้ก่อน แล้วรับเงินคืน เว้นแต่ผู้โต้แย้งจะแสดงใน script ของ Bitcoin (แบ่งหลายธุรกรรม) ว่าคำอ้าง (SNARK/STARK ของ state ZETAPHY) เป็นเท็จ | ผู้โต้แย้งสุจริต 1 คน (ความปลอดภัย), operator สุจริต ≥ 1 (liveness), คณะที่ลงนามกราฟธุรกรรมล่วงหน้าตอนตั้งค่า | ระยะวิจัย/เริ่มใช้งานสำหรับ SNARK (Groth16 ใช้ pairing: ไม่ทนควอนตัม); ตัวตรวจ STARK ใน script ใหญ่กว่ามาก |
| **covenant (OP_CAT, BIP-347; CTV, BIP-119)** | ถ้ามี OP_CAT จะเขียนตัวตรวจ STARK ใน script ได้ (สาธิตแล้วบน signet/ฟอร์ก) → ไลต์ไคลเอนต์ของ ZETAPHY บน Bitcoin จริง ๆ | SHA-256 อย่างเดียว ตรงกับระบบพิสูจน์ของเรา | **ยังไม่เปิดใช้** บน Bitcoin ไม่มีกำหนด |
| **ไลต์ไคลเอนต์ BTC บน ZETAPHY** (ต้นแบบนี้) | ฝาก BTC → ZETAPHY: ZETAPHY ตรวจ header ของ Bitcoin (PoW, ความยาก, MTP) และ SPV | PoW ของ Bitcoin (สายที่หนักที่สุดเท่าที่ถูกส่งมา) + checkpoint; จำนวน confirmation ตามมูลค่า | **ทำแล้ว** (`BtcLightClient.sol`) |

สรุปคือวันนี้ ZETAPHY ทำ **BTC → ZETAPHY แบบลดความเชื่อใจ** ได้ (SPV บน ZETAPHY) ขณะที่ **ZETAPHY → BTC ยังต้องมีผู้ลงนาม**
(peg แบบ threshold) จนกว่าแนวทางแบบ BitVM จะสุกงอมหรือ covenant จะเปิดใช้

`BtcLightClient` ทดสอบด้วย **ข้อมูล mainnet จริง** (`fixtures/btc-mainnet.json` สร้างโดย `scripts/btc-fixture.js` จากไฟล์สาธารณะ —
test vector ของ summa-tx/relays และบล็อก genesis จาก bitcoinjs-lib — แล้วตรวจซ้ำว่า double SHA-256 ของทุก header ผ่านเป้าหมายและเชื่อมกันจริง):
header ต่อเนื่อง 17 อัน (562623–562639), **การปรับความยากจริงที่ 306432** (bits 0x185d859a → 0x1851aba2 คำนวณใหม่จากเวลาในรอบ),
test vector การปรับความยากจาก `pow_tests.cpp` ของ Bitcoin Core (รวมทั้งสองขอบเขต), ปฏิเสธ nonce/bits ที่ถูกแก้ พ่อแม่ที่ไม่รู้จัก และ header ซ้ำ
และหลักฐาน SPV ของธุรกรรมจริงในบล็อก 592920 (index 26, sibling 12 ตัว; index ผิด, confirmation ไม่พอ, ธุรกรรมที่ถูกแก้ และ "ธุรกรรม"
64 ไบต์ ถูกปฏิเสธ) ค่าแก๊ส: **ราว 116 k ต่อ header** (เขียน storage 4 ช่องและไล่หา median-time-past; ราว 16.7 M แก๊สต่อบล็อก Bitcoin
หนึ่งวัน), **ราว 20 k ต่อการตรวจ SPV** ที่ยังไม่ตรวจ: กฎเวอร์ชันของ soft fork, กฎ 20 นาทีของ testnet, ความถูกต้องของธุรกรรม (ตรวจแค่ว่าอยู่ในบล็อก)
ไคลเอนต์ SPV เชื่อว่าสายที่หนักที่สุด *เท่าที่ถูกส่งมาให้* คือ Bitcoin เงินฝากจึงต้องรอ confirmation ตามสัดส่วนมูลค่า

## 5. เทียบกับงานอื่น

| งาน | ฉันทามติของเชนต้นทางที่ตรวจ | หลักฐานบน Ethereum | แก๊ส (ระดับ) | ทนควอนตัม? |
|---|---|---|---|---|
| **ต้นแบบนี้** | ใบรับรอง ML-DSA-44 ของ ZETAPHY: นับพลังชุดผู้ตรวจสอบแบบพิสูจน์; ลายเซ็นแบบ optimistic (Stage A) | STARK ที่ใช้ SHA-256 ตรวจตรง ๆ | 1.4–3 M (none), 2–6 M (all/sample, n ≤ 21) | ใช่ (ใช้แฮช; ลายเซ็น ML-DSA) |
| Succinct (SP1 Tendermint/Helios, Telepathy) | ed25519 ของ CometBFT / sync committee ของ Ethereum ใน zkVM | ห่อด้วย Groth16/PLONK | ≈ 0.25–0.3 M | ไม่ (pairing, ed25519/BLS) |
| IBC ไป Ethereum (เช่น IBC Eureka ที่ใช้ไลต์ไคลเอนต์ CometBFT พิสูจน์ด้วย SP1; CometBLS + Groth16 ของ Union) | ไลต์ไคลเอนต์ CometBFT ใน SNARK | Groth16 | ≈ 0.3 M | ไม่ |
| zkBridge (Polyhedra; deVirgo + Groth16) | ed25519 ของ Cosmos/Tendermint | Groth16 | ≈ 0.23 M | ไม่ |
| Polymer | ฮับที่ใช้ IBC; state ของ rollup ผ่าน settlement/state proof ของ rollup เอง | หลักฐาน state ของ rollup | ต่ำ | ไม่ |
| BitVM / BitVM2 (Bitcoin) | SNARK ของอีกเชน ตรวจแบบ optimistic ใน script ของ Bitcoin | — | ธุรกรรมใหญ่หลายอันเฉพาะตอนโต้แย้ง | ไม่ (Groth16) |

การแลกเปลี่ยนชัดเจน: ห่อด้วย SNARK ถูกกว่าราว 10 เท่า แต่ตั้งอยู่บนข้อสมมติ pairing ที่คอมพิวเตอร์ควอนตัมทำลายได้ เป้าหมายของ ZETAPHY
คือเส้นทางที่ทนควอนตัมตลอดสาย หลักฐานชั้นนอกสุดจึงยังใช้แฮช Stage B + recursion น่าจะลดตัวตรวจ PQ ลงเหลือราว 2–4 M แก๊สต่อการอัปเดต
พร้อมความถูกต้องของลายเซ็นครบถ้วน

## 6. ข้อจำกัดของต้นแบบ

- ยังไม่ผ่าน audit; รูปแบบหลักฐาน v1 ยังไม่ตายตัว; ตัวตรวจ Solidity มีโค้ดราว 17 KB (ต่ำกว่าเพดาน 24 KB)
- ฝั่ง ZETAPHY: multistore/IAVL จำลองที่เข้ารหัสแบบจริง ยังไม่ได้ทดสอบหลักฐาน `abci_query` จากโหนดจริง ทางกลับ (Ethereum → ZETAPHY)
  เป็นภาพสะท้อนของการออกแบบนี้ (ไลต์ไคลเอนต์ของ Ethereum บน ZETAPHY) ยังไม่ได้สร้าง
- ค่าแก๊สของการโต้แย้ง ML-DSA เป็นค่าประมาณจากส่วนประกอบที่วัดจริง ไม่ใช่ตัวตรวจ Solidity เต็มตัว ในการทดสอบใช้ตัวแทนที่เขียนด้วย JS ณ ที่อยู่คงที่
  ซึ่งคิดแก๊สตามค่าประมาณนั้น
- ไลต์ไคลเอนต์รับหลักฐานบล็อกเฉพาะภายใต้ชุดผู้ตรวจสอบ **ปัจจุบัน** (บล็อกของยุคหนึ่งต้องส่งก่อน handoff ของยุคนั้นจะสิ้นสุด); การแช่แข็งหลัง
  ลงนามขัดกันต้องมีการตัดสินใจกู้คืนนอกเชน
- ไคลเอนต์ BTC: ไม่มีการทดสอบฟอร์กด้วยสายจริงที่แข่งกัน (สร้าง PoW ของ mainnet ในการทดสอบไม่ได้); ไม่บังคับกฎเวอร์ชัน; ยังไม่ได้สร้างการถอนออก

ทำซ้ำ: `cd zetaphy-network && npm run build && node --test test/starkbridge.test.js test/btclc.test.js`
(`STARKBRIDGE_FULL=1` เพิ่มแถว n = 100 ใช้เวลาเพิ่มราว 1 นาที)
