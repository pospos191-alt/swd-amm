# Neuro ZETAPHY — ชั้น 1 (อ่านและอธิบายสัญญา)

งานแรกตาม "แผน ZETAPHY Chain": ตัวอ่านสัญญาที่บอกเป็นภาษาคนว่าสัญญาเหรียญบน
**Ethereum, BNB Chain, Base, Arbitrum, Solana, Sui, Aptos, TON, NEAR, Starknet, Osmosis, Neutron และเหรียญ Runes บน Bitcoin** ให้สิทธิ์อะไรกับเจ้าของบ้าง (สร้างเหรียญเพิ่ม,
บล็อกกระเป๋า, หยุดการโอน, เปลี่ยนภาษี, อัปเกรดโค้ด ฯลฯ) อธิบายได้ 7 ภาษา: ไทย อังกฤษ จีน ญี่ปุ่น เกาหลี
เวียดนาม อินโดนีเซีย ต้นทุน $0

- **อ่านอย่างเดียว**: ใช้แค่ `eth_getCode`, `eth_getStorageAt`, `eth_call` (EVM รวมถึง `eth_call` แบบ
  state override หนึ่งครั้งสำหรับจำลองซื้อขาย ดูด้านล่าง), `eth_gasPrice` และ
  `getGenesisHash`, `getAccountInfo` (Solana), GraphQL แบบ query อย่างเดียว (Sui), GET กับฟังก์ชัน
  `#[view]` (Aptos) และ GET จาก tonapi.io (TON) ผ่าน endpoint สาธารณะฟรี ไม่ขอเชื่อมกระเป๋า
  ไม่มีโค้ดส่งธุรกรรม (`src/rpc.js` ปฏิเสธคำสั่งอื่นทั้งหมด และตรวจว่า endpoint เป็น mainnet จริง)
- **กฎตายตัว ไม่ใช้ AI**: ผลเหมือนเดิมทุกครั้ง มี `reportHash` ให้เครื่องอื่นตรวจซ้ำได้
  (ตามจุดอ่อนข้อ 1 ในแผน: งานต้องตรวจซ้ำได้)
- **ไม่เชื่อข้อความจากสัญญา**: ชื่อ/สัญลักษณ์เหรียญถูกกรองอักขระควบคุมและแสดงเป็นข้อความเท่านั้น
  ชื่อที่มีลิงก์จะได้คำเตือนว่าชื่อนั้นมีลิงก์ ชื่อทุกชื่อแสดง "ตามที่เขียนไว้ในสัญญา" ไม่ใช่คำยืนยันของ Neuro
- **บอกข้อเท็จจริงของโค้ด ไม่ตัดสินคน**: ทุกข้อความบอกว่าโค้ดทำอะไรได้หรือการจำลองให้ผลอะไร
  ไม่ใช้คำอย่าง "หลอกลวง" หรือ "scam" ทุกรายงานมีคำปฏิเสธความรับผิด 7 ภาษา, รหัสรายงาน, รหัสผลตัดสิน
  และคำสั่ง CLI สำหรับตรวจซ้ำ พร้อมลิงก์วิธีชี้แจง/ขอแก้ไข (`web/legal.html`, นโยบายเต็มที่ [`docs/LEGAL.md`](../docs/LEGAL.md))

## ใช้งาน

```bash
npm install
node cli.js bsc 0x...            # อธิบายเป็นภาษาไทย
node cli.js base 0x... --lang en  # English (หรือ zh ja ko vi id)
node cli.js sui 0x...::coin::COIN # เหรียญบน Sui
node cli.js aptos 0x...           # Fungible Asset บน Aptos (หรือ 0x...::module::Name)
node cli.js ton EQ...             # jetton บน TON
node cli.js near token.near        # สัญญา/เหรียญบน NEAR
node cli.js starknet 0x...        # สัญญา Cairo บน Starknet
node cli.js bitcoin DOG•GO•TO•THE•MOON  # เหรียญ Rune บน Bitcoin (หรือรหัส 840000:3)
node cli.js osmosis osmo1...      # สัญญา CosmWasm (Rust) หรือ factory/osmo1.../ชื่อ
node cli.js arbitrum 0x... --json # รายงานเต็ม
npm run web                       # เปิดหน้าเว็บที่ http://localhost:8080/
```

หน้าเว็บ (`web/`) เป็นไฟล์ static ล้วน เบราว์เซอร์ของผู้ใช้เรียก RPC สาธารณะเอง
ลิงก์แชร์ได้: `/web/?chain=bsc&address=0x...` · หน้าสถิติ: `/web/stats.html`

## วางบนเว็บฟรี (Vercel)

1. เข้า vercel.com → **Add New → Project** → เลือก repo นี้
2. **Root Directory** ตั้งเป็น `zetaphy-neuro` (ไม่ต้องตั้ง build ใดๆ มี `vercel.json` แล้ว) → **Deploy**
3. เปิดตัวนับผู้ใช้ (ไม่บังคับ แต่ต้องใช้วัดประตู 1,000 รายต่อเดือน):
   - แท็บ **Storage → Create → Upstash for Redis** (แพ็กเกจฟรี) แล้ว Connect กับโปรเจกต์นี้
     ระบบจะตั้ง `KV_REST_API_URL` และ `KV_REST_API_TOKEN` ให้เอง
   - **Settings → Environment Variables** เพิ่ม `USAGE_SALT` เป็นข้อความสุ่มยาว 16 ตัวขึ้นไป
     (เช่นผลของ `openssl rand -hex 32`) ห้ามใส่ใน repo หรือวางในแชต
   - **Redeploy** แล้วเปิด `/web/stats.html` จะเห็นตัวเลขเดือนนี้เทียบเป้า 1,000

ถ้าไม่ตั้งข้อ 3 หน้าเว็บยังใช้ได้ปกติ แค่ไม่นับผู้ใช้

## ตัวนับผู้ใช้ (`api/usage.js`, `server/usage.js`)

