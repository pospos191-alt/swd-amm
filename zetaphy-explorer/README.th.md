[English](README.md) | **ภาษาไทย**

# ZETAPHY Explorer (explorer.sawasdeecoin.com)

Block explorer ของเชน ZETAPHY (Cosmos SDK v0.54 + Cosmos EVM v0.7.3, chain id `zetaphy_77390-1`, EVM chain id 77390)
เป็น**เว็บนิ่งล้วน (static site)**: ไม่มีเซิร์ฟเวอร์ ไม่มีฐานข้อมูล ไม่มี indexer เบราว์เซอร์ของผู้ใช้อ่านข้อมูลจาก RPC/REST สาธารณะของโหนดโดยตรง
จึงวางบน Vercel ได้ฟรี

## มีอะไรบ้าง

| หน้า | แสดง |
|---|---|
| หน้าแรก `#/` | chain id, ความสูงบล็อก, อุปทานทั้งหมด (ลดลงเมื่อเผาค่าธรรมเนียมและเผาเหรียญที่ส่งไป `0x…dEaD` พร้อมยอดที่เผาไปใน ~1 ชม.), ยอด stake และสัดส่วน, จำนวน validator และ % พลังโหวตที่มีกุญแจโหวต PQ, บล็อกล่าสุด, ธุรกรรมล่าสุด (แถวใหม่ค่อย ๆ ปรากฏเมื่อมีบล็อกใหม่), **สถานะอัปเดตสด**, **ที่อยู่ที่ติดตาม** พร้อมความเคลื่อนไหว, **สถิติ** (กราฟ SVG ในหน้า) |
| บล็อก `#/block/<เลข>` | header, ผู้เสนอบล็อก (ชื่อ validator), ธุรกรรมพร้อมสถานะ, **ใบรับรองต้านควอนตัม ML-DSA-44** ของบล็อกนี้ (อยู่ใน tx[0] ของบล็อกถัดไป): ผู้เซ็น, พลังที่เซ็นเทียบกับที่ต้องการ และ**ตรวจลายเซ็นจริงในเบราว์เซอร์** ด้วย `zetaphy-network/src/pqcert.js` |
| ธุรกรรม `#/tx/<hash>` | EVM: **สรุปเป็นภาษาคนพร้อมธงความเสี่ยง**, from/to/value/gas/fee/status, **ถอดอินพุต log และสาเหตุ revert**, **การเรียกภายใน**, **ยอดคงเหลือที่เปลี่ยน**, แก๊สและส่วนของค่าธรรมเนียมที่เผา (ดูด้านล่าง) ถอดการโอน ERC-20 / ERC-721 / ERC-1155 (Transfer, TransferSingle, TransferBatch) · Cosmos: ถอดทุกข้อความ รวมข้อความของ ZETAPHY (`MsgEVMCall`, `MsgQuantumLock`, `MsgPQVoteKey`, `MsgPQCertificate`, `MsgSetPQEvidence`), ชนิดกุญแจผู้เซ็น (ML-DSA-44), memo, ค่าธรรมเนียม, events |
| ที่อยู่ `#/address/<0x… หรือ zetaphy1…>` | ทั้งสองรูปแบบ (20 ไบต์เดียวกัน), ยอด, nonce / sequence, เป็นสัญญาหรือไม่, บัญชี ML-DSA-44, **ล็อกควอนตัม** (ช่อง `quantumLockedTo` ของ `zetaphy_pqAccount`), เหรียญอื่น, ยอด stake, ยอดโทเคน, สถานะใน **ThreatRegistry**, **ประวัติทั้งหมด** (ทุกบล็อก จากดัชนีธุรกรรมของโหนด) พร้อมตัวกรองเข้า/ออกและประเภท, โหลดเพิ่ม และส่งออก CSV, แท็บ **การโอนโทเคน**, **ติดตาม / ตั้งชื่อเล่น**; ถ้าเป็นสัญญาจะมี **การ์ดสัญญา** (ซอร์ส / อ่าน / เขียน / proxy ดูด้านล่าง) |
| สด `#/live` | บล็อกใหม่ทันทีที่สร้าง (websocket หรือ polling), **ธุรกรรมที่รอดำเนินการ** (`num_unconfirmed_txs` และ `unconfirmed_txs` ถ้าโหนดเปิดให้), **ติดตามธุรกรรม** จนยืนยัน |
| โทเคน `#/token/<0x…>` | ERC-20 / ERC-721 / ERC-1155: ชื่อ, สัญลักษณ์, ทศนิยม, อุปทาน, ลิงก์รายงาน Neuro (ตั้ง URL ได้), ThreatRegistry, การโอนล่าสุด, การ์ดสัญญา |
| Validator `#/validators` | พลังโหวต, สถานะ, ค่าคอมมิชชัน, **ลงทะเบียนกุญแจโหวต PQ แล้วหรือยัง** (อ่านสโตร์ `zetaphypq` ด้วย `abci_query`), อัปไทม์, ค่า Nakamoto, เรียง/กรอง; หน้าของแต่ละ validator: ดู "หน้าเพิ่มเติม" ด้านล่าง |
| ธรรมาภิบาล, ผู้ถือ, NFT, ค่าแก๊ส, เครื่องมือ | `#/gov`, `#/token/<0x…>/holders`, `#/nft/<0x…>`, `#/gas`, `#/tools`: ดู "หน้าเพิ่มเติม" ด้านล่าง |
| ตั้งค่า `#/settings` | URL ของโหนด (เก็บในเบราว์เซอร์นี้), ThreatRegistry, URL รายงาน Neuro, จำนวนบล็อกที่สแกน |

ช่องค้นหารับ: เลขบล็อก, hash ธุรกรรม (EVM `0x…` หรือ Cosmos hex), hash บล็อก, ที่อยู่ `0x…` / `zetaphy1…`, `zetaphyvaloper1…`

ภาษาไทย/อังกฤษ (ปุ่ม EN/ไทย), ธีมสว่าง/มืด, ใช้บนมือถือได้ (ตารางกลายเป็นการ์ด)

### ไม่มี indexer (แต่ประวัติยังย้อนได้ทุกบล็อก)

**ประวัติของที่อยู่ใช้ดัชนีธุรกรรมของโหนดเอง** ซึ่งครอบคลุมทุกความสูง หน้าที่อยู่ถาม `tx_search` ของ CometBFT
ด้วยคำค้นตามเหตุการณ์ ใหม่สุดก่อน (`order_by "desc"`, `per_page 100`) แล้วรวมหน้าเข้าด้วยกัน:

| คำค้น | หาอะไร |
|---|---|
| `message.sender='<zetaphy1…>'` | ข้อความ Cosmos ที่ที่อยู่นี้ลงนาม |
| `message.sender='<0x… EIP-55>'` | ธุรกรรม EVM ที่ส่ง (Cosmos EVM ใส่ผู้ส่งแบบ 0x ในเหตุการณ์ `message`) |
| `transfer.sender='<zetaphy1…>'` | เหรียญที่ส่งออก (รวมค่าธรรมเนียม) |
| `transfer.recipient='<zetaphy1…>'` | เหรียญที่ได้รับ |
| `ethereum_tx.recipient='<0x… EIP-55>'` | ธุรกรรม EVM ที่ส่งมาหา |

- ใส่ในคำค้นได้เฉพาะที่อยู่ที่ตรวจแล้ว (bech32 แบบมาตรฐานที่ checksum ถูก หรือ 0x แบบ EIP-55) สิ่งที่พิมพ์เข้ามาจึงเปลี่ยนคำค้นไม่ได้
- ธุรกรรมจะแสดงเมื่อไม่มีคำค้นใดที่ยังอาจมีธุรกรรมใหม่กว่า รายการที่รวมแล้วจึงไม่มีช่องว่าง และธุรกรรมที่พบจากหลายคำค้นแสดงครั้งเดียว
  หน้าเว็บบอก "ทั้งหมด N ธุรกรรม" (ตรงทุกตัวเมื่อโหลดครบ ก่อนหน้านั้นเป็นช่วงจากคำค้นที่มากที่สุดถึงผลรวมทุกคำค้น)
