# ZETAPHY DEX (ZETAPHY Swap)

กระดานแลกเปลี่ยนเหรียญแบบ AMM (สูตร x·y = k) พร้อมพูลสภาพคล่อง สำหรับเชน **ZETAPHY** (Cosmos EVM,
EVM chain id `77390`, chain id `zetaphy_77390-1`, เหรียญหลัก ZETAPHY ตัวย่อในกระเป๋า **ZTPHY**, ทศนิยม 18)

> ⚠️ **Testnet เท่านั้น เหรียญไม่มีมูลค่า สัญญายังไม่ผ่านการตรวจสอบความปลอดภัย (unaudited)** อ่านหัวข้อ "ความเสี่ยง" ก่อนใช้

- สัญญา, สคริปต์ build, CLI สำหรับ deploy และชุดทดสอบ: โฟลเดอร์นี้ (`zetaphy-dex/`)
- หน้าเว็บ: `test-ui/zetaphy/` เผยแพร่ที่ **https://swd-amm.sawasdeecoin.com/zetaphy/** (ไปพร้อมโปรเจกต์ Vercel เดิมของ test-ui)

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `contracts/ZetaphyFactory.sol` | สร้างพูล (CREATE2) หนึ่งพูลต่อคู่เหรียญ และเก็บค่าที่ governance ตั้งได้ (`feeTo`, `threatRegistry`) |
| `contracts/ZetaphyPair.sol` | พูล x·y = k + เหรียญ LP (ZLP) |
| `contracts/ZetaphyRouter.sol` | ฟังก์ชันที่ผู้ใช้เรียก: เพิ่ม/ถอนสภาพคล่อง แลกเปลี่ยน (หลายทอด), deadline, slippage, เหรียญหักค่าธรรมเนียมเมื่อโอน, ตรวจ Neuro |
| `contracts/WZETAPHY.sol` | wrapped native แบบ WETH (ใช้ในเทสต์ และบนเชนอื่นที่ไม่มี precompile) |
| `contracts/TestToken.sol` | เหรียญทดสอบ (ไม่มีมูลค่า) สำหรับ testnet |
| `contracts/test/*.sol` | สัญญาที่ใช้เฉพาะในเทสต์ (flash borrower, เหรียญ reentrancy, mock runners) |
| `artifacts/*.json` | ผล compile (commit ไว้ CLI ไม่ต้องใช้ compiler) `npm run build -- --check` ตรวจว่าตรงกับซอร์ส |
| `cli.js` | deploy และตั้งค่า governance |
| `test/` | unit test (EVM ในหน่วยความจำ), fuzz, e2e บนเบราว์เซอร์, integration บน devnet จริง |
| `../test-ui/zetaphy/` | หน้าเว็บ (HTML/CSS/JS ล้วน ไม่มีโค้ดของบุคคลที่สาม) |

## การออกแบบ

**สูตรและสัญญา:** ใช้คณิตศาสตร์ของ Uniswap V2 (whitepaper) ซึ่งพิสูจน์แล้วในการใช้งานจริง แต่ **เขียนโค้ดใหม่ทั้งหมด
ภายใต้สัญญาอนุญาต MIT** (ไม่ได้คัดลอกโค้ด GPL ของ Uniswap) Solidity 0.8.26, optimizer 200, evm `cancun` เหมือนส่วนอื่นของ repo
ชื่อและลำดับอาร์กิวเมนต์ของ router ตรงกับ V2 (เช่น `swapExactETHForTokens`) เพื่อให้กระเป๋าที่ถอดรหัส V2 ได้แสดงผลถูก
คำว่า "ETH" ในชื่อฟังก์ชันหมายถึงเหรียญหลักของเชน (ZETAPHY)

- ค่าธรรมเนียม **0.3%** ของจำนวนที่จ่าย เข้าพูล (ผู้ให้สภาพคล่องได้)
- **protocol fee** ปิดเป็นค่าเริ่มต้น governance เปิดด้วย `setFeeTo(addr)`: 1/6 ของการเติบโตของ √k (= 0.05% ของ volume) เป็น LP ให้ `feeTo`
- **TWAP:** `price0CumulativeLast` / `price1CumulativeLast` (UQ112.112 × วินาที)
- **reentrancy lock** ทุกฟังก์ชันที่เปลี่ยนสถานะของพูล
- `skim` / `sync`
- **MINIMUM_LIQUIDITY:** 1000 หน่วยเล็กสุดของ LP แรกถูกล็อกที่ `address(0)` ตลอดไป
- router ตรวจ **deadline** และ **slippage** (amountOutMin / amountInMax / amountAMin / amountBMin) ทุกฟังก์ชัน
- รองรับ **เหรียญหักค่าธรรมเนียมเมื่อโอน** ผ่านฟังก์ชัน `…SupportingFeeOnTransferTokens`
- **flash swap:** `swap(..., data)` ส่งเหรียญก่อนแล้วเรียก `zetaphyDexCall` ต้องคืนพร้อมค่าธรรมเนียมภายในธุรกรรมเดียว