- ไม่เก็บ IP, เบราว์เซอร์ หรือที่อยู่สัญญาที่ตรวจ ผู้ใช้แต่ละคนถูกแปลงเป็นค่า HMAC
  ของ (เดือน, IP, เบราว์เซอร์) ด้วยรหัสลับ แล้วใส่ใน HyperLogLog ซึ่งเก็บแค่จำนวน
  ขึ้นเดือนใหม่ค่าจะเปลี่ยนทั้งหมด จึงโยงข้ามเดือนไม่ได้
- ไม่นับถ้าเบราว์เซอร์ตั้ง Do Not Track หรือ Global Privacy Control
- นับครั้งตรวจได้สูงสุด 200 ครั้งต่อคนต่อวัน ตัวเลขเป็นค่าประมาณ (คลาด ~1%)
  และคนที่เปลี่ยน IP ไปเรื่อยๆ ยังปั่นตัวเลขได้ ให้ใช้เป็นสัญญาณ ไม่ใช่ตัวเลขที่ตรวจสอบแล้ว

## จำเหรียญที่สร้างจาก ZETAPHY launcher

Neuro จำ "แม่แบบโค้ด" ได้ด้วยลายนิ้วมือโค้ด (`src/fingerprint.js`): ปิดค่าที่ต่างกัน
ในแต่ละเหรียญ (ที่อยู่, ค่า immutable) แล้วเข้ารหัสส่วนที่เหลือ เหรียญทุกตัวจากแม่แบบเดียวกัน
จึงได้ค่าเดียวกัน วิธีลงทะเบียน:

```bash
node cli.js fingerprint bsc 0x<เหรียญหนึ่งตัวที่สร้างจาก ZETAPHY บน BNB Chain>
```

คำสั่งจะพิมพ์รายการพร้อมวาง ให้ใส่ใน `src/templates.js` ทำซ้ำสำหรับ Base และ Arbitrum

ไม่ต้องรันคำสั่งก็ได้: ตรวจเหรียญนั้นบนหน้าเว็บ แล้วเปิด "รายละเอียด" จะเห็น
**ลายนิ้วมือโค้ด** (`fp1:...`) ส่งค่านั้นพร้อมเชนและที่อยู่เหรียญมาเพื่อลงทะเบียนได้เลย
เมื่อจำได้แล้ว Neuro จะขึ้นว่า "ตรงกับแม่แบบเหรียญ ZETAPHY" และแสดงกฎภาษีเป็น "ลดได้อย่างเดียว"
(เมื่อใส่ `tax-decrease-only` หลังอ่านโค้ดตั้งภาษีแล้ว) ถ้าโค้ดมีสิทธิ์ที่แม่แบบบอกว่าไม่มี
จะเตือนระดับสูงทันที แทนที่จะเชื่อข้อมูลแม่แบบ

## โค้ดคล้ายโค้ดที่ติดธง และรูปแบบที่ยังไม่รู้จัก

กฎตายตัวจับได้แค่สิ่งที่รู้จักชื่อ โค้ดที่ลอกจากโค้ดที่ติดธงแล้วเปลี่ยนชื่อฟังก์ชัน เพิ่ม getter
หรือย้ายเงื่อนไขนิดหน่อย จะได้ลายนิ้วมือใหม่ Neuro จึงวัดว่าโค้ด **ใกล้** โค้ดในชุดข้อมูลแค่ไหน (`src/similarity.js`)
ยังเป็นกฎตายตัว: ใช้แค่ hash จำนวนเต็ม ไม่ใช้ AI ไม่สุ่ม ทุกเครื่องได้ตัวเลขเดียวกัน

- ตัดข้อมูลของ PUSH ทุกตัว (ที่อยู่ ค่าคงที่ ตำแหน่ง jump) และ metadata ของคอมไพเลอร์ออก เหลือแต่ลำดับ opcode
- ตัดส่วนที่เหรียญสุจริตมีเหมือนกันออก (baseline ใน `scripts/baseline-tokens.sol`: ERC-20 แบบสั้น, ERC-20 + Ownable + mint
  และแบบ OpenZeppelin v5: ERC20, + Pausable, + Permit, + Burnable, + Capped, Ownable2Step, AccessControl และ blacklist ธรรมดา
  คอมไพล์ด้วย solc 0.8.26 ทั้งเปิดและปิด optimizer) ไม่อย่างนั้นโค้ดไลบรารีที่ไม่อยู่ใน baseline จะดันเหรียญสุจริตให้ดูคล้ายเกิน 60% ได้
- เทียบส่วนที่เหลือ: MinHash (128 ค่า) ของชุด opcode 4 ตัวติดกัน และ Jaccard ของ selector ที่เหลือ
  คะแนน = max(opcode, (opcode + selector) / 2) เปลี่ยนชื่อฟังก์ชันจึงหนีไม่พ้น
- คะแนนตั้งแต่ 60% เตือนระดับต่ำ, 75% ระดับกลาง (โค้ดเดียวกันเป๊ะ = 100%) ส่วนที่เหลือของโค้ดต้องมีอย่างน้อย 8 ชุด ไม่งั้นไม่เทียบ
- **เป็นข้อมูลประกอบ ไม่ใช่หลักฐาน:** ระดับสูงสุดคือกลาง ยกเว้นลายนิ้วมือตรงเป๊ะกับรายการที่มีการอ้างอิงธงบนเชน จึงเป็นระดับสูง
- **ถ้อยคำตามที่มา:** ขึ้นว่า "คล้ายโค้ดที่ผู้รัน Neuro ติดธงไว้" (`similar-flagged`) เฉพาะรายการที่อ้างอิงธงบนเชน
  (`flag: { key, reportHash }` คือคีย์ใน ThreatRegistry และ reportHash ของหลักฐานการติดธง) รายการที่ไม่มีการอ้างอิง
  ขึ้นว่า "คล้ายตัวอย่างอ้างอิงในชุดข้อมูลของ Neuro" (`similar-reference`) และบอกชัดว่าไม่ใช่โค้ดที่ติดธง