- ตัวกรอง (เข้า / ออก; โอน, สเตก, EVM, IBC, ธรรมาภิบาล) และ**การส่งออก CSV** ใช้กับรายการที่โหลดแล้ว CSV สร้างในเบราว์เซอร์และบันทึกด้วย Blob
  (ไม่มีเซิร์ฟเวอร์) ช่องที่ขึ้นต้นด้วย `=`, `+`, `-`, `@`, แท็บ หรือ CR จะเติม `'` ข้างหน้า สเปรดชีตจึงไม่รันเป็นสูตร
- **ถ้าโหนดปฏิเสธคำค้นตามเหตุการณ์** (ปิด tx index หรือจำกัด `index-events` ใน `app.toml`) หน้าเว็บจะกลับไปใช้การสแกนด้านล่างและบอกไว้
  ("เฉพาะบล็อกล่าสุด · สแกน" พร้อมข้อความผิดพลาดจากโหนด)
- **แท็บการโอนโทเคน:** `eth_getLogs` ที่มีที่อยู่ใน topic 1 หรือ topic 2 (`Transfer` ของ ERC-20 / ERC-721) และ `TransferSingle` / `TransferBatch` ของ ERC-1155
  อ่านย้อนหลังทีละ **500 บล็อก** (ขีดจำกัดของโหนดสาธารณะ) ปุ่ม "สแกนบล็อกเก่ากว่า" อ่านย้อนต่อ และส่งออก CSV ได้

**อัปเดตสด:** บล็อกใหม่มาจาก websocket เมื่อใช้ได้: ลอง CometBFT `wss://<node>/rpc/websocket` ก่อน (`subscribe tm.event='NewBlock'` ได้ธุรกรรมของบล็อกมาด้วย)
แล้ว EVM `wss://<node>/ws` (`eth_subscribe newHeads`) ถ้าไม่ได้จะถาม `status` ทุก 6 วินาทีขณะแท็บเปิดอยู่ หน้าเว็บบอกว่าใช้แบบไหน ("สด · …")
rpc-guard ของโหนดสาธารณะปิด websocket ของ CometBFT และ `unconfirmed_txs` ที่นั่น explorer จึงใช้ socket ของ EVM และแสดงเฉพาะจำนวนธุรกรรมที่รอ
(`num_unconfirmed_txs`) เปิด socket เฉพาะไปยังโหนดใน `config.json` ซึ่ง origin `wss://` อยู่ใน CSP โหนดที่ตั้งในหน้าตั้งค่าใช้ polling

**รายการติดตามและชื่อเล่น:** ที่อยู่ที่ติดตามพร้อมชื่อเล่น และธุรกรรมที่ติดตาม เก็บใน localStorage ของเบราว์เซอร์นี้เท่านั้น (ทุกครั้งอยู่ใน try/catch
และตรวจค่าที่เก็บใหม่ทุกครั้งที่อ่าน) หน้าแรกแสดงที่อยู่ที่ติดตามพร้อมความเคลื่อนไหวในบล็อกที่สแกน มีข้อความแจ้งบนหน้าเว็บเมื่อที่อยู่ที่ติดตาม
อยู่ในบล็อกใหม่ หรือเมื่อธุรกรรมที่ติดตามเข้าบล็อก ชื่อเล่นจะแสดงแทนที่อยู่แบบย่อในลิงก์ (เฉพาะเบราว์เซอร์นี้)

**สถิติ** (หน้าแรก) จาก `min(scanBlocks, 100)` บล็อกล่าสุด: ธุรกรรมต่อบล็อก, เวลาต่อบล็อก, % แก๊สที่ใช้และค่าธรรมเนียมพื้นฐานต่อบล็อก (เรียก `eth_feeHistory` ครั้งเดียว),
ที่อยู่ที่ใช้งานมากที่สุด เป็น SVG ในหน้าที่ใช้ class เท่านั้น (ไม่มี inline style ผ่าน CSP) ทุกกราฟมีคำอธิบายสำหรับโปรแกรมอ่านหน้าจอและตารางตัวเลข

ธุรกรรมล่าสุดและยอดโทเคนยังได้จากการ**สแกน N บล็อกล่าสุดในเบราว์เซอร์** (ค่าเริ่มต้น 100 บล็อก ≈ 8 นาทีที่บล็อกละ ~5 วินาที, ตั้งได้ 1–1000)
หน้าเว็บบอกช่วงที่สแกนทุกครั้ง ธุรกรรมที่เก่ากว่านั้นเปิดได้ด้วย hash หรือเลขบล็อก แต่จะไม่ขึ้นในรายการ "ธุรกรรมล่าสุด" ของที่อยู่

- อ่านธุรกรรมเป็นช่วงละ 50 บล็อก (`tx_search` ของ CometBFT ตามช่วงความสูง) ช่วงที่จบแล้วเก็บแคชไว้ จึงถามเฉพาะช่วงบนสุดซ้ำ
  ถ้าโหนดปิด tx index ไว้ จะอ่านทีละบล็อกแทน (จำกัดไม่เกิน 40 บล็อกต่อรอบ)
- ยอดโทเคนของที่อยู่ หาจากอีเวนต์ Transfer ในช่วงเดียวกัน (`eth_getLogs`) แล้วอ่าน `balanceOf` สด
  (log ของ `MsgEVMCall` ไม่อยู่ใน `eth_getLogs` ตาม README ของ zetaphy-chain จึงอาจไม่ครบ)
- ทุกคำขอผ่านคิวเดียว: พร้อมกันไม่เกิน 4 คำขอ, ไม่เกิน 8 คำขอ/วินาที, แคชในหน่วยความจำ (บล็อกและธุรกรรมที่ยืนยันแล้วเก็บนาน ข้อมูล "ล่าสุด" หมดอายุใน 4 วินาที), คำขอซ้ำที่กำลังรอใช้คำตอบเดียวกัน
- หน้าแรกรีเฟรชเมื่อมีบล็อกใหม่จากการอัปเดตสด (websocket หรือ polling) เฉพาะตอนแท็บเปิดอยู่

### กิจกรรมเดือนนี้

หน้าแรกแสดงจำนวนธุรกรรมเดือนนี้แยกประเภท (การโอน, staking, ข้ามเชน, EVM และสัญญา, การโหวต/ข้อเสนอ)
และยอดรวมตั้งแต่เริ่มเชน จากตัวเลขที่ Neuro นับวันละครั้ง (`chainStatsUrl` ค่าเริ่มต้น
`https://neuro.sawasdeecoin.com/api/chain-stats` เว้นว่าง = ไม่แสดง) อ่านครั้งเดียวต่อการเปิดหน้า ไม่ได้ยิงโหนด

### ใบรับรองต้านควอนตัม (ML-DSA-44)

บล็อก H+1 มี tx[0] = `MsgPQCertificate` ที่รวมลายเซ็น ML-DSA-44 ของ validator สำหรับบล็อก H หน้าบล็อกเรียก `verifyBlock` ของ
`zetaphy-network/src/pqcert.js` (bundle มาใน `vendor/zetaphy-lib.js`) ซึ่ง:
ตรวจ header และ data hash ของบล็อกกับ hash ที่เซ็น, อ่านชุด validator และกุญแจโหวตที่ความสูง H, ตรวจลายเซ็นทุกอันด้วย `@noble/post-quantum`
แล้วใช้กติกาเดียวกับโหนด: `3 × พลังที่เซ็น > 2 × พลังทั้งหมด − 3 × พลังที่ไม่มีกุญแจ`

ข้อจำกัด: พลังโหวตและกุญแจโหวตอ่านจากโหนดเดียวกัน (ไม่ได้ปักหมุด) โหนดที่ไม่ซื่อจึงส่งกุญแจปลอมมาคู่กับลายเซ็นปลอมได้
ป้ายผลจึงเขียนว่า "ใบรับรองถูกต้องตามกุญแจ validator ของโหนดนี้" (ไม่ใช่ "ใบรับรองถูกต้อง" เฉย ๆ) และแสดงหมายเหตุความน่าเชื่อถือ (`pqTrust`)
ไว้ติดกับป้ายผลเสมอ ถ้าต้องการตรวจโดยไม่เชื่อโหนดใด ใช้ `zetaphy pq verify-block --pin` ใน zetaphy-network

### ThreatRegistry (Neuro)

