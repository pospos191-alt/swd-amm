# Neuro ZETAPHY — ชั้น 1 (อ่านและอธิบายสัญญา)

งานแรกตาม "แผน ZETAPHY Chain": ตัวอ่านสัญญาที่บอกเป็นภาษาคนว่าสัญญาเหรียญบน
**Ethereum, BNB Chain, Base, Arbitrum, Solana, Sui, Aptos, TON, NEAR, Starknet, Osmosis, Neutron และเหรียญ Runes บน Bitcoin** ให้สิทธิ์อะไรกับเจ้าของบ้าง (สร้างเหรียญเพิ่ม,
บล็อกกระเป๋า, หยุดการโอน, เปลี่ยนภาษี, อัปเกรดโค้ด ฯลฯ) อธิบายได้ 7 ภาษา: ไทย อังกฤษ จีน ญี่ปุ่น เกาหลี
เวียดนาม อินโดนีเซีย ต้นทุน $0

- **อ่านอย่างเดียว**: ใช้แค่ `eth_getCode`, `eth_getStorageAt`, `eth_call` (EVM รวมถึง `eth_call` แบบ
  state override หนึ่งครั้งสำหรับจำลองซื้อขาย ดูด้านล่าง) และ
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
หรือย้ายเงื่อนไขนิดหน่อย จะได้ลายนิ้วมือใหม่ Neuro จึงวัดว่าโค้ด **ใกล้** โค้ดที่ติดธงแค่ไหน (`src/similarity.js`)
ยังเป็นกฎตายตัว: ใช้แค่ hash จำนวนเต็ม ไม่ใช้ AI ไม่สุ่ม ทุกเครื่องได้ตัวเลขเดียวกัน

- ตัดข้อมูลของ PUSH ทุกตัว (ที่อยู่ ค่าคงที่ ตำแหน่ง jump) และ metadata ของคอมไพเลอร์ออก เหลือแต่ลำดับ opcode
- ตัดส่วนที่เหรียญทุกตัวมีเหมือนกันออก (baseline: ERC-20 ธรรมดา และ ERC-20 + Ownable + mint)
  ไม่อย่างนั้นเหรียญทั่วไปกับโค้ดที่ติดธงจะดูเหมือนกันเกือบหมด เพราะส่วนใหญ่คือ ERC-20 เดียวกัน
- เทียบส่วนที่เหลือ: MinHash (128 ค่า) ของชุด opcode 4 ตัวติดกัน และ Jaccard ของ selector ที่เหลือ
  คะแนน = max(opcode, (opcode + selector) / 2) เปลี่ยนชื่อฟังก์ชันจึงหนีไม่พ้น
- คะแนนตั้งแต่ 60% เตือน "โค้ดนี้คล้ายโค้ดที่ผู้รัน Neuro ติดธงไว้ X% (ลายนิ้วมือ fp…)" ระดับต่ำ, 75% ระดับกลาง, 90% ระดับสูง
  (โค้ดเดียวกันเป๊ะ = 100%) ส่วนที่เหลือของโค้ดต้องมีอย่างน้อย 8 ชุด ไม่งั้นไม่เทียบ
- อยู่ใน verdict ที่คนรันร่างต้องตรงกัน เพราะขึ้นกับโค้ดและชุดข้อมูลเท่านั้น
- ครอบคลุมเฉพาะ EVM bytecode: เชนอื่นอ่านจากค่าตั้งบนเชน ไม่ใช่โค้ด และยังไม่ได้ทำกับ WASM ของ Stylus

ชุดข้อมูลโค้ดที่ติดธงอยู่ในโค้ดเอง (`src/threat-signatures.js`) เพราะ ThreatRegistry เก็บแค่คีย์ `fp1` ไม่เก็บโค้ด
แต่ละรายการคือลายนิ้วมือ + ลายเซ็นย่อ (selector ที่เหลือ + MinHash) ราว 1 KB
- ตั้งต้นจากสัญญาตัวอย่างที่เขียนขึ้นเองในชุดทดสอบ (ไม่ใช่โครงการจริง): ScamToken, QuietHoneypot, NotLaunched (หมวด "ซื้อได้แต่ขายไม่ได้"), HiddenPowers (หมวด "สร้างเหรียญเพิ่มแบบไม่เปิดเผย"),
  Killable (SELFDESTRUCT) ทั้งเปิดและปิด optimizer สร้างด้วย `npm run threat-signatures` ไม่ดึงอะไรจากเน็ต
