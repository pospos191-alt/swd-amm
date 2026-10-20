# Neuro ZETAPHY — ชั้น 1 (อ่านและอธิบายสัญญา)

งานแรกตาม "แผน ZETAPHY Chain": ตัวอ่านสัญญาที่บอกเป็นภาษาคนว่าสัญญาเหรียญบน
**Ethereum, BNB Chain, Base, Arbitrum, Solana, Sui, Aptos, TON, NEAR, Starknet, Osmosis และ Neutron** ให้สิทธิ์อะไรกับเจ้าของบ้าง (สร้างเหรียญเพิ่ม,
บล็อกกระเป๋า, หยุดการโอน, เปลี่ยนภาษี, อัปเกรดโค้ด ฯลฯ) อธิบายได้ 7 ภาษา: ไทย อังกฤษ จีน ญี่ปุ่น เกาหลี
เวียดนาม อินโดนีเซีย ต้นทุน $0

- **อ่านอย่างเดียว**: ใช้แค่ `eth_getCode`, `eth_getStorageAt`, `eth_call` (EVM) และ
  `getGenesisHash`, `getAccountInfo` (Solana), GraphQL แบบ query อย่างเดียว (Sui), GET กับฟังก์ชัน
  `#[view]` (Aptos) และ GET จาก tonapi.io (TON) ผ่าน endpoint สาธารณะฟรี ไม่ขอเชื่อมกระเป๋า
  ไม่มีโค้ดส่งธุรกรรม (`src/rpc.js` ปฏิเสธคำสั่งอื่นทั้งหมด และตรวจว่า endpoint เป็น mainnet จริง)
- **กฎตายตัว ไม่ใช้ AI**: ผลเหมือนเดิมทุกครั้ง มี `reportHash` ให้เครื่องอื่นตรวจซ้ำได้
  (ตามจุดอ่อนข้อ 1 ในแผน: งานต้องตรวจซ้ำได้)
- **ไม่เชื่อข้อความจากสัญญา**: ชื่อ/สัญลักษณ์เหรียญถูกกรองอักขระควบคุมและแสดงเป็นข้อความเท่านั้น
  ชื่อที่มีลิงก์ถูกเตือนว่าเป็นกลลวง

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
ป้ายหลอกลวง/รายชื่อที่ตรวจแล้วของ tonapi และสัญญาที่ถูกแช่แข็ง ตรวจ checksum ของที่อยู่ก่อนเรียกเน็ต
และไม่รับที่อยู่ testnet และตรวจกระเป๋าเหรียญ (jetton wallet) ของผู้ถือรายใหญ่สุด: ถ้า tonapi ไม่รู้จักว่าเป็น
กระเป๋ามาตรฐาน จะเตือนระดับสูง เพราะโค้ดกระเป๋าแบบกำหนดเองคือที่ซ่อนของเหรียญ "ซื้อได้ ขายไม่ได้" บน TON

ข้อจำกัดของ Sui/Aptos: ตรวจจากชื่อฟังก์ชันและข้อมูลบนเชน ยังไม่ได้อ่านเนื้อในทุกฟังก์ชัน

**ภาษาที่ใช้เขียนสัญญา** Neuro อ่านโค้ดที่รันจริงบนเชน ไม่ใช่ซอร์ส จึงขึ้นกับว่าภาษานั้นคอมไพล์เป็นอะไร:

| ภาษา | อ่านอย่างไร |
|---|---|
| Solidity, Yul, Vyper, Huff | EVM bytecode (ไม่สนภาษาต้นทาง) + ซอร์สที่ verify แล้วจาก Sourcify (`src/sourcify.js`) ใช้ตั้งชื่อฟังก์ชันที่ไม่รู้จัก |
| Rust/C++ บน Arbitrum (Stylus) | รู้ว่าเป็น WASM ไม่อ่านผิดเป็น EVM อ่านชื่อ/เจ้าของผ่าน ABI แล้วบอกว่าสิทธิ์ยังตรวจไม่ได้ |
| Rust บน Solana (Anchor) | อ่านรายการคำสั่งจาก IDL บนเชน (`src/anchor.js`) หาคำสั่งที่ต้องให้ผู้ดูแลเซ็น และคำสั่งอันตราย |
| Rust บน NEAR | อ่านชื่อฟังก์ชันจาก export ของโค้ด WASM โดยตรง (mint, pause, upgrade ฯลฯ), ดูว่าบัญชีสัญญายังมีกุญแจเต็มสิทธิ์ (ลงโค้ดใหม่ได้) หรือไม่ และข้อมูลเหรียญ NEP-141 (`src/near.js`) |
| Cairo (Starknet) | อ่าน ABI ที่สัญญาเผยแพร่ไว้บนเชน: ชื่อฟังก์ชันและว่าแก้สถานะได้หรือไม่ (mint, pause, upgrade ฯลฯ), เจ้าของ, proxy แบบ Cairo 0 และข้อมูลเหรียญ (`src/starknet.js`) |
| Rust บน CosmWasm (Osmosis, Neutron) | ผู้ดูแลที่เปลี่ยนโค้ดได้ (migrate), ประวัติการเปลี่ยนโค้ด, ผู้สร้างเหรียญ CW20, ผู้ดูแลเหรียญ Token Factory และ before-send hook (`src/cosmwasm.js`) |
| Move (Sui, Aptos) | ชื่อฟังก์ชันและสิทธิ์ในโค้ด |
| FunC/Tact (TON) | ข้อมูล jetton ที่ tonapi ถอดให้ |

กระเป๋าแบบ EIP-7702 (กระเป๋าธรรมดาที่ตั้งให้รันโค้ดของสัญญาอื่น) จะบอกว่ารันโค้ดของสัญญาไหน
ผู้รันในเครือข่าย Neuro ปิด Sourcify (`sourcify: false`) เพื่อให้คำตัดสินขึ้นกับข้อมูลบนเชนอย่างเดียว

**EVM** (Ethereum, BNB Chain, Base, Arbitrum):

| ผลตรวจ | ระดับ |
|---|---|
| ชื่อเหรียญมีลิงก์/ชื่อเว็บ (เหรียญหลอกแจกฟรี) | สูง |
| อัปเกรดโค้ดได้ (EIP-1967 / beacon / `upgradeTo`) | สูง |
| สร้างเหรียญเพิ่ม, บล็อกกระเป๋า, หยุดการโอน | สูง (ต่ำ ถ้าเจ้าของสละสิทธิ์แล้ว) |
| เปลี่ยนภาษี, สวิตช์เปิดปิดเทรด, เพดานต่อรายการ | ปานกลาง (ต่ำ ถ้าสละสิทธิ์แล้ว) |
| คำสั่ง `SELFDESTRUCT` | สูง |
| `DELEGATECALL` นอก proxy, ระบบสิทธิ์แบบ roles | ปานกลาง |
| สำเนา EIP-1167, เจ้าของปัจจุบัน, ยกเว้นภาษีบางกระเป๋า | ข้อมูล |
| ตรงกับแม่แบบ ZETAPHY ที่ลงทะเบียน | ดี (ภาษีลดได้อย่างเดียว = ต่ำ) |
| สัญญาทางการของ USDT, USDC, WETH ฯลฯ (`src/known-tokens.js`) | ดี และลดสิทธิ์ของผู้ออกเหรียญเหลือ "ต่ำ" พร้อมบอกชื่อผู้ออก |
| ใช้สัญลักษณ์เหมือนเหรียญทางการ แต่คนละที่อยู่ (เหรียญปลอม) | สูง |
| ตรงแม่แบบแต่มีสิทธิ์ที่แม่แบบบอกว่าไม่มี | สูง |