ใช้ตรรกะเดียวกับกระเป๋าและ snap (`zetaphy-network/src/vaccine.js`): ตรวจตัวที่อยู่ (`isAddressFlagged/Enforced`),
โค้ดทั้งไบต์ (`isCodeFlagged/Enforced`), ลายนิ้วมือ Neuro fp1 (`isFlagged/Enforced`) และโค้ดหลัง proxy (EIP-1167, EIP-1967, beacon)
ถ้าติดธง แสดงแบบข้อเท็จจริงเท่านั้นตาม `docs/LEGAL.md`: "ติดธงโดยผู้รัน Neuro", หมวด (ข้อความกลางของ `REASON_TEXT`),
หลักฐาน (reportHash, URI, ผู้ให้, เวลา), คำชี้แจงของเจ้าของ (`responseAt`), วิธีตรวจซ้ำ และข้อความ
**"ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา"** ทุกครั้ง ถ้าอ่าน registry ไม่ได้ จะไม่แสดงผลใด ๆ (ไม่เดา)
ถ้ายังไม่ได้ตั้งที่อยู่ ThreatRegistry หน้าเว็บบอกว่า "ไม่ได้ตรวจ"

### หน้าธุรกรรม EVM (ดูละเอียด) และการ์ดสัญญา

| ส่วน | แสดงอะไร | มาจากไหน |
|---|---|---|
| สรุป | หนึ่งบรรทัดเป็นภาษาคน: "0xab… แลก 10 ZETAPHY เป็น 1,234 SWD บน ZetaphyRouter", "ส่ง 1.5 SWD ให้ …", "โอน NFT 5 ชิ้น", "อนุญาตให้ … ใช้ … ได้ไม่จำกัดจำนวน", การสร้างสัญญา, ความล้มเหลว | อินพุตที่ถอดแล้ว + log การโอนโทเคน + การเคลื่อนของเหรียญหลัก (prestate diff ถ้าไม่มีใช้ call trace ถ้าไม่มีอีกใช้มูลค่าของธุรกรรม) |
| ธงความเสี่ยง ⚠ | `approve` / `increaseAllowance` แบบไม่จำกัด (≥ 2^96−1 กฎเดียวกับ `wallet-safety.js`), `setApprovalForAll(true)`, การอนุญาตเดียวกันที่เห็นใน log `Approval` / `ApprovalForAll` ของผู้ส่ง (multicall, permit), สัญญาที่ถูกเรียกหรือผู้ได้รับอนุญาตติดธงใน **ThreatRegistry** (ถ้อยคำเป็นกลาง + ข้อความปฏิเสธความรับผิด) | `txdeep.js`, `threat.js` |
| ข้อมูลอินพุต (ถอดแล้ว) | ชื่อฟังก์ชันและอาร์กิวเมนต์พร้อมชื่อและชนิด (รายการและ struct ซ้อนกัน ที่อยู่เป็นลิงก์) ติดป้าย **ยืนยันแล้ว** / **รู้จัก** / **คาดเดา** (และ "ผ่าน implementation ของ proxy") | 1. ABI ที่ยืนยันแล้วบน **Sourcify** (API v2, เชน 77390, full หรือ partial match) · 2. สัญญาของ repo นี้เอง (`src/known-abi.js` สร้างด้วย `npm run build` จาก artifact ของ zetaphy-network, zetaphy-dex และ zetaphy-nft: เก็บเฉพาะลายเซ็น พร้อม code hash, ลายนิ้วมือ Neuro fp1 ของแต่ละสัญญา และที่อยู่ในบันทึกการ deploy) · 3. ตารางทั่วไปขนาดเล็ก (`src/sigs.js`: ERC-20/721/1155, permit / Permit2, wrapped native, router และ pair แบบ Uniswap-v2, multicall, Ownable / AccessControl, proxy) การคาดเดาต้องถอดแบบเข้มงวดและเข้ารหัสกลับได้ไบต์เดิมทุกไบต์ |
| Log | ถอดทุก log แบบเดียวกัน (topic0 → event, ค่า indexed จาก topic; string/bytes/struct ที่ indexed แสดงเป็น hash), การโอนโทเคนเหมือนเดิม, topic/data ดิบซ่อนไว้ให้กดดู | เหมือนด้านบน |
| สาเหตุที่ไม่สำเร็จ | `Error(string)`, `Panic(uint256)` พร้อมความหมาย (ตัวเลขล้น, หารด้วยศูนย์, ดัชนีเกินขอบเขต, …), custom error ตาม selector (ABI ของสัญญาก่อน แล้วจึงตาราง) หรือ "ย้อนกลับโดยไม่มีเหตุผล" | `output` ของ callTracer; ถ้าไม่มี trace จะรันการเรียกซ้ำบนสถานะก่อนบล็อกของมัน และหน้าเว็บบอกไว้ |
| แก๊สและค่าธรรมเนียม | แก๊สที่ใช้ / เพดาน พร้อม %, ราคาแก๊สที่จ่ายจริง, ค่าธรรมเนียมฐานของบล็อก, ค่าธรรมเนียมสูงสุด / ทิป, ค่าธรรมเนียมเป็น ZETAPHY, ส่วนค่าธรรมเนียมฐาน + ทิป, **เผา (50%)** และ **ให้ validator (50%)** | receipt + `eth_getBlockByNumber`; การแบ่ง 50/50 เป็นกฎของเชนใน `evmd/zetaphy_feeburn.go` |
| การเรียกภายใน | ต้นไม้การเรียก (CALL / DELEGATECALL / STATICCALL / CREATE…), จาก → ถึง, มูลค่า, แก๊สที่ใช้, ฟังก์ชันที่ถอดแล้ว, ข้อผิดพลาด; การเรียกใต้การเรียกที่ล้มเหลวถูกทำเครื่องหมายว่าถูกย้อนกลับ; รายการการโอน ZETAPHY ภายใน | `debug_traceTransaction` กับ `callTracer` ถ้าโหนดไม่มี trace: "โหนดนี้ไม่เปิด trace" (ไม่ปลอมข้อมูล) |
| ยอดคงเหลือที่เปลี่ยน | ใครได้ ใครเสีย: ยอดเหรียญหลักก่อน / หลังของแต่ละที่อยู่, ส่วนต่างโทเคนของแต่ละผู้ถือ (ERC-20, id ของ ERC-721, id ของ ERC-1155) | `prestateTracer` กับ `diffMode` ถ้าไม่มีใช้ call trace ถ้าไม่มีอีกใช้มูลค่าของธุรกรรม; โทเคนจาก log ของ Transfer |

การ์ดสัญญา (หน้าที่อยู่ที่เป็นสัญญา และหน้าโทเคน):

| แท็บ / แถว | แสดงอะไร |
|---|---|
| สถานะ | **ยืนยันแล้ว · full / partial match** บน Sourcify หรือ **รู้จัก** (สัญญาของ repo นี้ จับคู่ด้วยที่อยู่ที่ deploy, code hash ตรงทุกไบต์ หรือลายนิ้วมือ fp1) หรือคาดเดาจาก selector หรือ **ยังไม่ยืนยัน**; กรณี "ติดต่อ Sourcify ไม่ได้" แยกจาก "ยังไม่ยืนยัน" |
| ผู้สร้าง | ผู้ deploy, ธุรกรรมที่สร้าง และบล็อก เมื่อ Sourcify มีข้อมูล (ไม่มี indexer จึงไม่แสดงถ้าไม่มี) |
| Proxy | slot ของ EIP-1967 implementation / admin / beacon (beacon → `implementation()`), minimal proxy EIP-1167 (และแบบ PUSH0): ลิงก์ไป implementation และใช้ ABI ของมันในการถอดรหัสและแท็บอ่าน / เขียน |
| โค้ด | ไฟล์ซอร์ส (แสดงเป็นข้อความเท่านั้น), คอมไพเลอร์, ภาษา, ลิงก์ Sourcify; ถ้าไม่มีแสดง runtime bytecode และวิธียืนยัน |
| อ่าน | ทุกฟังก์ชัน `view` / `pure` ฟอร์มละฟังก์ชัน เรียก `eth_call` ผ่านคิวของโหนด ถอดค่าที่คืน; ฟังก์ชันที่ไม่มีอาร์กิวเมนต์อ่านทันทีเมื่อเปิดแท็บ; ถอด revert ให้ |
| เขียน | ทุกฟังก์ชัน `nonpayable` / `payable` ผ่านกระเป๋าของผู้ใช้เอง (`window.ethereum`): ตรวจ chain id 77390 (ขอให้สลับ), จำลองด้วย `eth_call` ก่อน (อธิบาย revert ก่อนกระเป๋าเปิด), ถามเชนอีกครั้งก่อนลงนาม, แล้วแสดง **กล่องยืนยันของ wallet-safety** (`sf.confirmTx` แบบเดียวกับ DEX / NFT / hub) แล้วจึง `eth_sendTransaction` เว็บไม่ถือกุญแจใดๆ |