**เหรียญหลัก (native) บน ZETAPHY:** ตรวจแล้วว่า precompile `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` คือ WERC20 ของ Cosmos EVM
(`precompiles/werc20`): มี `transfer` / `approve` / `transferFrom` / `balanceOf` แบบ ERC-20 โดย **ยอดคือยอด native ของบัญชีนั้นเลย**,
`deposit()` คืนเหรียญให้ผู้เรียกทันที (จึงเป็นการ "wrap" ที่ไม่ต้องทำอะไร) และ `withdraw()` ไม่ทำอะไร (แค่ตรวจยอด)
router ใช้แค่ `deposit` / `withdraw` / `transfer` / `balanceOf` จึงใช้ precompile เป็น `WETH()` ได้โดยตรง **ไม่ต้อง deploy WZETAPHY บน ZETAPHY**
(`cli.js deploy` ตรวจ precompile ก่อนและเลือกให้เอง) ทดสอบแล้วบน devnet จริง: ยอด native ของพูล = reserve ของพูลพอดี

**Neuro (จุดเด่นของ ZETAPHY):**

- *บนเชน (เลือกเปิดได้):* governance ตั้ง `factory.setThreatRegistry(<ThreatRegistry>)` (ค่าเริ่มต้น `0` = ปิด)
  เมื่อเปิด router จะ **ปฏิเสธการซื้อ (swap เข้า) และการเพิ่มสภาพคล่อง** ของเหรียญที่ธงใน ThreatRegistry "มีผลบังคับ" แล้ว
  (`isContractEnforced(token)`: ที่อยู่ของเหรียญบนเชนนี้ หรือโค้ดของมันแบบไบต์ต่อไบต์) ด้วย error `TokenEnforced(token, reason)`
  **การขายและการถอนสภาพคล่องทำได้เสมอ** ผู้ถือจึงไม่ติดอยู่ ถ้า registry ที่ตั้งไว้ไม่ตอบ router จะปฏิเสธ (fail closed, `RegistryUnavailable`)
  และ governance ปิดได้ด้วยการตั้งเป็น `0` ตอนตั้งค่า factory ตรวจว่าที่อยู่นั้นตอบ `isContractEnforced` ได้จริง (กันพิมพ์ผิด)
- *หน้าเว็บ:* ตรวจเหรียญก่อนซื้อ ก่อนเพิ่มสภาพคล่อง และก่อนนำเข้าด้วยที่อยู่ ด้วยคีย์เดียวกับกระเป๋า ZETAPHY
  (`zetaphy-network/src/vaccine.js`): ที่อยู่/โค้ด (`isContractFlagged`/`isContractEnforced`), ลายนิ้วมือ fp1 ของ Neuro
  (`isFlagged`/`isEnforced`) และโค้ดปลายทางของ proxy (EIP-1167, EIP-1967) ธงที่ยังไม่บังคับ = **เตือน** และต้องติ๊กยืนยัน,
  ธงที่บังคับแล้ว = **ปฏิเสธ** registry ที่หน้าเว็บใช้คือ `neuroRegistry` ใน `deployments.json` หรือ `factory.threatRegistry()`
- ถ้อยคำเป็นกลางตาม `docs/LEGAL.md` (บอกข้อเท็จจริงของโค้ด ไม่ตัดสินเจตนา) และแสดงข้อความ
  **"ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา"** ทุกครั้งที่แสดงผล Neuro

**governance ทำอะไรได้/ไม่ได้:** ตั้ง `feeTo`, ตั้ง/ปิด `threatRegistry`, โอนสิทธิ์ governance (สองขั้น: `setGovernance` แล้ว `acceptGovernance`)
**ทำไม่ได้:** ย้ายเงินของใคร หยุดพูล หรือเปลี่ยนค่าธรรมเนียม 0.3% สัญญาไม่มี proxy อัปเกรดไม่ได้ ควรโอน governance ให้ multisig
(เช่น `SimpleMultisig` ใน zetaphy-network) หลัง deploy

## Build และทดสอบ