- FakeUSDT (สัญญาทดสอบ) ไม่ได้ใส่: โค้ดของมันคือเหรียญ mint ได้ธรรมดา ต่างแค่ชื่อ ซึ่งกฎ "สัญลักษณ์เหมือนเหรียญทางการแต่คนละที่อยู่" จับอยู่แล้ว
- เพิ่มสัญญาที่ติดธงจริงใน ThreatRegistry: `node cli.js signature bsc 0x... --reason cannot-sell-in-simulation` แล้ววางรายการใน `ADDED`
  (`--reason` รับรหัสข้อเท็จจริงของโค้ดใน ThreatRegistry ตาม `src/threat-reasons.js` รายงานแสดงเป็นคำบรรยายที่เป็นกลาง ดู `REASON` ใน `src/lang/*.js`)
  ทักษะ (skill id) คือ hash ของ `src/` ทั้งหมด ชุดข้อมูลใหม่จึงเป็นทักษะใหม่ ต้องผ่านโหวตก่อนคนรันร่างจะใช้

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
   `contracts/TradeSim.sol` ไว้ที่ที่อยู่ทิ้งได้ พร้อมเหรียญหลักเล็กน้อย (0.01 ETH / 0.05 BNB) สัญญาช่วยจะ
   ตรวจว่า router ชี้ไปที่ factory และ WETH ที่ถูกต้อง ซื้อผ่าน `swapExactETHForTokensSupportingFeeOnTransferTokens`
   เทียบจำนวนที่ได้กับ `getAmountsOut` (= ภาษีซื้อ) แล้วขายคืน 99% ผ่าน
   `swapExactTokensForETHSupportingFeeOnTransferTokens` เทียบเงินที่ได้กับราคาที่ router บอก (= ภาษีขาย)
   การขายที่ revert ถูกจับด้วย try/catch แล้วรายงานเป็นผล ไม่ใช่ error
3. state override มีอยู่แค่ในการเรียกครั้งนั้น ไม่มีการเซ็นหรือส่งธุรกรรม สถานะบนเชนไม่เปลี่ยน
   ถ้า RPC ไม่รองรับ override หรือไม่มี pool จะบอกว่าข้ามการจำลอง

ไบต์โค้ดของสัญญาช่วยเก็บไว้ใน `src/tradesim.generated.js` (คอมไพล์ด้วย solc 0.8.26 แบบ Paris ไม่มี PUSH0
จึงรันได้ทุกเชน) แก้ `contracts/TradeSim.sol` แล้วรัน `npm run tradesim` (`test/honeypot.test.js` ตรวจว่าตรงกัน)
เหรียญทางการใน `src/known-tokens.js` ไม่ถูกจำลอง ผลจำลองไม่นับในคำตัดสินของเครือข่าย Neuro
(`src/verdict.js`) เพราะขึ้นกับบล็อกและ RPC ของผู้รันแต่ละคน
ข้อจำกัด: จำลองจากสัญญา ไม่ใช่กระเป๋าธรรมดา เหรียญที่กันการซื้อจากสัญญาจะขึ้นว่า "ซื้อไม่สำเร็จ"
และเหรียญที่ห้ามขายเฉพาะในบล็อกเดียวกับที่ซื้อจะขึ้นว่า "ขายไม่ได้" เหมือนกัน (ข้อความบอกข้อจำกัดนี้ไว้) ยังไม่รองรับ pool แบบ V3 หรือ DEX อื่น (เช่น Aerodrome บน Base)

ข้อจำกัดของกฎชื่อฟังก์ชัน: ตรวจจากชื่อฟังก์ชันที่รู้จัก (`src/signatures.js`) ในโค้ดบนเชน
สิทธิ์พิเศษที่ซ่อนหลังชื่อฟังก์ชันแปลกๆ อาจหลุดได้ (การจำลองซื้อขายช่วยปิดช่องนี้สำหรับเหรียญที่มี pool)
เพิ่มชื่อใหม่ใน `src/signatures.js` แล้วรัน `npm run selectors`

## ทดสอบ

```bash
npm test          # คอมไพล์สัญญาตัวอย่างจริง (test/helpers/contracts.sol) รันบน EVM ในเครื่อง
                  # ทั้งเปิดและปิด optimizer + ลายนิ้วมือ/แม่แบบ + ตัวนับผู้ใช้
                  # + จำลองซื้อขายด้วย DEX จำลอง (Uniswap V2) ที่ที่อยู่ของ PancakeSwap จริง
                  # + โค้ดคล้ายโค้ดที่ติดธง (สำเนาที่แก้นิดหน่อยต้องโดนเตือน เหรียญทั่วไปต้องไม่โดน)
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
- [x] เตือนโค้ดคล้ายโค้ดที่ติดธง (EVM) + สัญญาณ "ยังไม่รู้จักรูปแบบนี้"
- [ ] ใส่สัญญาที่ติดธงจริงบน mainnet ในชุดข้อมูล และตั้ง baseline จากเหรียญ OpenZeppelin ที่คอมไพล์หลายเวอร์ชัน
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
EVM code is also compared with a small in-repo dataset of flagged code
(`src/similarity.js`, `src/threat-signatures.js`): opcode 4-gram MinHash plus
selector Jaccard after removing ERC-20 boilerplate, warning from 60% similarity;
and code that is mostly unnamed functions and can move value gets a low
"Neuro doesn't recognise this pattern yet" warning instead of "nothing found".
Wording states verifiable code facts ("the owner can mint new tokens", "in a
simulated buy/sell, the token could be bought but not sold"), never verdicts about
people or projects. Every report (web and CLI) shows a 7-language disclaimer, the
report ID, the rules-only verdict ID and the CLI command that reproduces it, and
links to the correction / right-of-reply process (`web/legal.html`,
[`docs/LEGAL.md`](../docs/LEGAL.md)).
Run `npm test` and `npm run test:web`.