อ่าน Sourcify จากเบราว์เซอร์โดยตรง (`https://sourcify.dev/server`) ซึ่ง `connect-src 'self' https:` อนุญาตอยู่แล้ว
ถ้าล็อก `connect-src` ไว้เฉพาะโหนดของตัวเอง ให้เพิ่ม `https://sourcify.dev` ด้วย (ไม่อย่างนั้นการ์ดสัญญาจะแจ้งว่าติดต่อ Sourcify ไม่ได้)

### ความปลอดภัย

- ไม่ใช้ `innerHTML` (หรือ sink อื่น) กับข้อมูลใด ๆ: สร้าง DOM ด้วย `textContent` ผ่าน `src/dom.js` (ลิงก์ได้เฉพาะ `#/…` หรือ `https:`)
- ข้อความจากเชน (ชื่อ/สัญลักษณ์โทเคน, moniker, memo, events, คำชี้แจง) ตัดอักขระควบคุม, อักขระกลับทิศ (bidi เช่น U+202E), zero-width ออก และจำกัดความยาว (`safeText` ใน `src/format.js`)
- CSP ใน `vercel.json`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://ipfs.io; connect-src 'self' https: https://ipfs.io wss://rpc.sawasdeecoin.com; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` และ header อื่น (HSTS, nosniff, no-referrer, X-Frame-Options)
- ไม่มีสคริปต์หรือฟอนต์จากภายนอก ทุกไลบรารีอยู่ใน `vendor/zetaphy-lib.js` ที่ build จาก repo นี้
- คำขอไปโหนดไม่ส่ง cookie (`credentials: 'omit'`) และรับเฉพาะ URL แบบ `https://` (เว้น `http://localhost` ตอนทดสอบในเครื่อง)

**ทำไม `connect-src` เป็น `https:`:** ผู้ใช้เปลี่ยนโหนดเองได้ในหน้าตั้งค่า CSP จึงต้องอนุญาต host แบบ https ใดก็ได้
ถ้าต้องการล็อกให้ใช้ได้เฉพาะโหนดของเรา แก้ใน `vercel.json` เป็น เช่น `connect-src 'self' https://1-2-3-4.sslip.io`
(ผลคือโหนดที่ผู้ใช้ตั้งเองจะถูกเบราว์เซอร์บล็อก)

## ความสามารถเชิงลึก (ที่ explorer ทั่วไปไม่มี)
ทุกอย่างทำงานในเบราว์เซอร์ (ไม่มี indexer ไม่มีเซิร์ฟเวอร์ ไม่ใช้บริการ AI) บนการสแกนแบบจำกัดช่วงเดียวกับส่วนอื่นของ explorer ยกเว้นเส้นทางเงินที่อ่านต่อได้ทีละที่อยู่ตามต้องการ และทุกหน้าบอกว่าอ่านบล็อกไหนบ้าง
ทุกอย่างทำงานในเบราว์เซอร์ บนการสแกนแบบจำกัดช่วงเดียวกับส่วนอื่นของ explorer (ไม่มี indexer ไม่มีเซิร์ฟเวอร์ ไม่ใช้บริการ AI) และทุกหน้าบอกว่าอ่านบล็อกไหนบ้าง

### เส้นทางเงิน `#/flow/<address>`

ZETAPHY และโทเคนไหลไปที่ไหน ตาม**ทุกทอด**จนกว่าเงินจะหยุด แล้ววาดเป็นกราฟ SVG ในหน้า (`src/flow.js` ไม่ใช้ไลบรารี)
- **ตามรอยเงิน** จะขยายกราฟแบบกว้างก่อน (ทีละทอด ในทอดเดียวกันเริ่มจากยอดโอนออกที่ใหญ่ที่สุด) โดยไม่จำกัดจำนวนทอด จนกว่าข้อมูลที่อ่านจะไม่มีการโอนออกต่อ ทุกสายไปถึงปลายทาง (สัญญา ที่อยู่ศูนย์ / ที่อยู่เผาทิ้ง บัญชีโมดูล บริดจ์ หรือกระดานเทรดที่มีชื่อรู้จัก) หรือคุณกด **หยุด** กดตามรอยอีกครั้งเพื่อไปต่อจากจุดเดิม ลิงก์ `#/flow/<address>?follow=1` จะเริ่มตามทันที
- **คลิกโหนดใดก็ได้** (หรือกด Enter) เพื่อขยายซ้ำกี่ครั้งก็ได้: ผู้รับและผู้ส่งชุดถัดไป แล้วจึงอ่านบล็อกที่เก่ากว่าของที่อยู่นั้น
- ข้อมูลอ่านแยกตามที่อยู่ (ตาราง "ที่อยู่ในกราฟ" บอกช่วงข้อมูลของแต่ละที่อยู่อย่างแม่นยำ): ล็อก Transfer ของโทเคนอ่าน**ทีละ 500 บล็อกด้วย `eth_getLogs`** ย้อนหลังจากบล็อกล่าสุด (ปุ่ม **อ่านบล็อกที่เก่ากว่า** อ่านช่วงถัดไป) การโอน ZETAPHY มาจากบล็อกที่สแกน (`recentTxs` ค่าเริ่มต้น 100 บล็อก) และจาก**ดัชนีธุรกรรมของโหนดตามที่อยู่** (`tx_search` ด้วยคำค้นที่ตรวจแล้วของ `src/history.js`: `message.sender`, `transfer.sender`, `transfer.recipient`, `ethereum_tx.recipient` แบ่งหน้า ถ้าโหนดไม่ให้ค้นตามอีเวนต์ หน้าจะบอกว่า "ใช้เฉพาะบล็อกที่สแกน") เส้นทางไปได้ไกลเท่าที่ข้อมูลอ่านถึงเท่านั้น
- ไม่มีการตัดทิ้งแบบเงียบ ๆ: แต่ละรอบเพิ่มคู่โอนของที่อยู่หนึ่งได้ไม่เกิน 50 ราย (เริ่มจากยอดใหญ่) ที่เหลือนับไว้ข้างที่อยู่นั้นพร้อมปุ่ม **โหลดอีก 50** การโอนแต่ละรายการนับครั้งเดียว (ตัดซ้ำด้วย tx / log) ยอดบนเส้นจึงเท่าเดิมไม่ว่าจะอ่านมาจากฝั่งไหน
- วงวน (เงินวนกลับมายังที่อยู่ที่เคยผ่าน) ถูกตรวจพบ (ส่วนที่เชื่อมกันแบบเข้มข้น) และแสดงเป็นสีส้ม ที่อยู่หนึ่งถูกตามเพียงครั้งเดียว วงวนจึงไม่ทำให้วนไม่รู้จบ
- อ่านง่ายทุกขนาด: กราฟวาดใหม่ระหว่างที่โตขึ้น (เบราว์เซอร์ไม่ค้าง) ทอดที่มีที่อยู่มากจะแสดง 12 รายการที่ใหญ่ที่สุดกับโหนด **"อีก N"** (คลิกแต่ละครั้งแสดงเพิ่ม 50) ย่อทอดใดก็ได้ **เลื่อนและซูม** ด้วยเมาส์ (ลาก, Ctrl + ล้อเมาส์) หรือคีย์บอร์ด (เลือกกราฟแล้วใช้ลูกศร + / − และ 0 เพื่อพอดีจอ) เปลี่ยนเฉพาะแอตทริบิวต์ `viewBox` (ไม่มี inline style ตาม CSP)
- **มุมมองเส้นทาง**: เลือกที่อยู่เพื่อดูเส้นทางที่สั้นที่สุดของเงินจากจุดเริ่มต้นไปถึง (เลือกการโอนที่ใหญ่กว่าก่อน) ไฮไลต์ในกราฟและแสดงเป็นลำดับขั้น
- การจัดวางแบบชั้นที่ให้ผลเหมือนเดิมทุกครั้ง: ขาเข้าซ้าย ขาออกขวา หนึ่งคอลัมน์ต่อทอด เส้นมีจำนวนเงินกำกับ (หนึ่งเส้นต่อคู่ ทุกสินทรัพย์อยู่ใน tooltip) โหนดมีชื่อที่รู้จักและมีสีตามธงใน ThreatRegistry มีตารางแบ่งหน้าของที่อยู่ (พร้อมช่วงข้อมูลและปุ่มต่าง ๆ) และของการโอนทั้งหมด สำหรับโปรแกรมอ่านหน้าจอและมือถือ