```bash
cd zetaphy-dex
npm install
npm run build            # compile -> artifacts/  (npm run build -- --check: ตรวจว่า artifacts ตรงกับซอร์ส)
npm test                 # unit + fuzz + build check + web libs + CLI (EVM ในหน่วยความจำ, ไม่ต้องใช้โหนด)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:web          # หน้าเว็บใน Chromium + กระเป๋าจำลอง + RPC จำลอง (EVM จริงในหน่วยความจำ)
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet        # deploy บน devnet จริง, swap ZTPHY <-> เหรียญทดสอบ, Neuro
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:web:devnet    # หน้าเว็บเดียวกันกับ devnet จริง
```

เทสต์ devnet ใช้พอร์ต `ZDEX_DEVNET_PORT` (ค่าเริ่มต้น 24545 และถัดไปอีก ~110) และเปิดโหนดชั่วคราวด้วย `zetaphy-network/scripts/devnet.sh`
สิ่งที่ครอบคลุม: เพิ่ม/ถอนสภาพคล่อง, swap ทั้งสองทาง (exact in / exact out), หลายทอด, price impact, ค่าธรรมเนียม LP และ protocol fee,
minimum liquidity, K invariant, flash swap, reentrancy (ทุกฟังก์ชันของพูล), deadline, slippage, เหรียญหักค่าธรรมเนียมเมื่อโอน,
การปฏิเสธของ registry (ThreatRegistry จริง), TWAP, skim/sync, governance และ fuzz ของ invariant (ตั้ง seed ได้: `ZDEX_FUZZ_SEED`, `ZDEX_FUZZ_STEPS`)

## Deploy สัญญา

ใช้กุญแจสำหรับ testnet เท่านั้น เก็บในไฟล์ (สิทธิ์ 600) **ห้ามวางกุญแจในแชตหรือบน command line** CLI รับเฉพาะ `--key-file <ไฟล์>`
(หรือตัวแปร `ZETAPHY_DEX_KEY_FILE`) ไฟล์เป็น private key แบบ hex หรือ keystore JSON (ถอดรหัสด้วย `ZETAPHY_PASSPHRASE`)

```bash
cd zetaphy-dex
# 1) deploy (บน ZETAPHY จะใช้ native precompile เป็น WETH ให้เอง)
node cli.js deploy --rpc https://<rpc ของ ZETAPHY> --key-file ~/.zetaphy/dex-deployer.key \
  --public-rpc https://<rpc ที่หน้าเว็บใช้> \
  --registry <ที่อยู่ ThreatRegistry ถ้าต้องการเปิดการตรวจบนเชน> \
  --test-tokens \
  --web ../test-ui/zetaphy/deployments.json
# 2) ดูสถานะ
node cli.js status --rpc https://<rpc>
# 3) ตั้ง/ปิด Neuro registry ภายหลัง (ต้องเป็น governance), เปิด/ปิด protocol fee
node cli.js set-registry <0xRegistry|0x0> --rpc https://<rpc> --key-file <ไฟล์>
node cli.js set-fee-to  <0xAddr|0x0>     --rpc https://<rpc> --key-file <ไฟล์>
# 4) โอน governance ให้ multisig (ฝั่ง multisig ต้องเรียก acceptGovernance())
node cli.js deploy ... --governance <0xMultisig>     # หรือเรียก setGovernance เองภายหลัง
```

ตัวเลือกอื่น: `--wnative deploy` (deploy WZETAPHY แทน precompile, สำหรับเชนอื่น), `--fee-to`, `--out <ไฟล์>`
ผลลัพธ์เขียนที่ `deployments/<chainId>.json` และ (ถ้าใส่ `--web`) ที่ `test-ui/zetaphy/deployments.json` ซึ่งหน้าเว็บอ่าน
`--test-tokens` สร้าง tUSD และ tSWD (ไม่มีมูลค่า) พร้อมพูลกับ ZTPHY และ `mint-test <token> <to> <amount>` แจกเพิ่มได้

หลัง deploy ให้ commit `test-ui/zetaphy/deployments.json` (ไม่มีความลับ มีแค่ที่อยู่สัญญาและ RPC สาธารณะ)

## หน้าเว็บบน Vercel

หน้าเว็บอยู่ใน `test-ui/zetaphy/` จึง **deploy ไปพร้อมโปรเจกต์ Vercel เดิมของ test-ui โดยอัตโนมัติ** ที่
**https://swd-amm.sawasdeecoin.com/zetaphy/** ไม่ต้องสร้างโปรเจกต์หรือโดเมนใหม่ ไม่มีค่าใช้จ่ายเพิ่ม (static ล้วน ไม่มี server)
หัวเว็บหลัก (`test-ui/index.html`) มีลิงก์ "ZETAPHY Swap" ไปที่ `/zetaphy/`