ข้อจำกัด: ตรวจจากชื่อฟังก์ชันที่รู้จัก (`src/signatures.js`) ในโค้ดบนเชน
กลโกงที่ตั้งชื่อฟังก์ชันแปลกๆ อาจหลุดได้ เพิ่มชื่อใหม่ใน `src/signatures.js`
แล้วรัน `npm run selectors`

## ทดสอบ

```bash
npm test          # คอมไพล์สัญญาตัวอย่างจริง (test/helpers/contracts.sol) รันบน EVM ในเครื่อง
                  # ทั้งเปิดและปิด optimizer + ลายนิ้วมือ/แม่แบบ + ตัวนับผู้ใช้
npm run test:web  # เปิดหน้าเว็บใน Chromium ตอบ RPC จากเชนทดสอบ ไม่ใช้เน็ต
```

## สถานะ

- [x] ตัวอ่านและอธิบายสัญญา (CLI + หน้าเว็บ) 7 ภาษา (`src/lang/`, `test/i18n.test.js` ตรวจว่าทุกภาษาครบทุกข้อความ)
- [x] พร้อมวางบน Vercel ฟรี (`vercel.json`)
- [x] ตัวนับผู้ใช้ต่อเดือนแบบไม่เก็บข้อมูลส่วนตัว + หน้าสถิติเทียบเป้า 1,000
- [x] ระบบจำแม่แบบเหรียญ ZETAPHY (รอที่อยู่เหรียญตัวอย่างหนึ่งตัวต่อเชนเพื่อลงทะเบียน)
- [x] ลองกับสัญญาจริงบน mainnet แล้ว (USDT บน BNB Chain, 19 ต.ค. 2026)
- [x] รู้จักเหรียญทางการรายใหญ่ และจับเหรียญปลอมที่ใช้ชื่อเลียนแบบ
- [x] รองรับ Ethereum และ Solana
- [x] รองรับ Sui, Aptos (ภาษา Move) และ TON (ทดสอบกับข้อมูลตามรูปแบบจริงของแต่ละเชน ยังไม่ได้ลองกับ mainnet จากเครื่องนี้)
- [ ] ให้เจ้าของภาษาตรวจคำแปล จีน ญี่ปุ่น เกาหลี เวียดนาม อินโดนีเซีย
- [x] Rust: Solana (Anchor IDL), Arbitrum Stylus, CosmWasm (Osmosis, Neutron) · ซอร์ส Solidity/Vyper จาก Sourcify
- [x] NEAR (Rust/WASM) · TON ตรวจโค้ดกระเป๋าเหรียญของผู้ถือ
- [x] Starknet (Cairo)
- [ ] Bitcoin (Runes/BRC-20), อ่านเนื้อใน WASM ของ Stylus
- [ ] ชั้นอธิบายด้วย AI (ทางเลือก): ส่งเฉพาะผลตรวจ ไม่ให้สิทธิ์เรียกเครื่องมือ (จุดอ่อนข้อ 12)

---

# Neuro ZETAPHY tier 1 (English summary)

Read-only contract reader and explainer for Ethereum, BNB Chain, Base,
Arbitrum, Solana (incl. Anchor IDLs), Sui, Aptos, TON, NEAR, Starknet, Osmosis and Neutron
(CosmWasm), with Sourcify verified-source lookups and Stylus / EIP-7702
detection. Fixed rules over on-chain code and data
(no AI, no wallet, no transactions), output in Thai, English, Chinese,
Japanese, Korean, Vietnamese and Indonesian, a reproducible `reportHash`, a CLI and a static web page.
Also: a privacy-preserving monthly user counter (`api/usage.js`, Vercel +
Upstash Redis) with a stats page, and code-fingerprint templates to recognise
ZETAPHY launcher tokens (`node cli.js fingerprint <chain> <address>`).
Run `npm test` and `npm run test:web`.