### ความเสี่ยงต่อคอมพิวเตอร์ควอนตัม (ส่วนในหน้าที่อยู่, `#/quantum`, `#/quantum/<address>`)

บอกเป็นภาษาง่าย ๆ (`src/quantum.js`): **กุญแจสาธารณะ secp256k1 อยู่บนเชนแล้วหรือยัง** (เคยส่งธุรกรรม EVM — ลายมือชื่อเปิดเผยกุญแจ — หรือธุรกรรม Cosmos เก็บกุญแจไว้) เป็นบัญชี **ML-DSA-44** ไหม มี **ล็อกควอนตัม** ไหม (`zetaphy_pqAccount` `quantumLockedTo`) และควรทำอย่างไร (ย้ายไปบัญชี ML-DSA-44 หรือตั้งล็อก พร้อมลิงก์ไปกระเป๋าใน hub, `hubWalletUrl` ใน config ค่าเริ่มต้น `https://app.sawasdeecoin.com/?tab=wallet`)
ระดับ: บัญชีทนควอนตัม · ล็อกควอนตัมแล้ว · กุญแจสาธารณะเปิดเผยแล้ว · กุญแจยังไม่เปิดเผย · สัญญา (ไม่มีกุญแจ) · ไม่ทราบ (โหนดไม่ตอบ)
แดชบอร์ด `#/quantum` แสดง validator ที่มีกุญแจโหวต ML-DSA-44 (จำนวนและสัดส่วนพลังโหวต) และผู้ส่งในบล็อกที่สแกนแยกตามระดับ พร้อมช่วงบล็อก

### ชื่อที่อยู่ (label)

`npm run build` สร้าง `labels.json` (`scripts/known.js`) จากข้อมูลใน repo นี้: ผลของแต่ละขั้นใน `zetaphy-launch/state/77390.json`, `zetaphy-dex/web/deployments.json`, `zetaphy-nft/web/deployments.json`, `zetaphy-network/deployments/77390.json` (ถ้ามี), `zetaphy-chain/rewards/*-testnet.json`, ไฟล์ Hyperlane ใน `zetaphy-chain/hyperlane/`, บัญชีโมดูล (`sha256(name)[:20]`), precompile (`0x…0800`–`0x…0806`, `0x…0900`–`0x…0902`, ล็อกควอนตัม `0x…5051`, WNATIVE) และ `0x…dEaD`
ไฟล์แรกที่ระบุที่อยู่ได้ชื่อนั้น (ผลเหมือนเดิมทุกครั้ง) แอปโหลดครั้งเดียว ฟังก์ชันลิงก์ที่อยู่ตัวเดียวแสดงชื่อข้าง **ทุก** ที่อยู่ และหน้าที่อยู่แสดงไว้ด้านบน unit test จะล้มถ้า `labels.json` ที่ commit ไว้ไม่ตรงกับข้อมูลล่าสุด

### ติดตามข้ามเชน (หน้าธุรกรรม)

`src/crosschain.js`: ธุรกรรมที่ส่งข้อความ Hyperlane (Saphan) ผ่าน Mailbox ของ ZETAPHY (`Dispatch` + `DispatchId` เฉพาะจากที่อยู่ Mailbox — ใครก็ปล่อยอีเวนต์หน้าตาเหมือนกันได้) หน้าจะแสดง **message id** (`keccak256(message)`) เส้นทางและเชนปลายทาง แล้วถาม RPC สาธารณะของเชนปลายทางว่าส่งถึงหรือยัง (`Mailbox.delivered(id)`) และถึงเมื่อไร (`ProcessId` ในประมาณ 9,000 บล็อกล่าสุด) พร้อมลิงก์ไป explorer ของเชนนั้น ข้อความขาเข้า (`Process` + `ProcessId`) แสดงเชนต้นทางและธุรกรรมต้นทางถ้าหาเจอ
ตารางเชนคือ `crosschain.json` สร้างจาก `zetaphy-chain/hyperlane/saphan-chains.json` (ใช้เฉพาะ URL RPC แบบ https ที่อยู่ในไฟล์นั้น ลองทีละตัว) IBC: แพ็กเก็ตที่ส่ง / รับ / ยืนยันรับ / หมดเวลา จากอีเวนต์ Cosmos พร้อมพอร์ต ช่อง และลำดับ
CSP: `connect-src 'self' https:` อนุญาต RPC เหล่านั้นอยู่แล้ว ถ้าล็อก `connect-src` ไว้เฉพาะโหนดของตัวเอง `npm run build` จะเติม origin ของ RPC ในตารางเชนลงใน `vercel.json` ให้

### ถาม explorer (ช่องค้นหา)

ช่องค้นหาเข้าใจคำถามสั้น ๆ ทั้งภาษาไทยและอังกฤษ ทำงานออฟไลน์ด้วยกฎ (`src/ask.js`) ถ้าไม่เข้าใจจะค้นหาตามปกติ:

| คำถาม | ไปที่ |
|---|---|
| `โอนใหญ่ที่สุดวันนี้` · `largest transfers today` | `#/ask/largest?s=86400`: การโอน ZETAPHY และโทเคนที่ใหญ่ที่สุด |
| `ผู้ถือ ZETAPHY มากที่สุด` · `biggest ZETAPHY holders seen` | `#/ask/holders`: ยอดคงเหลือปัจจุบันของที่อยู่ที่พบในบล็อกที่สแกน (ไม่ใช่รายชื่อผู้ถือทั้งหมด) |
| `ธุรกรรมของ 0x… 30 นาที` · `txs of 0x… last hour` | `#/ask/txs?address=…&s=1800` |
| `ธุรกรรมที่ไม่สำเร็จ` · `failed txs last 200 blocks` | `#/ask/failed` |
| `ที่อยู่นี้ปลอดภัยไหม 0x…` · `is 0x… safe?` | `#/ask/risk?address=…`: สรุปความเสี่ยง Neuro และความเสี่ยงควอนตัม |
| `เงินไหลไปไหน 0x…` · `ควอนตัม 0x…` | `#/flow/0x…` · `#/quantum/0x…` |

ช่วงเวลาแปลงเป็นจำนวนบล็อกด้วยเวลาต่อบล็อกที่วัดได้ (ไม่เกิน 100 บล็อกล่าสุด) และไม่เกิน `maxScanBlocks` (1,000) หน้าจะบอก "เข้าใจว่า: …" และบล็อกที่อ่าน

### ความเสี่ยง Neuro ทุกที่

ทุกที่อยู่และโทเคนที่แสดงในหน้า จะมีป้าย **"Neuro ติดธง · <หมวด>"** เมื่อ ThreatRegistry ติดธง (ธงของที่อยู่ และสำหรับสัญญารวมธงของโค้ดและลายนิ้วมือ) ถ้าไม่ติดธงหรืออ่านไม่ได้จะไม่แสดงอะไร (`src/risk.js`)
การตรวจทำเป็น **ชุด**: ทุกที่อยู่ที่หน้าแสดงภายใน ~30 ms ส่งเป็น JSON-RPC batch เดียว (`evmBatch` ใน `src/rpc.js` ผ่านคิวและแคชเดียวกัน) และอีกชุดสำหรับสัญญา ผลถูกจำไว้ตลอดการเยี่ยมชม ถ้าโหนดไม่รองรับ batch จะถามทีละรายการ
หน้าที่อยู่และหน้าโทเคนมีกล่อง **สรุปความเสี่ยง**: ธงของที่อยู่นั้นเอง (พร้อมข้อความ "ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา" เมื่อติดธง) จำนวนคู่ธุรกรรมล่าสุดที่ติดธง และลิงก์รายงาน Neuro (`neuroReportUrl`) การ์ด ThreatRegistry เต็ม (หลักฐาน คำชี้แจงของเจ้าของ proxy) ยังอยู่ด้านล่าง