- **หลบได้:** แทรก opcode ที่ไม่ทำอะไร (เช่น PUSH/POP) ทุก ๆ ไม่กี่คำสั่ง สลับลำดับฟังก์ชัน หรือคอมไพล์ใหม่ด้วย solc
  รุ่นอื่น / ตั้ง optimizer อื่น ก็เปลี่ยน 4-gram ส่วนใหญ่ได้ คะแนนจะต่ำกว่าเกณฑ์ ตรวจไม่พบจึงไม่ได้แปลว่าปลอดภัย
  กฎตายตัวและการจำลองซื้อขายยังทำงานตามปกติ (พิจารณาเพิ่มลักษณะที่สองแบบ selector + โครงสร้าง storage แล้ว
  แต่ selector เทียบอยู่แล้ว และช่อง storage ขยับตามลำดับการสืบทอด จึงไม่คุ้ม ยังไม่เพิ่ม)
- อยู่ใน verdict ที่คนรันร่างต้องตรงกัน เพราะขึ้นกับโค้ดและชุดข้อมูลเท่านั้น (`verdict` และ `reportHash` คงที่)
- ครอบคลุมเฉพาะ EVM bytecode: เชนอื่นอ่านจากค่าตั้งบนเชน ไม่ใช่โค้ด และยังไม่ได้ทำกับ WASM ของ Stylus

ชุดข้อมูลอยู่ในโค้ดเอง (`src/threat-signatures.js`) เพราะ ThreatRegistry เก็บแค่คีย์ ไม่เก็บโค้ด
แต่ละรายการคือลายนิ้วมือ + ลายเซ็นย่อ (selector ที่เหลือ + MinHash) ราว 1 KB + ที่มา (`flag`)
- **ชุดข้อมูลจริงเริ่มต้นว่างเปล่า** ยังไม่มีสัญญาไหนที่ผู้รันร่างติดธง และสัญญาทดสอบไม่ใช่โค้ดที่ติดธง
- ตัวอย่างอ้างอิงสำหรับชุดทดสอบ (ScamToken, QuietHoneypot, NotLaunched, HiddenPowers, Killable ทั้งเปิดและปิด optimizer)
  อยู่ที่ `test/fixtures/reference-samples.generated.js` ใช้ในเทสต์เท่านั้น ไม่อยู่ใน `src/` จึงไม่อยู่ในทักษะ
  สร้างใหม่ทั้ง baseline และตัวอย่างด้วย `npm run threat-signatures` ไม่ดึงอะไรจากเน็ต
- เพิ่มสัญญาที่ติดธงจริงใน ThreatRegistry: ตรวจ `evidenceOf(key)` ก่อน แล้ว
  `node cli.js signature bsc 0x... --reason cannot-sell-in-simulation --flag-key 0x<คีย์> --report-hash 0x<reportHash>` แล้ววางรายการใน `ADDED`
  (`--reason` รับรหัสข้อเท็จจริงของโค้ดใน ThreatRegistry ตาม `src/threat-reasons.js` รายงานแสดงเป็นคำบรรยายที่เป็นกลาง ดู `REASON` ใน `src/lang/*.js`
  ถ้าไม่ใส่ `--flag-key` / `--report-hash` รายการนั้นจะแสดงเป็น "ตัวอย่างอ้างอิง" เท่านั้น)
  ทักษะ (skill id) คือ hash ของ `src/` ทั้งหมด ชุดข้อมูลใหม่ (หรือ baseline ใหม่) จึงเป็นทักษะใหม่ ต้องผ่านโหวตก่อนคนรันร่างจะใช้

สัญญาณ **"Neuro ยังไม่รู้จักรูปแบบนี้ ระวัง"** (ระดับต่ำ): ฟังก์ชันที่ไม่รู้จักชื่อ 2 ตัวขึ้นไป
และเป็นครึ่งหนึ่งขึ้นไปของทั้งหมด (หรือไม่มีฟังก์ชันที่รู้จักเลย) และโค้ดย้ายเงินได้ (CALL, CREATE, SELFDESTRUCT ฯลฯ)
ไม่ได้แปลว่าโค้ดมีปัญหา แต่จะไม่บอกว่า "ไม่พบความเสี่ยง" ทั้งที่ Neuro แค่ไม่รู้จัก

## สิ่งที่ตรวจ

**Solana** (`src/solana.js`) อ่านบัญชีเหรียญ (mint) โดยตรง: สิทธิ์สร้างเหรียญเพิ่ม, สิทธิ์อายัดบัญชี,
ส่วนเสริม Token-2022 (permanent delegate ที่ย้ายเหรียญจากทุกกระเป๋าได้, ภาษีการโอน, transfer hook,
บัญชีใหม่ถูกอายัดตั้งแต่ต้น, หยุดการโอน, ปิด mint ได้), ชื่อเหรียญจาก Metaplex และแก้ชื่อได้หรือไม่,
และสิทธิ์อัปเกรดของโปรแกรม

**Sui** (`src/sui.js`) เหรียญคือชนิด Move `0xแพ็กเกจ::โมดูล::ชื่อ` อำนาจอยู่ในอ็อบเจ็กต์:
ใครถือ `TreasuryCap` (สร้างเหรียญเพิ่มไม่จำกัด), เหรียญแบบควบคุมที่มี `DenyCap` (บล็อกกระเป๋า
และหยุดทั้งระบบได้), ใครถือ `UpgradeCap` (เปลี่ยนโค้ด) และนโยบายอัปเกรด หาได้จากธุรกรรมที่
เผยแพร่แพ็กเกจ แล้วอ่านชื่อฟังก์ชัน public/entry ในโมดูลของเหรียญ (mint, blacklist, pause,
set_fee, burn_from ฯลฯ)