- ตั้งค่า: `test-ui/zetaphy/deployments.json` (จาก `cli.js deploy --web`) และ `test-ui/zetaphy/tokenlist.json`
  (รูปแบบ token list ของ Uniswap: `{ chainId: 77390, address, name, symbol, decimals }`)
- RPC ที่หน้าเว็บใช้ต้องเป็น https และเปิด CORS ให้เบราว์เซอร์เรียกได้ (เหมือนที่ zetaphy-wallet ใช้) ผู้ใช้เปลี่ยน RPC ได้ใน "ตั้งค่า"
  ถ้าไม่มี RPC หน้าเว็บจะอ่านผ่านกระเป๋าที่เชื่อมต่อและอยู่บน ZETAPHY
- ความปลอดภัย: `test-ui/vercel.json` มีกฎ header แยกสำหรับ `/zetaphy(.*)`: CSP เข้มงวด (`default-src 'none'; script-src 'self'; style-src 'self'`
  ไม่มี inline, ไม่มีสคริปต์จากที่อื่น, `connect-src` เฉพาะ https และ localhost) ส่วนกฎเดิมของเว็บหลักยังใช้กับทุก path อื่นเหมือนเดิม
  หน้าเว็บใช้ `textContent` เท่านั้น กรองชื่อ/สัญลักษณ์เหรียญ (ตัดอักขระควบคุม/bidi/zero-width, จำกัดความยาว, เตือนชื่อซ้ำกับรายการ)
  และ **อนุญาต (approve) เท่าที่ต้องใช้พอดี** ไม่ใช่ไม่จำกัด ไม่มีไลบรารีของบุคคลที่สาม (ABI encoder เขียนเอง, selector คำนวณไว้แล้วและมีเทสต์ตรวจ)
- กระเป๋า: EIP-6963 (MetaMask, Rabby, OKX, Trust, Binance Wallet, Coinbase, Brave, Phantom ฯลฯ) และ provider แบบเก่า
  (`window.ethereum`, `window.binancew3w`) เพิ่มเครือข่ายด้วย `wallet_addEthereumChain` (ticker ZTPHY) บนมือถือที่ไม่มีกระเป๋ามีลิงก์เปิดในแอปกระเป๋า
- ภาษาไทย/อังกฤษ, โหมดสว่าง/มืด, ใช้บนมือถือได้ (ทดสอบที่ความกว้าง 360 px)
- ดูในเครื่อง: `cd test-ui && python3 serve.py` (หรือ server static ใดก็ได้ที่ root คือ `test-ui/`) แล้วเปิด `/zetaphy/`

## ความเสี่ยง

- **ยังไม่ผ่านการตรวจสอบความปลอดภัย (audit)** ใช้บน testnet เท่านั้น เหรียญไม่มีมูลค่า ไม่ใช่คำแนะนำการลงทุน
- ผู้ให้สภาพคล่องรายแรกเป็นผู้กำหนดราคาเริ่มต้น พูลเล็กราคาเปลี่ยนแรง (price impact) และถูก front-run / sandwich ได้: ตั้ง slippage ให้แคบ
- TWAP ของพูลที่สภาพคล่องต่ำถูกบิดได้ง่าย อย่าใช้เป็น oracle ราคาโดยไม่มีมาตรการเพิ่ม
- เหรียญที่หักค่าธรรมเนียมเมื่อโอน / rebase / มีเจ้าของบล็อกการโอนได้ อาจทำให้ธุรกรรมล้มหรือได้น้อยกว่าที่เห็น
  (เปิดตัวเลือก "เหรียญหักค่าธรรมเนียมเมื่อโอน" ในตั้งค่า)
- ผลตรวจ Neuro ดีเท่ากับข้อมูลใน ThreatRegistry: "ไม่พบธง" ไม่ได้แปลว่าปลอดภัย และธงคือผลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา
- เมื่อเปิดการตรวจบนเชน ถ้า registry หยุดตอบ การซื้อ/เพิ่มสภาพคล่องจะถูกปฏิเสธจนกว่า governance จะแก้หรือปิด (ขาย/ถอนได้เสมอ)
- ใครก็ส่งเหรียญหลักเข้าพูลโดยตรงผ่าน bank send ได้ (ยอดเกิน reserve): `skim` ดึงออก `sync` ปรับ reserve ตาม
- ไม่มี `permit` (EIP-2612) สำหรับ LP: การถอนต้อง approve ก่อน (หน้าเว็บ approve เท่าที่ถอนพอดี)

## สัญญาอนุญาต

MIT (ดู `LICENSE`) เขียนใหม่ทั้งหมด ไม่มีโค้ดจาก Uniswap (GPL-3.0) ใช้เพียงสูตรคณิตศาสตร์ที่เผยแพร่ใน whitepaper