## หน้าเพิ่มเติม: validator, ธรรมาภิบาล, ผู้ถือโทเคน, NFT, ค่าแก๊ส, เครื่องมือ, ติดตั้งเป็นแอป

ทุกหน้าอ่านจากโหนดโดยตรง (ไม่มี indexer มีขอบเขต ผ่านคิวเดียวกัน) โค้ด: `src/validators2.js`, `src/gov.js`, `src/holders.js`, `src/nft.js`,
`src/gas.js`, `src/tools.js`, `src/pwa.js` + `sw.js` ส่วน app.js แค่ส่งเส้นทางไปหา (โหลดเมื่อเปิดครั้งแรก)

| หน้า | แสดง |
|---|---|
| Validator `#/validators` | เรียง (ชื่อ, พลังโหวต, ค่าคอมมิชชัน, อัปไทม์, กุญแจ PQ) และกรอง (ข้อความ, active / inactive / jailed), **คอลัมน์อัปไทม์** จากลายเซ็น commit ของ 50 บล็อกล่าสุด, **ค่า Nakamoto** (จำนวน validator น้อยที่สุดที่มีพลัง ≥ 1/3 และแบบนับเฉพาะพลังที่มีกุญแจ PQ) |
| Validator รายตัว `#/validator/<zetaphyvaloper1…>` | อัปไทม์ใน N บล็อกล่าสุด (ลายเซ็น `last_commit` ของแต่ละบล็อก N = 50/100/200), **แถบบล็อกที่พลาด** (SVG ในหน้า หนึ่งช่องต่อบล็อก), ประวัติการลงโทษ (x/slashing `signing_infos` + params: พลาดในช่วง, พักงานถึง, tombstoned), เหตุการณ์ slash/พักงาน (`block_search` ของเหตุการณ์ `slash` ตอนจบบล็อก ต้องเปิด indexer ของโหนด ถ้าไม่มีจะบอก), self-bond, จำนวนผู้มอบหมาย (REST `count_total` นับอย่างเดียว), ค่าคอมมิชชัน (อัตรา สูงสุด เปลี่ยนได้สูงสุด เปลี่ยนล่าสุด) และการเปลี่ยนในอดีต (`tx_search` ของ `MsgEditValidator` จาก operator อัตราจากเหตุการณ์ `edit_validator`), กุญแจโหวต PQ (ลงทะเบียน ตั้งแต่ เปลี่ยนกุญแจ) และ **จำนวนใบรับรองบล็อกในช่วงที่มีลายเซ็น ML-DSA-44 ของมัน** (tx 0 ของบล็อกถัดไป อ่านด้วยตัวถอดรหัสใบรับรองของ explorer ลายเซ็นตรวจที่หน้าบล็อก) |
| ธรรมาภิบาล `#/gov`, `#/gov/<id>` | ข้อเสนอ x/gov v1, สถานะ, **ข้อความถอดรหัสด้วยตัวถอดรหัสของ explorer เอง** (protobuf ของข้อเสนอผ่าน `abci_query /cosmos.gov.v1.Query/Proposal` ถ้าถูกปฏิเสธจะแสดง JSON จาก REST เป็นข้อความธรรมดา), ผลคะแนนพร้อมแถบ % เทียบกับ **องค์ประชุม / เกณฑ์ผ่าน / เกณฑ์วีโต้จาก gov params** (ระหว่างโหวตใช้ `tally` สด และ "ถ้าจบตอนนี้"), นับถอยหลังปิดโหวต/มัดจำ, รายการโหวต (แบ่งหน้า ตัวเลือกแบบถ่วงน้ำหนัก), มัดจำและขั้นต่ำ, ลิงก์ไปผู้ช่วยธรรมาภิบาลของฮับ (`hubGovUrl` ค่าเริ่มต้น `https://app.sawasdeecoin.com/?tab=gov`) เพื่อจำลอง |
| ผู้ถือ `#/token/<0x…>/holders` | เฉพาะ ERC-20: log Transfer ของช่วงล่าสุดที่เลือก (1,000 / 5,000 / 20,000 บล็อก) **ครั้งละ 500 บล็อกด้วย `eth_getLogs` ไม่เกิน 40 ครั้ง** รวมยอดเปลี่ยนของแต่ละที่อยู่ แล้ว **ยืนยันด้วย `balanceOf`** สำหรับผู้ได้รับมากที่สุด + `owner()` + ผู้รับ mint แรก; 25 อันดับแรก, % ของอุปทาน, การกระจุกตัวของ 10 อันดับแรก, แถบการกระจาย, คำเตือนเมื่อเจ้าของ / ผู้รับ mint แรกถือ ≥ 50 % หรือเป็นผู้ถือรายใหญ่ที่สุด หน้าบอกเสมอว่า "ตั้งแต่บล็อก X ถึง Y" |
| NFT `#/nft/<collection>`, `#/nft/<collection>/<id>` | ERC-721 `tokenURI` / ERC-1155 `uri` (เติม `{id}`), metadata จาก `data:`, `ipfs://` (ผ่าน `ipfsGateway` ค่าเริ่มต้น `https://ipfs.io` ตั้งได้ในหน้าตั้งค่า) หรือ https (`http://` ถูกเปลี่ยนเป็น https แบบอื่นปฏิเสธ); id จาก `tokenByIndex` หรือ log Transfer ล่าสุด; เจ้าของ (`ownerOf`), การโอนของ id นั้น |
| ค่าแก๊ส `#/gas` | ค่าธรรมเนียมฐานของบล็อกถัดไป, ช้า / ปกติ / เร็ว = มัธยฐานของทิปเปอร์เซ็นไทล์ 10 / 50 / 90 ของบล็อกล่าสุดที่ไม่ว่าง (`eth_feeHistory`), ค่าใช้จ่ายของการกระทำทั่วไป (ส่ง, ส่ง ERC-20, สวอป, mint NFT, approve; แก๊สโดยประมาณ) เป็น ZETAPHY, ค่าธรรมเนียมฐานที่ถูกเผาใน 20/50/100 บล็อก (ประมาณ: ค่าฐาน × ความเต็ม × gas limit), ตารางรายบล็อก |
| เครื่องมือ `#/tools` | ถอดรหัสธุรกรรม EVM ที่ลงนามแล้ว (legacy / EIP-155, EIP-2930, EIP-1559): ฟิลด์, แฮช, **กู้ผู้ส่งจากลายเซ็น** (secp256k1 จาก `@noble/curves` ใน `vendor/zetaphy-tools-lib.js` โหลดเฉพาะหน้านี้), ทดลองรันด้วย `eth_call` (ไม่ส่งอะไร); **ส่งเข้าเครือข่าย** ด้วย `eth_sendRawTransaction` ได้หลังติ๊กยืนยัน **และ** กดครั้งที่สองเท่านั้น และเฉพาะ chain id 77390; ตรวจลายเซ็น `personal_sign` (EIP-191); ตรวจลายเซ็น **ML-DSA-44** (ตัวตรวจ `@noble/post-quantum` เดียวกับใบรับรองบล็อก); แปลงหน่วย (azetaphy / gwei / ZETAPHY); แปลงที่อยู่ (0x ↔ zetaphy1 ↔ zetaphyvaloper1) |