**Aptos** (`src/aptos.js`) รองรับทั้ง Coin แบบเดิมและ Fungible Asset: อ่าน ABI ของโค้ดผู้สร้าง
หาว่าโครงสร้างไหนเก็บ `MintRef`/`MintCapability` (สร้างเพิ่ม), `TransferRef`/`FreezeCapability`
(อายัดและย้ายเหรียญของคนอื่น), `BurnRef`/`BurnCapability` (เผาเหรียญของคนอื่น), `managed_coin`,
โค้ดเสริมตอนฝาก/ถอน (dispatch hook), นโยบายอัปเกรดแพ็กเกจ และชื่อฟังก์ชันเหมือน Sui

**TON** (`src/ton.js`) อ่าน jetton master ผ่าน tonapi.io: สร้างเหรียญเพิ่มได้ไหม, ผู้ดูแลยังอยู่หรือสละแล้ว,
ป้ายเตือน/รายชื่อที่ตรวจแล้วของ tonapi (แสดงว่าเป็นป้ายของ tonapi ไม่ใช่ผลตรวจของ Neuro) และสัญญาที่ถูกแช่แข็ง ตรวจ checksum ของที่อยู่ก่อนเรียกเน็ต
และไม่รับที่อยู่ testnet และตรวจกระเป๋าเหรียญ (jetton wallet) ของผู้ถือรายใหญ่สุด: ถ้า tonapi ไม่รู้จักว่าเป็น
กระเป๋ามาตรฐาน จะเตือนระดับสูง เพราะโค้ดกระเป๋าแบบกำหนดเองปฏิเสธการส่งได้ ทำให้ซื้อได้แต่อาจขายไม่ได้

ข้อจำกัดของ Sui/Aptos: ตรวจจากชื่อฟังก์ชันและข้อมูลบนเชน ยังไม่ได้อ่านเนื้อในทุกฟังก์ชัน

**ภาษาที่ใช้เขียนสัญญา** Neuro อ่านโค้ดที่รันจริงบนเชน ไม่ใช่ซอร์ส จึงขึ้นกับว่าภาษานั้นคอมไพล์เป็นอะไร:

| ภาษา | อ่านอย่างไร |
|---|---|
| Solidity, Yul, Vyper, Huff | EVM bytecode (ไม่สนภาษาต้นทาง) + ซอร์สที่ verify แล้วจาก Sourcify (`src/sourcify.js`) ใช้ตั้งชื่อฟังก์ชันที่ไม่รู้จัก + จำลองซื้อแล้วขายคืนจริงผ่าน DEX หลักของเชน (`src/honeypot.js`) จับเหรียญ "ซื้อได้ ขายไม่ได้" และภาษีแอบแฝงได้ไม่ว่าฟังก์ชันจะชื่ออะไร |
| Rust/C++ บน Arbitrum (Stylus) | แกะโค้ด WASM (brotli) ออกมาอ่าน หา selector ของฟังก์ชันที่รู้จัก (mint, pause, blacklist ฯลฯ) และการเรียก delegate_call/create2 แล้วใช้กฎชุดเดียวกับ EVM (`src/stylus.js`) ถ้าแกะไม่ได้จะบอกว่ายังตรวจไม่ได้ |
| Rust บน Solana (Anchor) | อ่านรายการคำสั่งจาก IDL บนเชน (`src/anchor.js`) หาคำสั่งที่ต้องให้ผู้ดูแลเซ็น และคำสั่งอันตราย |
| Rust บน NEAR | อ่านชื่อฟังก์ชันจาก export ของโค้ด WASM โดยตรง (mint, pause, upgrade ฯลฯ), ดูว่าบัญชีสัญญายังมีกุญแจเต็มสิทธิ์ (ลงโค้ดใหม่ได้) หรือไม่ และข้อมูลเหรียญ NEP-141 (`src/near.js`) |
| Cairo (Starknet) | อ่าน ABI ที่สัญญาเผยแพร่ไว้บนเชน: ชื่อฟังก์ชันและว่าแก้สถานะได้หรือไม่ (mint, pause, upgrade ฯลฯ), เจ้าของ, proxy แบบ Cairo 0 และข้อมูลเหรียญ (`src/starknet.js`) |
| Rust บน CosmWasm (Osmosis, Neutron) | ผู้ดูแลที่เปลี่ยนโค้ดได้ (migrate), ประวัติการเปลี่ยนโค้ด, ผู้สร้างเหรียญ CW20, ผู้ดูแลเหรียญ Token Factory และ before-send hook (`src/cosmwasm.js`) |
| Bitcoin (Runes) | ไม่มีโค้ดสัญญา อ่านกติกาเหรียญจาก ord (ordinals.com ฟรี ไม่ต้องใช้คีย์): ยังเปิด mint อยู่ไหม, premine ของผู้สร้าง, turbo (`src/bitcoin.js`) · BRC-20 ยังไม่รองรับ เพราะ API ฟรีของ Hiro ปิดไปเมื่อ มี.ค. 2026 และที่เหลือต้องใช้คีย์ |
| Move (Sui, Aptos) | ชื่อฟังก์ชันและสิทธิ์ในโค้ด |
| FunC/Tact (TON) | ข้อมูล jetton ที่ tonapi ถอดให้ |

กระเป๋าแบบ EIP-7702 (กระเป๋าธรรมดาที่ตั้งให้รันโค้ดของสัญญาอื่น) จะบอกว่ารันโค้ดของสัญญาไหน
ผู้รันในเครือข่าย Neuro ปิด Sourcify (`sourcify: false`) เพื่อให้คำตัดสินขึ้นกับข้อมูลบนเชนอย่างเดียว

**EVM** (Ethereum, BNB Chain, Base, Arbitrum):