**metadata ของ NFT ไม่น่าเชื่อถือ:** แสดงเฉพาะข้อความ (ตัดแท็ก ลบอักขระควบคุม/bidi จำกัดความยาว), `external_url` เฉพาะ https,
รูปแสดงด้วย `<img>` เท่านั้น และเฉพาะจาก https, `ipfs://` หรือ `data:image/{png,jpeg,gif,webp,svg+xml,avif,bmp}` (SVG ไม่ว่าจะมีสคริปต์หรือไม่ ไม่ถูกฝังลงหน้าโดยตรง
จึงรันอะไรไม่ได้; SVG ใน `image_data` กลายเป็น `<img>` แบบ `data:image/svg+xml`) รูปผ่าน `https://ipfs.io` โหลดตรง (อยู่ใน `img-src`) รูปบนโฮสต์อื่น
จะถูกดึงเมื่อผู้ชมกด "โหลดรูป" เท่านั้น (ไม่ส่งคุกกี้ ไม่ส่ง referrer ≤ 8 MB เฉพาะ `image/*`) แล้วแสดงจาก URL แบบ `blob:` การดึง metadata ไม่ส่งคุกกี้และจำกัด 256 KB

**ติดตั้งเป็นแอป (PWA):** `manifest.webmanifest` (ไอคอน `icon-192.png` / `icon-512.png` สร้างจาก `logo.svg` ด้วย `npm run icons`) และ `sw.js`
service worker จัดการเฉพาะคำขอ GET ของไฟล์โครงแอปของเว็บนี้เอง (หน้า สไตล์ สคริปต์ ไอคอน): **คำตอบจากโหนด (โฮสต์อื่นทั้งหมด), `config.json` และอย่างอื่น
ไปเครือข่ายตรงและไม่ถูกเก็บ** ใช้เครือข่ายก่อน จึงได้ไฟล์จาก deploy ใหม่ทันที (`skipWaiting` + `clients.claim` ลบแคชเก่า `sw.js` ส่งด้วย
`Cache-Control: no-cache`); ตอนออฟไลน์การเปิดหน้าจะได้ `offline.html` ไม่ลงทะเบียนเมื่ออยู่ในเฟรม (ฮับ) หรือบน http ธรรมดา

**การเปลี่ยน CSP:** `img-src` เพิ่ม `data:` (ภาพ NFT แบบ data:image), `blob:` (รูปที่ดึงเมื่อกด) และ `https://ipfs.io` (gateway เริ่มต้น);
`connect-src` ระบุ `https://ipfs.io` ชัดเจน (ครอบคลุมด้วย `https:` อยู่แล้ว); `worker-src 'self'` สำหรับ `sw.js` ไม่มีโฮสต์สคริปต์หรือสไตล์ใหม่

**ข้อจำกัด (ไม่มี indexer):** อัปไทม์และการมีลายเซ็นในใบรับรองครอบคลุมแค่ N บล็อกล่าสุด (อ่านบล็อกละครั้ง); ประวัติ slash ต้องใช้ `block_search`
ของโหนด (indexer ของ CometBFT) และประวัติค่าคอมมิชชันใช้ `tx_search`; ผู้ถือคือเฉพาะคนที่โอนในช่วงนั้น (ผู้ถือเก่าที่ไม่ขยับจะไม่ถูกพบ)
และการโอนผ่าน `MsgEVMCall` ไม่อยู่ใน `eth_getLogs`; id ของ NFT มาจาก `tokenByIndex` หรือ log ล่าสุด; ค่าที่ถูกเผาเป็นค่าประมาณ; ปริมาณแก๊สเป็นค่าทั่วไป
ข้อความทั้งหมดของหน้าเหล่านี้มีครบทั้ง 8 ภาษาของ explorer (en, zh, es, ko, ja, ru, vi, th; `T_MORE` ใน `src/i18n.js`) และการทดสอบ i18n บังคับให้ทุกคีย์มีครบทุกภาษา
ทดสอบ: `test/explore2.unit.test.js` และ `test/explore2.e2e.js` (`npm test` รันทั้งคู่ ไฟล์ e2e เลือกพอร์ตว่างเอง หรือกำหนด `E2E_PORT` / `E2E2_PORT`)
**แหล่ง `wss://`** ได้มาจาก `node` ใน `config.json` (`https://rpc.sawasdeecoin.com` → `wss://rpc.sawasdeecoin.com`) เมื่อเปลี่ยนโหนดใน `config.json`
ให้แก้ค่านี้ใน `vercel.json` ด้วย (unit test จะไม่ผ่านจนกว่าจะตรงกัน) `npm run serve` สร้างค่านี้จาก config ที่ serve อยู่

## ตั้ง URL ของโหนด (RPC)

ตอนนี้ยังไม่มีโหนดจริง `config.json` จึงเป็นค่าตัวอย่าง `https://<node-host>` และหน้าเว็บจะขึ้นแถบเตือนจนกว่าจะตั้ง

โหนดที่ติดตั้งด้วย `zetaphy-chain/setup-node.sh` มี Caddy เปิด https ให้ที่ `https://<ip แบบขีด>.sslip.io` (ดู `NODE-INFO.txt` บนเซิร์ฟเวอร์) โดย
- `https://<host>/` = EVM JSON-RPC
- `https://<host>/rpc/` = CometBFT RPC (เส้นทางหนักถูกบล็อก)
- `https://<host>/rest/` = Cosmos REST
- Caddy ใส่ CORS (`Access-Control-Allow-Origin *`) ให้แล้ว เว็บนี้จึงเรียกได้โดยตรง

**ให้ทุกคน:** แก้ `config.json` แล้ว commit/deploy

```json
{
  "node": "https://1-2-3-4.sslip.io",
  "threatRegistry": "0x…ที่อยู่ ThreatRegistry บน ZETAPHY (เว้นว่าง = ไม่ตรวจ)",
  "neuroReportUrl": "https://<เว็บ Neuro>/web/?chain=zetaphy&address={address}",
  "scanBlocks": 100
}
```

- `node`: host ของโหนด (explorer ต่อ `/`, `/rpc/`, `/rest/` ให้เอง)
- ถ้า API แยกโฮสต์ ใส่ `evmRpc`, `cometRpc`, `rest` แยกได้ (`cometRpc` และ `rest` ต้องลงท้าย `/` เพราะ Caddy ใช้ `handle_path /rpc/*`)
- `neuroReportUrl`: `{address}` และ `{chainId}` ถูกแทนให้ เว้นว่าง = ไม่แสดงลิงก์
  (หมายเหตุ: เว็บ Neuro ตอนนี้ยังไม่มีเชน `zetaphy` ในรายการ ตั้งค่าเมื่อเว็บรองรับ)

**เฉพาะเบราว์เซอร์ตัวเอง:** เปิดหน้า **ตั้งค่า** (`#/settings`) ใส่ URL แล้วกด "ทดสอบการเชื่อมต่อ" ค่าเก็บใน localStorage ของเบราว์เซอร์นั้น
กด "ใช้ค่าเริ่มต้นของเว็บ" เพื่อกลับไปใช้ `config.json`

## วางบน Vercel (ฟรี)

1. vercel.com → **Add New → Project** → เลือก repo นี้
2. **Root Directory** ตั้งเป็น `zetaphy-explorer` (Framework Preset: Other) ไม่ต้องตั้ง build: `vercel.json` สั่งไว้แล้วว่าไม่ต้อง install/build และให้เสิร์ฟทั้งโฟลเดอร์
   (`vendor/zetaphy-lib.js` commit ไว้แล้ว)
3. **Deploy** แล้วเปิด `https://<project>.vercel.app` ตรวจว่าขึ้นหน้าเว็บและ CSP ทำงาน (DevTools → Network → Response headers)

### ผูกโดเมนย่อย `explorer.sawasdeecoin.com`

1. ที่ผู้ให้บริการ DNS ของ `sawasdeecoin.com` เพิ่มระเบียน
   - Type: `CNAME` · Name/Host: `explorer` · Value/Target: `cname.vercel-dns.com` · TTL: ค่าเริ่มต้น (หรือ 300)
   - ถ้าใช้ Cloudflare ตั้ง Proxy status เป็น **DNS only** (เมฆสีเทา) เพื่อให้ Vercel ออกใบรับรอง SSL ได้
2. ใน Vercel: Project → **Settings → Domains** → **Add** → พิมพ์ `explorer.sawasdeecoin.com` → Add
3. รอจน Vercel ขึ้น "Valid Configuration" (ปกติไม่กี่นาที) ใบรับรอง HTTPS ออกให้อัตโนมัติ

## พัฒนาและทดสอบ

```bash
cd zetaphy-explorer
npm install                # devDependencies: esbuild, @noble/*, playwright-core, ethers (เฉพาะทดสอบ)
npm run build              # สร้าง vendor/zetaphy-lib.js และ src/known-abi.js ใหม่ (เมื่อ pqcert.js / pqtx.js / vaccine.js หรือ artifact ของสัญญาเปลี่ยน) แล้ว commit
npm run build              # สร้าง vendor/zetaphy-lib.js ใหม่ และ labels.json / crosschain.json (เมื่อ pqcert.js / pqtx.js / vaccine.js หรือไฟล์ deployment เปลี่ยน) แล้ว commit
npm run serve              # http://localhost:8095 พร้อม CSP เดียวกับ vercel.json
npm test                   # unit + เบราว์เซอร์ (mock node)
npm run test:devnet        # กับเชนจริง (ดูด้านล่าง)
```

- `npm test` = `test/unit.test.js` (ตัวถอดรหัสธุรกรรม Cosmos/EVM, การโอนโทเคน, ตัวจัดรูปแบบ, config, คิว/แคช, ThreatRegistry, การสแกน, i18n, ตรวจ CSP/sink),
  `test/deep.test.js` (ตัวถอด ABI เทียบกับ ethers, ตารางลายเซ็น, การจำสัญญา, proxy, คำตอบของ Sourcify, ต้นไม้การเรียก, ยอดที่เปลี่ยน, การแบ่งค่าแก๊ส, สรุปและธงความเสี่ยง) และ
- `npm test` = `test/unit.test.js` (ตัวถอดรหัสธุรกรรม Cosmos/EVM, การโอนโทเคน, ตัวจัดรูปแบบ, config, คิว/แคช, ThreatRegistry, การสแกน, i18n, ตรวจ CSP/sink), `test/insight.test.js` (กราฟเส้นทางเงิน ความเสี่ยงควอนตัม label, Hyperlane/IBC, คำถาม, ป้ายความเสี่ยงแบบชุด) และ
  `test/explorer.e2e.js` (Chromium ผ่าน Playwright; ใช้ `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` หรือ `CHROMIUM_PATH`)
  โหนดจำลองใน `test/mock-chain.js` ตอบ `debug_traceTransaction` ด้วย (callTracer, prestateTracer diff; มีหนึ่งธุรกรรมที่ไม่มี trace) และตอบแทน Sourcify (ดักเส้นทาง) ใช้ `EXPLORER_E2E_PORT=…` เพื่อเลือกพอร์ตอื่นเมื่อทดสอบสองชุดพร้อมกัน
  โหนดจำลองสร้างบล็อกที่ hash ถูกต้องจริงและลายเซ็น ML-DSA-44 จริง (มีบล็อกหนึ่งลายเซ็นเสียเพื่อทดสอบว่าถูกปฏิเสธ)
- `npm run test:devnet` เปิดเชน devnet ด้วย `zetaphy-network/scripts/devnet.sh` (binary `/tmp/ci-test/zetaphyd-v4` หรือ `ZETAPHYD=…`) ที่พอร์ต 23545–23648
  รันใต้ `flock /tmp/ci-test/devnet.lock` เสมอ แล้ว: เปิด vote extension, ลงทะเบียนกุญแจโหวต, ส่งธุรกรรม EVM, สร้าง ERC-20, สร้าง ThreatRegistry ให้ runner 2 คนติดธงโทเคน
  และตรวจทุกหน้าในเบราว์เซอร์

## โครงสร้าง

```
index.html  style.css  favicon.svg  config.json  vercel.json  .vercelignore
src/app.js       หน้าและการนำทาง (hash routes)
src/chain.js     สิ่งที่ถามโหนด + การสแกนบล็อกล่าสุด
src/rpc.js       คิว (จำกัดอัตรา/จำนวนพร้อมกัน) + แคช
src/cosmos.js    ถอด TxRaw/TxBody/AuthInfo และข้อความ (รวมของ ZETAPHY)
src/evm.js       ถอดการโอน ERC-20/721/1155, ABI string, raw EVM tx (RLP), อ่านข้อมูลโทเคน
src/threat.js    ThreatRegistry (vaccine.js)
src/abi.js       ตัวเข้า/ถอดรหัส ABI: ลายเซ็น, event, สาเหตุ revert, ค่าจากฟอร์ม
src/sigs.js      ลายเซ็นทั่วไป (ERC-20/721/1155, router, multicall, permit, …)
src/known-abi.js ลายเซ็นสัญญาของ repo นี้ (สร้างด้วย npm run build, scripts/known-abi.js)
src/sigdb.js     ค้นลายเซ็น, จำสัญญาของ repo นี้
src/contract.js  Sourcify, proxy, เลือก ABI, การอ่านสัญญา
src/txdeep.js    วิเคราะห์ธุรกรรม: ถอดรหัส, ต้นไม้การเรียก, ยอดที่เปลี่ยน, แก๊ส, สรุป, ความเสี่ยง (pure)
src/txview.js    ส่วนดูละเอียดของหน้าธุรกรรม (DOM)
src/contractview.js  การ์ดสัญญา: ซอร์ส, อ่าน, เขียน (DOM)
src/format.js    จัดรูปแบบตัวเลข/ที่อยู่/เวลา, safeText
src/dom.js       สร้าง DOM แบบไม่ใช้ HTML
src/history.js   ประวัติที่อยู่ทั้งหมด (คำค้นตามเหตุการณ์ของ tx_search, รวมหน้า), ช่วงการโอนโทเคน, ตัวกรอง, CSV
src/live.js      บล็อกสด (websocket ของ CometBFT / EVM, polling), ธุรกรรมที่รอ, หน้าสด
src/watch.js     รายการติดตาม, ชื่อเล่น, ธุรกรรมที่ติดตาม, ข้อความแจ้ง (localStorage)
src/charts.js    สถิติหน้าแรก (SVG ในหน้า)
src/i18n.js      ข้อความหน้าเว็บ (en, zh, es, ko, ja, ru, vi, th)
src/config.js    ค่าเริ่มต้น, config.json, ค่าในเบราว์เซอร์
src/flow.js      กราฟเส้นทางเงิน (สร้างกราฟ จัดวาง หน้า SVG)
src/quantum.js   ความเสี่ยงควอนตัมของที่อยู่ แดชบอร์ด #/quantum
src/labels.js    ชื่อที่อยู่ที่รู้จัก (labels.json)
src/risk.js      ป้ายความเสี่ยง Neuro แบบชุด กล่องสรุปความเสี่ยง
src/crosschain.js  ข้อความ Hyperlane (การส่งถึงบนเชนปลายทาง) แพ็กเก็ต IBC
src/ask.js       คำถามในช่องค้นหา (ไทย/อังกฤษ แบบกฎ)
src/insight.css  สไตล์ของส่วนข้างบน
scripts/known.js สร้าง labels.json และ crosschain.json (npm run build)
vendor/zetaphy-lib.js  bundle ของ pqcert.js, pqtx.js, vaccine.js และ @noble (สร้างด้วย npm run build)
src/validators2.js  รายการ validator + #/validator/<valoper>   src/gov.js  ธรรมาภิบาล   src/holders.js  ผู้ถือ ERC-20
src/nft.js       NFT gallery   src/gas.js  ค่าแก๊ส   src/tools.js  เครื่องมือ   src/pwa.js  service worker registration
sw.js  manifest.webmanifest  offline.html  icon-192.png  icon-512.png   (โครงแอปที่ติดตั้งได้)
vendor/zetaphy-tools-lib.js  secp256k1 (@noble/curves) สำหรับหน้าเครื่องมือ (npm run build)
```

---

English summary: a static, serverless ZETAPHY block explorer (no database, no indexer). The browser talks to the node's public
EVM JSON-RPC, CometBFT RPC and Cosmos REST (behind Caddy) directly, scans the last N blocks for recent history (bounded, cached,
rate-limited), verifies each block's ML-DSA-44 certificate in the browser with `pqcert.js`, decodes ZETAPHY's custom messages and
EVM token transfers, and shows ThreatRegistry flags in neutral wording with the disclaimer. Deploy on Vercel with Root Directory
`zetaphy-explorer`; point `explorer.sawasdeecoin.com` with a CNAME `explorer` → `cname.vercel-dns.com`, then add the domain in the
Vercel project. Set the node in `config.json` (`node`) or per browser on the Settings page.