| ผลตรวจ | ระดับ |
|---|---|
| ชื่อเหรียญ (ตามที่เขียนในสัญญา) มีลิงก์/ชื่อเว็บ | สูง |
| อัปเกรดโค้ดได้ (EIP-1967 / beacon / `upgradeTo`) | สูง |
| สร้างเหรียญเพิ่ม, บล็อกกระเป๋า, หยุดการโอน | สูง (ต่ำ ถ้าเจ้าของสละสิทธิ์แล้ว) |
| เปลี่ยนภาษี, สวิตช์เปิดปิดเทรด, เพดานต่อรายการ | ปานกลาง (ต่ำ ถ้าสละสิทธิ์แล้ว) |
| คำสั่ง `SELFDESTRUCT` | สูง |
| `DELEGATECALL` นอก proxy, ระบบสิทธิ์แบบ roles | ปานกลาง |
| สำเนา EIP-1167, เจ้าของปัจจุบัน, ยกเว้นภาษีบางกระเป๋า | ข้อมูล |
| ตรงกับแม่แบบ ZETAPHY ที่ลงทะเบียน | ดี (ภาษีลดได้อย่างเดียว = ต่ำ) |
| สัญญาทางการของ USDT, USDC, WETH ฯลฯ (`src/known-tokens.js`) | ดี และลดสิทธิ์ของผู้ออกเหรียญเหลือ "ต่ำ" พร้อมบอกชื่อผู้ออก |
| ใช้สัญลักษณ์เหมือนเหรียญทางการ แต่ไม่ใช่ที่อยู่ที่ลงทะเบียนไว้ | สูง |
| ตรงแม่แบบแต่มีสิทธิ์ที่แม่แบบบอกว่าไม่มี | สูง |
| จำลองซื้อขาย: ซื้อได้แต่ขายไม่ได้ หรือขายแล้วแทบไม่ได้เงินคืน | สูง |
| จำลองซื้อขาย: ภาษีซื้อหรือขายเกิน 50% | สูง (10% ขึ้นไป = ปานกลาง) |
| จำลองซื้อแล้วขายคืนได้ ภาษีต่ำกว่า 10% ทั้งสองทาง | ดี (พร้อมเตือนว่าเป็นผล ณ บล็อกนี้ เจ้าของอาจเปลี่ยนภายหลัง) |
| ไม่พบ pool บน DEX หลัก / RPC ไม่ยอมให้ override / ซื้อไม่สำเร็จ | ข้อมูล (บอกว่าข้ามการจำลอง ไม่เคยบอกว่า "ปลอดภัย") |

**จำลองซื้อขาย (ทดสอบซื้อแล้วขายคืน, `src/honeypot.js`)** วิธีเดียวกับ honeypot.is แต่ใช้แค่ `eth_call`:
1. หา pool แบบ Uniswap V2 ของเหรียญคู่กับเหรียญหลักของเชนที่ห่อแล้ว (`factory.getPair(token, WETH)`)
   บน DEX หลัก: Uniswap V2 (Ethereum, Base, Arbitrum) และ PancakeSwap V2 (BNB Chain) ตั้งค่าไว้ที่ `dex` ใน `src/chains.js`
2. ถ้ามี pool เรียก `eth_call` ครั้งเดียวพร้อม state override (พารามิเตอร์ตัวที่สาม) วางสัญญาช่วย
   `contracts/TradeSim.sol` ไว้ที่ที่อยู่ทิ้งได้ พร้อมเหรียญหลักเล็กน้อย (ราว 0.01 ETH / 0.05 BNB ±25%) สัญญาช่วยจะ
   ตรวจว่า router ชี้ไปที่ factory และ WETH ที่ถูกต้อง ซื้อผ่าน `swapExactETHForTokensSupportingFeeOnTransferTokens`
   เทียบจำนวนที่ได้กับ `getAmountsOut` (= ภาษีซื้อ) แล้วขายคืน 90–99.9% (สุ่ม) ผ่าน
   `swapExactTokensForETHSupportingFeeOnTransferTokens` เทียบเงินที่ได้กับราคาที่ router บอก (= ภาษีขาย)
   การขายที่ revert ถูกจับด้วย try/catch แล้วรายงานเป็นผล ไม่ใช่ error
3. state override มีอยู่แค่ในการเรียกครั้งนั้น ไม่มีการเซ็นหรือส่งธุรกรรม สถานะบนเชนไม่เปลี่ยน
   ถ้า RPC ไม่รองรับ override หรือไม่มี pool จะบอกว่าข้ามการจำลอง

**ไม่ให้เหรียญจำการทดสอบได้** โค้ดนี้เปิดเผย เหรียญจึงเขียนให้ "ทำตัวดีเฉพาะตอนเห็นการทดสอบของ Neuro" ได้
ถ้าการทดสอบหน้าตาเหมือนเดิมทุกครั้ง (เดิมใช้ที่อยู่ตายตัว `0x4e6575726f53696d…01` / `…02`) ตอนนี้ทุกค่าที่เหรียญมองเห็นได้ถูกเลือกใหม่ทุกครั้ง (`simPlan` ใน `src/honeypot.js`):
- ที่อยู่ของสัญญาช่วยและผู้เรียก (`tx.origin`): ตรวจเดี่ยว (เว็บ, CLI) สุ่มใหม่ทุกครั้ง (`crypto.getRandomValues`, เลี่ยง precompile
  และสัญญาระบบ) งานของเครือข่าย (NeuroJobs) ได้จาก `jobSimSeed(job id, ลอตเตอรีของรอบ)` ซึ่งไม่มีใครรู้ตอน deploy เหรียญ
  ผู้รันทุกคนของรอบเดียวกันจึงทดสอบแบบเดียวกัน และใครก็รันซ้ำได้: `node cli.js bsc 0x… --sim-seed 0x<seed>`
- hash/ขนาดโค้ดของสัญญาช่วย (ต่อท้ายไบต์สุ่มหลัง INVALID), จำนวนที่ซื้อ, สัดส่วนที่ขาย, ยอดเงิน (ไม่เป็นเลขกลม), gas limit
- ราคา gas: `eth_call` ที่ไม่ใส่ราคา gas รันด้วย `tx.gasprice = 0` และ (geth) `block.basefee = 0` ซึ่งธุรกรรมจริงไม่มีทางเป็น
  จึงใส่ราคาจาก `eth_gasPrice` +10–60% และให้ผู้เรียกมีเงินจ่ายค่า gas (ถ้า RPC ไม่ยอม จะลองใหม่แบบไม่ใส่ราคาหนึ่งครั้ง)
- อนุมัติ router แบบไม่จำกัด (เหมือนกระเป๋าส่วนใหญ่) ไม่ใช่จำนวนพอดี
- `test/honeypot.test.js` มีเหรียญ `SimAware` ที่ยอมให้ขายเฉพาะเมื่อเห็นจุดสังเกตแต่ละแบบข้างต้น: แบบเดิมถูกหลอก แบบใหม่จับได้ทุกแบบ

ที่ยังซ่อนไม่ได้ (บอกตรง ๆ): ใน `eth_call` ครั้งเดียว ผู้ซื้อ/ผู้ขายต้องเป็นสัญญา (มีโค้ด) และไม่ใช่ `tx.origin`
เหรียญที่ "ให้เฉพาะสัญญาขายได้" จึงยังหลบได้ (แก้ได้ในอนาคตด้วย `eth_simulateV1` หลายธุรกรรมจากกระเป๋าธรรมดา ถ้า RPC สาธารณะรองรับพอ)
และที่อยู่ของงานเครือข่ายเปิดเผยทันทีที่บล็อกลอตเตอรีออก เจ้าของเหรียญที่เฝ้า NeuroJobs อาจรีบใส่ที่อยู่นั้นใน whitelist ได้ทัน
(ผลจำลองไม่อยู่ในคำตัดสินของเครือข่ายอยู่แล้ว จึงกระทบแค่รายงานของผู้รันคนนั้น)

ไบต์โค้ดของสัญญาช่วยเก็บไว้ใน `src/tradesim.generated.js` (คอมไพล์ด้วย solc 0.8.26 แบบ Paris ไม่มี PUSH0
จึงรันได้ทุกเชน) แก้ `contracts/TradeSim.sol` แล้วรัน `npm run tradesim` (`test/honeypot.test.js` ตรวจว่าตรงกัน)
เหรียญทางการใน `src/known-tokens.js` ไม่ถูกจำลอง ผลจำลองไม่นับในคำตัดสินของเครือข่าย Neuro
(`src/verdict.js`) เพราะขึ้นกับบล็อกและ RPC ของผู้รันแต่ละคน
ข้อจำกัด: จำลองจากสัญญา ไม่ใช่กระเป๋าธรรมดา เหรียญที่กันการซื้อจากสัญญาจะขึ้นว่า "ซื้อไม่สำเร็จ"
และเหรียญที่ห้ามขายเฉพาะในบล็อกเดียวกับที่ซื้อจะขึ้นว่า "ขายไม่ได้" เหมือนกัน (ข้อความบอกข้อจำกัดนี้ไว้) ยังไม่รองรับ pool แบบ V3 หรือ DEX อื่น (เช่น Aerodrome บน Base)

## สองชั้นของกฎ: สาธารณะ (consensus) และเตือนล่วงหน้า (ส่วนตัว)

| | กฎสาธารณะ (`src/`) | เตือนล่วงหน้า (`server/earlywarning.js`) |
|---|---|---|
| ใครรัน | ผู้รันเครือข่ายทุกคน + หน้าเว็บ + CLI | เซิร์ฟเวอร์ของโครงการเท่านั้น (`api/early-warning.js`) |
| กฎอยู่ที่ | repo นี้ (skill id = hash ของ `src/`) | repo ส่วนตัว `pospos191-alt/zetaphy-private` → `rules/pack.json` |
| อยู่ในคำตัดสินบนเชน | ใช่ | **ไม่** เป็นคำแนะนำเท่านั้น |
| ผู้ใช้เห็น | ข้อเท็จจริงของโค้ดเต็ม ๆ | หมวด (reason) ระดับ และรหัสอ้างอิงทึบ `ew-…` ไม่เห็นตัวกฎ |

ทำไม: กฎใหม่ที่เปิดเผยทันทีบอกคนทำเหรียญว่าต้องแก้อะไร แต่กฎ consensus ต้องเป็นโค้ดสาธารณะชุดเดียวกัน
จึงพักกฎใหม่ไว้ในชุดส่วนตัวราว 30 วัน (หรือจนระลอกนั้นซา) แล้วเปิดเผย: กฎแบบ signature ย้ายเข้า `ADDED`
ใน `src/threat-signatures.js` ซึ่งเป็นทักษะใหม่ ต้องโหวต `NeuroControl.approveSkill` นโยบายและรูปแบบกฎอยู่ใน
`zetaphy-private/rules/README.md` (workflow ที่นั่นเปิด issue ทุกสัปดาห์เมื่อมีกฎครบกำหนด)

- ชนิดกฎ: `signature` (ลายนิ้วมือ + MinHash แบบเดียวกับ `threat-signatures.js`, ใช้ `closestFlagged`), `selectors`
  (ชุด selector / ชื่อฟังก์ชันที่มาด้วยกัน), `bytecode` (ไบต์ที่ต้องเจอ หรือลำดับ opcode เช่น `ORIGIN * EQ`) ดูโค้ดหลัง proxy ด้วย
- หน้าเว็บส่งแค่ `{chain, address}` ไป `POST /api/early-warning` หลังตรวจเสร็จ (เฉพาะ EVM) ถ้ามีผลจะขึ้นกล่อง
  "เตือนล่วงหน้า" แยกจากผลตรวจ 7 ภาษา ระดับความเสี่ยงด้านบนไม่เปลี่ยน
- เซิร์ฟเวอร์ไม่เก็บอะไร: จำคำตอบต่อ (เชน, ที่อยู่) ในหน่วยความจำ 5 นาที นับอัตราด้วย HMAC ของ IP ไม่ log ชุดกฎหรือ token

**ตั้งค่าบน Vercel** (Settings → Environment Variables แล้ว Redeploy) เลือกอย่างใดอย่างหนึ่ง:
- `NEURO_RULES_TOKEN` = fine-grained token ของ GitHub ที่เข้าได้เฉพาะ `zetaphy-private` สิทธิ์ **Contents: Read-only**
  (ไม่บังคับ: `NEURO_RULES_REPO` ค่าเริ่มต้น `pospos191-alt/zetaphy-private`, `NEURO_RULES_PATH` ค่าเริ่มต้น `rules/pack.json`)
  เซิร์ฟเวอร์อ่านใหม่ทุก ~10 นาที แก้กฎแล้วไม่ต้อง deploy ใหม่ ถ้าดึงไม่ได้จะใช้ชุดล่าสุดที่ดึงได้ต่อ
- หรือ `NEURO_PRIVATE_RULES` = ตัวชุดกฎเป็น JSON (หรือ base64 ของ JSON) ต้อง Redeploy ทุกครั้งที่แก้
- ไม่ตั้งเลย: ตอบ `{ "warnings": [], "configured": false }` หน้าเว็บทำงานเหมือนเดิม
- การจำกัดอัตรา (12 ครั้ง/นาที, 300 ครั้ง/วัน ต่อ IP) ใช้ Redis ของตัวนับผู้ใช้ถ้าตั้ง `KV_REST_API_*` และ `USAGE_SALT` แล้ว
  (ใช้ร่วมทุก instance) ไม่งั้นนับในหน่วยความจำของแต่ละ instance
- ทดลองบนเครื่อง: `NEURO_PRIVATE_RULES="$(cat ../../zetaphy-private/rules/pack.json)" npm run web`

**ข้อจำกัด (บอกตรง ๆ)**
- ปลายทางนี้ถูกใช้เป็น "เครื่องทาย" ได้: คนทำเหรียญ deploy โค้ดหลายแบบแล้วถามจนไม่ขึ้นเตือน การจำกัดอัตราและ IP
  แค่ทำให้ช้าลง (เปลี่ยน IP ได้) ความลับของกฎจึงมีอายุ ต้องเปิดเผยตามกำหนด
- เตือนล่วงหน้าเป็นคำแนะนำ อาจผิดได้ ไม่อยู่ในคำตัดสินบนเชน และไม่มีใครตรวจซ้ำได้จนกว่ากฎจะเปิดเผย
  (ต่างจากกฎสาธารณะ) ถ้อยคำจึงบอกแค่ว่า "ตรงกับรูปแบบที่เฝ้าดู" และหมวดที่เป็นกลาง ไม่ตัดสินเหรียญ
- ผู้ใช้ต้องเชื่อเซิร์ฟเวอร์ของโครงการสำหรับชั้นนี้ และเซิร์ฟเวอร์เห็นที่อยู่สัญญาที่ถูกตรวจ (ไม่เก็บ)

ข้อจำกัดของกฎชื่อฟังก์ชัน: ตรวจจากชื่อฟังก์ชันที่รู้จัก (`src/signatures.js`) ในโค้ดบนเชน
สิทธิ์พิเศษที่ซ่อนหลังชื่อฟังก์ชันแปลกๆ อาจหลุดได้ (การจำลองซื้อขายช่วยปิดช่องนี้สำหรับเหรียญที่มี pool)
เพิ่มชื่อใหม่ใน `src/signatures.js` แล้วรัน `npm run selectors`

## ทดสอบ

```bash
npm test          # คอมไพล์สัญญาตัวอย่างจริง (test/helpers/contracts.sol) รันบน EVM ในเครื่อง
                  # ทั้งเปิดและปิด optimizer + ลายนิ้วมือ/แม่แบบ + ตัวนับผู้ใช้
                  # + จำลองซื้อขายด้วย DEX จำลอง (Uniswap V2) ที่ที่อยู่ของ PancakeSwap จริง
                  # + โค้ดคล้ายโค้ดที่ติดธง (สำเนาที่แก้นิดหน่อยต้องโดนเตือน เหรียญทั่วไปต้องไม่โดน)
                  # + เหรียญที่ยอมให้ขายเฉพาะตอนเห็นการทดสอบ (SimAware) + ชั้นเตือนล่วงหน้า (test/earlywarning.test.js)
npm run test:web  # เปิดหน้าเว็บใน Chromium ตอบ RPC จากเชนทดสอบ ไม่ใช้เน็ต
```

## สถานะ

- [x] ตัวอ่านและอธิบายสัญญา (CLI + หน้าเว็บ) 7 ภาษา (`src/lang/`, `test/i18n.test.js` ตรวจว่าทุกภาษาครบทุกข้อความ)
- [x] พร้อมวางบน Vercel ฟรี (`vercel.json`)
- [x] ตัวนับผู้ใช้ต่อเดือนแบบไม่เก็บข้อมูลส่วนตัว + หน้าสถิติเทียบเป้า 1,000
- [x] ระบบจำแม่แบบเหรียญ ZETAPHY (รอที่อยู่เหรียญตัวอย่างหนึ่งตัวต่อเชนเพื่อลงทะเบียน)
- [x] ลองกับสัญญาจริงบน mainnet แล้ว (USDT บน BNB Chain, 19 ต.ค. 2026)
- [x] รู้จักเหรียญทางการรายใหญ่ และเตือนเหรียญที่ใช้สัญลักษณ์เดียวกันแต่คนละที่อยู่
- [x] รองรับ Ethereum และ Solana
- [x] รองรับ Sui, Aptos (ภาษา Move) และ TON (ทดสอบกับข้อมูลตามรูปแบบจริงของแต่ละเชน ยังไม่ได้ลองกับ mainnet จากเครื่องนี้)
- [ ] ให้เจ้าของภาษาตรวจคำแปล จีน ญี่ปุ่น เกาหลี เวียดนาม อินโดนีเซีย
- [x] Rust: Solana (Anchor IDL), Arbitrum Stylus, CosmWasm (Osmosis, Neutron) · ซอร์ส Solidity/Vyper จาก Sourcify
- [x] NEAR (Rust/WASM) · TON ตรวจโค้ดกระเป๋าเหรียญของผู้ถือ
- [x] Starknet (Cairo) · Bitcoin Runes
- [ ] BRC-20 (ต้องหา API ฟรีที่ไม่ต้องใช้คีย์)
- [x] อ่านเนื้อใน WASM ของ Stylus
- [x] จำลองซื้อขาย (ทดสอบซื้อแล้วขายคืน) บน EVM ผ่าน Uniswap V2 / PancakeSwap V2 ทดสอบบน EVM ในเครื่องแล้ว
      รอผล live check บน mainnet (ที่อยู่ DEX และ RPC ที่รองรับ state override) จาก CI
- [ ] จำลองซื้อขายผ่าน pool แบบ V3 และ DEX อื่น (Aerodrome บน Base, Camelot บน Arbitrum)
- [x] การจำลองไม่มีค่าตายตัวให้เหรียญจำได้ (ที่อยู่สุ่ม / จากงานเครือข่าย, ราคา gas จริง, จำนวนไม่กลม)
- [ ] จำลองจากกระเป๋าธรรมดาหลายธุรกรรม (`eth_simulateV1`) ปิดช่อง "ให้เฉพาะสัญญาขายได้"
- [x] ชั้นเตือนล่วงหน้า (กฎส่วนตัวช่วงพัก) + workflow เปิดเผยกฎที่ครบกำหนด
- [x] เตือนโค้ดคล้ายโค้ดที่ติดธง (EVM) + สัญญาณ "ยังไม่รู้จักรูปแบบนี้"
- [x] baseline จากรูปแบบ OpenZeppelin ที่พบบ่อย (solc 0.8.26 เปิด/ปิด optimizer) และชุดข้อมูลจริงเริ่มว่าง
- [ ] ใส่สัญญาที่ติดธงจริงบน mainnet ในชุดข้อมูล (พร้อมคีย์และ reportHash ของธง) และขยาย baseline ด้วยเหรียญ OpenZeppelin จริงที่คอมไพล์หลายเวอร์ชัน solc
      (ตอนนี้ baseline และรายการตั้งต้นมาจาก solc 0.8.26 เท่านั้น สำเนาที่คอมไพล์ด้วยเวอร์ชันอื่นอาจหลุด)
- [x] ถ้อยคำเป็นกลาง (ข้อเท็จจริงของโค้ด ไม่ตัดสินคน) + คำปฏิเสธความรับผิด 7 ภาษา + หลักฐานตรวจซ้ำในทุกรายงาน (`docs/LEGAL.md`)
- [ ] ช่องทางชี้แจง/อุทธรณ์บนเชนใน ThreatRegistry
- [ ] ชั้นอธิบายด้วย AI (ทางเลือก): ส่งเฉพาะผลตรวจ ไม่ให้สิทธิ์เรียกเครื่องมือ (จุดอ่อนข้อ 12)

---

# Neuro ZETAPHY tier 1 (English summary)

Read-only contract reader and explainer for Ethereum, BNB Chain, Base,
Arbitrum, Solana (incl. Anchor IDLs), Sui, Aptos, TON, NEAR, Starknet, Osmosis, Neutron and Bitcoin Runes
(CosmWasm), with Sourcify verified-source lookups and Stylus / EIP-7702
detection. Fixed rules over on-chain code and data
(no AI, no wallet, no transactions), output in Thai, English, Chinese,
Japanese, Korean, Vietnamese and Indonesian, a reproducible `reportHash`, a CLI and a static web page.
Also: a privacy-preserving monthly user counter (`api/usage.js`, Vercel +
Upstash Redis) with a stats page, and code-fingerprint templates to recognise
ZETAPHY launcher tokens (`node cli.js fingerprint <chain> <address>`).
EVM tokens also get a buy/sell test (`src/honeypot.js`): one `eth_call` with a
state override runs `contracts/TradeSim.sol`, which buys through the chain's main
Uniswap-V2-style DEX and sells straight back, so a token you can buy but not
sell, or that takes a hidden tax, is caught whatever its functions are named.
Nothing in that test is fixed for a token to recognise: the helper's and the
caller's addresses are random per check (or derived from a NeuroJobs job and
its lottery, `jobSimSeed`, so all runners of a round run the same test;
`--sim-seed` re-runs it), as are its code hash, the amounts, the share sold
and the gas limit, and the call carries a real gas price (a call without one
runs at `tx.gasprice` 0 and, on geth, `block.basefee` 0). One limit remains:
in a single `eth_call` the buyer is a contract, not `tx.origin`.
Two rule tiers: the public consensus rules in `src/` (the skill id), and an
advisory **early-warning** tier (`server/earlywarning.js`,
`POST /api/early-warning`) that runs a private, embargoed rule pack
(`zetaphy-private/rules/pack.json`, loaded from `NEURO_PRIVATE_RULES` or with a
read-only `NEURO_RULES_TOKEN`) and returns only `{reason, severity, ref}` per
match. Rules go public after about 30 days. The endpoint can be probed as an
oracle (rate limits only slow that down), and its warnings are not part of
on-chain verdicts.
EVM code is also compared with an in-repo similarity dataset
(`src/similarity.js`, `src/threat-signatures.js`, shipped empty; test reference
samples live in `test/fixtures/`): opcode 4-gram MinHash plus selector Jaccard
after removing honest library code (minimal and OpenZeppelin-style ERC-20,
Pausable, Permit, Burnable, Capped, Ownable2Step, AccessControl, blacklist),
warning from 60% similarity, informational (at most medium unless the exact
code of an on-chain flag), and worded "flagged by runners" only for entries that
cite their ThreatRegistry flag key and reportHash (otherwise "similar to a
reference sample"); filler opcodes or a recompile evade it;
and code that is mostly unnamed functions and can move value gets a low
"Neuro doesn't recognise this pattern yet" warning instead of "nothing found".
Wording states verifiable code facts ("the owner can mint new tokens", "in a
simulated buy/sell, the token could be bought but not sold"), never verdicts about
people or projects. Every report (web and CLI) shows a 7-language disclaimer, the
report ID, the rules-only verdict ID and the CLI command that reproduces it, and
links to the correction / right-of-reply process (`web/legal.html`,
[`docs/LEGAL.md`](../docs/LEGAL.md)).
Run `npm test` and `npm run test:web`.
