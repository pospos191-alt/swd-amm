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
| `contracts/test/*.sol` | สัญญาที่ใช้เฉพาะในเทสต์ (flash borrower, เหรียญ reentrancy, mock runners, `RevertProbe` ตรวจยอดหลัง revert, registry ที่กินแก๊ส, `ForceSend`) |
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
- **การฝากครั้งแรก (ต่างจาก V2):** ตราบที่พูลยังไม่มีใครถือ LP (`totalSupply == 0`) router ใช้จำนวนที่ผู้ใช้ใส่ (desired) ตรง ๆ
  แม้พูลจะมี reserve แล้ว (มีคนโอนเหรียญเข้าแล้วเรียก `sync`) ผู้ฝากรายแรกจึงเป็นผู้กำหนดราคาเอง และยอดที่ถูกโอนเข้ามาก่อนกลายเป็นของผู้ฝากรายแรก
  (ได้ LP ทั้งหมดยกเว้น 1000 ที่ล็อก) ผู้โจมตีตั้งราคาให้ผู้ฝากรายแรกไม่ได้ และมีแต่เสียเหรียญที่โอนเข้าไป หน้าเว็บก็ถือว่าเป็นพูลใหม่ด้วย (ดูหัวข้อหน้าเว็บ)

**เหรียญหลัก (native) บน ZETAPHY:** ตรวจแล้วว่า precompile `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` คือ WERC20 ของ Cosmos EVM
(`precompiles/werc20`): มี `transfer` / `approve` / `transferFrom` / `balanceOf` แบบ ERC-20 โดย **ยอดคือยอด native ของบัญชีนั้นเลย**,
`deposit()` คืนเหรียญให้ผู้เรียกทันที (จึงเป็นการ "wrap" ที่ไม่ต้องทำอะไร) และ `withdraw()` ไม่ทำอะไร (แค่ตรวจยอด)
router ใช้แค่ `deposit` / `withdraw` / `transfer` / `balanceOf` จึงใช้ precompile เป็น `WETH()` ได้โดยตรง **ไม่ต้อง deploy WZETAPHY บน ZETAPHY**
(`cli.js deploy` ตรวจ precompile ก่อนและเลือกให้เอง) ทดสอบแล้วบน devnet จริง: ยอด native ของพูล = reserve ของพูลพอดี

**Neuro (จุดเด่นของ ZETAPHY):**

- *บนเชน (เลือกเปิดได้):* governance ตั้ง `factory.setThreatRegistry(<ThreatRegistry>)` (ค่าเริ่มต้น `0` = ปิด)
  เมื่อเปิด router จะ **ปฏิเสธการซื้อ (swap เข้า) และการเพิ่มสภาพคล่อง** ของเหรียญที่ธงใน ThreatRegistry "มีผลบังคับ" แล้ว
  (`isContractEnforced(token)`: ที่อยู่ของเหรียญบนเชนนี้ หรือโค้ดของมันแบบไบต์ต่อไบต์) ด้วย error `TokenEnforced(token, reason)`
  **การขายเป็นเหรียญหลัก (ZTPHY) และการถอนสภาพคล่องไม่ถาม registry จึงทำได้เสมอ** ผู้ถือจึงไม่ติดอยู่
  (การขายเหรียญ X เป็นเหรียญ Y ยังถาม registry เรื่อง Y)
  ถ้า registry ที่ตั้งไว้ไม่ตอบ, ตอบผิดรูปแบบ หรือใช้แก๊สเกิน `REGISTRY_GAS` (100,000 ต่อการถาม) router จะ **ปฏิเสธ (fail closed,
  `RegistryUnavailable`) ทั้ง router**: ทุกการซื้อเหรียญและทุกการเพิ่มสภาพคล่องหยุด จนกว่า governance จะตั้ง registry เป็น `0`
  (ปลดทันที) หรือเปลี่ยนเป็นตัวที่ตอบได้ ตอนตั้งค่า factory ตรวจว่าที่อยู่นั้นตอบ `isContractEnforced` ได้ภายในแก๊สเดียวกัน (กันพิมพ์ผิด)
  แต่พิสูจน์ไม่ได้ว่าจะตอบต่อไปในอนาคต
- *หน้าเว็บ:* ตรวจเหรียญก่อนซื้อ ก่อนเพิ่มสภาพคล่อง และก่อนนำเข้าด้วยที่อยู่ ด้วยคีย์เดียวกับกระเป๋า ZETAPHY
  (`zetaphy-network/src/vaccine.js`): ที่อยู่/โค้ด (`isContractFlagged`/`isContractEnforced`), ลายนิ้วมือ fp1 ของ Neuro
  (`isFlagged`/`isEnforced`) และโค้ดปลายทางของ proxy (EIP-1167, EIP-1967) ธงที่ยังไม่บังคับ = **เตือน** และต้องติ๊กยืนยัน,
  ธงที่บังคับแล้ว = **ปฏิเสธ** registry ที่หน้าเว็บใช้คือ `neuroRegistry` ใน `deployments.json` หรือ `factory.threatRegistry()`
- ถ้อยคำเป็นกลางตาม `docs/LEGAL.md` (บอกข้อเท็จจริงของโค้ด ไม่ตัดสินเจตนา) และแสดงข้อความ
  **"ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา"** ทุกครั้งที่แสดงผล Neuro

**governance ทำอะไรได้/ไม่ได้ (บอกตามจริง):**

- *ทำได้:* ตั้ง `feeTo`, ตั้ง/ปิด `threatRegistry`, `router.sweep(to)` (ส่งเหรียญหลักที่หลงเข้า router ต่อ ดูด้านล่าง),
  โอนสิทธิ์ governance (สองขั้น: `setGovernance` แล้ว `acceptGovernance`)
- *หยุดการซื้อผ่าน router ได้:* เพราะการตรวจ registry เป็นแบบ fail closed governance (หรือ registry ที่ governance เลือก)
  ทำให้ router ปฏิเสธทุกการซื้อและทุกการเพิ่มสภาพคล่องได้ ด้วย registry ที่หยุดตอบหรือตอบว่า "บังคับ" กับทุกเหรียญ
  การขายเป็นเหรียญหลักและการถอนสภาพคล่องยังทำได้ และตัวพูลเองไม่ถาม registry (เรียกพูลตรงได้เสมอ) ตั้ง registry เป็น `0` เพื่อปลด
- *ทำไม่ได้:* ย้ายเงินของใคร หยุดตัวพูล หรือเปลี่ยนค่าธรรมเนียม 0.3% สัญญาไม่มี proxy อัปเกรดไม่ได้
- ควรโอน governance ให้ multisig (เช่น `SimpleMultisig` ใน zetaphy-network) หลัง deploy

**เหรียญหลักที่หลงเข้า router:** `receive()` รับเหรียญหลักจาก WETH เท่านั้น แต่บน ZETAPHY ใครก็โอนเหรียญหลักเข้า router ได้ผ่าน
`transfer` ของ precompile (หรือ self-destruct) โดยไม่ผ่าน `receive()` เหรียญนั้นไม่มีเจ้าของใน router: governance เรียก
`router.sweep(to)` ส่งยอดเหรียญหลักทั้งหมดของ router ไปที่ `to` ได้ ปลอดภัยเพราะ router ไม่ถือเงินของผู้ใช้ข้ามธุรกรรม
(ทุกฟังก์ชันส่งต่อหรือคืนเหรียญจนหมดในธุรกรรมเดียวกัน มีเทสต์ตรวจว่ายอดของ router เป็น 0 หลังการ swap ทุกแบบ)

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

เทสต์จากผลตรวจความปลอดภัย (`test/security.test.js`, `test/web-lib.test.js`, หน้าเว็บ e2e และ devnet):
การฝากครั้งแรกหลัง donation + `sync` (M3), registry ที่ใช้แก๊สเกินแล้ว fail closed และปลดด้วย `0` (L5), `sweep` (L9),
CLI ปฏิเสธไฟล์กุญแจที่คนอื่นอ่านได้และเชนที่ไม่ใช่ 77390 (L7), หน้าเว็บกับ localStorage ที่ถูกเขียนทับ (M4), ตรวจ chain id ก่อนเซ็น (L1)
และบน devnet จริง (S1): `RevertProbe` เรียก router/พูลที่ย้ายเหรียญหลักผ่าน precompile แล้ว revert (ไม่ถึงขั้นต่ำของ router,
ตรวจ K ของพูลไม่ผ่าน, และ revert เองหลัง swap สำเร็จ) ยอด native และยอดผ่าน precompile ของพูลและของสัญญากลับเป็นเหมือนเดิมพอดี
ทั้งภายในธุรกรรมและหลังธุรกรรม และ `deposit{value}` ที่สัญญาเรียกคืนเหรียญให้สัญญานั้นจริง

## Deploy สัญญา

ใช้กุญแจสำหรับ testnet เท่านั้น เก็บในไฟล์ **ห้ามวางกุญแจในแชตหรือบน command line** CLI รับเฉพาะ `--key-file <ไฟล์>`
(หรือตัวแปร `ZETAPHY_DEX_KEY_FILE`) ไฟล์เป็น private key แบบ hex หรือ keystore JSON (ถอดรหัสด้วย `ZETAPHY_PASSPHRASE`)
**CLI ปฏิเสธไฟล์กุญแจที่ group หรือคนอื่นอ่าน/เขียนได้** (แจ้งให้ `chmod 600 <ไฟล์>`)
`deploy` ทำงานเฉพาะบน ZETAPHY (EVM chain id 77390) ถ้า RPC ตอบ chain id อื่นจะปฏิเสธ เว้นแต่ใส่ `--any-chain`

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

ตัวเลือกอื่น: `--wnative deploy` (deploy WZETAPHY แทน precompile, สำหรับเชนอื่น ใช้คู่กับ `--any-chain`), `--fee-to`, `--out <ไฟล์>`
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
  แต่ถ้าไม่ใช่ RPC ของ `deployments.json` หน้าเว็บแสดงแถบเตือนตลอด (พร้อมปุ่มกลับไปใช้ค่าเริ่มต้น) และ **ไม่ส่ง RPC นั้นให้กระเป๋า**
  (`wallet_addEthereumChain` ใช้ RPC ของ `deployments.json` เสมอ) ถ้าไม่มี RPC หน้าเว็บจะอ่านผ่านกระเป๋าที่เชื่อมต่อและอยู่บน ZETAPHY
- พูลที่มี reserve แต่ยังไม่มีใครถือ LP (มีคนโอนเหรียญเข้าแล้ว `sync`): หน้าเว็บถือเป็นพูลใหม่ ไม่คำนวณจำนวนอีกฝั่งจาก reserve
  ให้ผู้ใช้ใส่ทั้งสองฝั่งเอง แสดงคำเตือน "พูลนี้มียอดเหรียญอยู่แต่ยังไม่มีใครถือ LP — คุณเป็นผู้กำหนดราคา" และส่ง **ขั้นต่ำ = จำนวนที่ใส่**
  (router จึง revert ถ้าสัดส่วนเปลี่ยน) ฝั่งสัญญา router ก็ใช้จำนวนที่ใส่ตรง ๆ เมื่อ `totalSupply == 0` (ดู "การออกแบบ")
- ก่อน `eth_sendTransaction` ทุกครั้ง หน้าเว็บถาม `eth_chainId` จากกระเป๋าอีกครั้ง ถ้าไม่ใช่ 77390 จะไม่ส่ง และใส่ `chainId: 0x12e4e` ในธุรกรรม
- ก่อนซื้อและก่อนเพิ่มสภาพคล่อง ถาม Neuro ใหม่ (ไม่ใช้แคช) อีกครั้งตอนกดยืนยัน
- ความปลอดภัย: `test-ui/vercel.json` มีกฎ header แยกสำหรับ `/zetaphy(.*)`: CSP เข้มงวด (`default-src 'none'; script-src 'self'; style-src 'self'`
  ไม่มี inline, ไม่มีสคริปต์จากที่อื่น, `connect-src` เฉพาะ https และ localhost) ส่วนกฎเดิมของเว็บหลักยังใช้กับทุก path อื่นเหมือนเดิม
  หน้าเว็บใช้ `textContent` เท่านั้น กรองชื่อ/สัญลักษณ์เหรียญ (ตัดอักขระควบคุม/bidi/zero-width, จำกัดความยาว, เตือนชื่อซ้ำกับรายการ)
  และ **อนุญาต (approve) เท่าที่ต้องใช้พอดี** ไม่ใช่ไม่จำกัด ไม่มีไลบรารีของบุคคลที่สาม (ABI encoder เขียนเอง, selector คำนวณไว้แล้วและมีเทสต์ตรวจ)
- กระเป๋า: EIP-6963 (MetaMask, Rabby, OKX, Trust, Binance Wallet, Coinbase, Brave, Phantom ฯลฯ) และ provider แบบเก่า
  (`window.ethereum`, `window.binancew3w`) เพิ่มเครือข่ายด้วย `wallet_addEthereumChain` (ticker ZTPHY) บนมือถือที่ไม่มีกระเป๋ามีลิงก์เปิดในแอปกระเป๋า
- ภาษาไทย/อังกฤษ, โหมดสว่าง/มืด, ใช้บนมือถือได้ (ทดสอบที่ความกว้าง 360 px)

**localStorage ใช้ origin ร่วมกับเว็บหลัก (M4):** `/zetaphy/` อยู่บนโดเมนเดียวกับ test-ui เดิม ซึ่ง CSP หลวมกว่า (`'unsafe-inline'`,
แพ็กเกจจาก esm.sh/jsdelivr) ถ้าเว็บหลักมีช่องโหว่ XSS สคริปต์นั้นเขียน localStorage ของหน้า DEX ได้ หน้าเว็บจึงตรวจทุกค่าที่อ่านกลับ
อย่างเข้มงวด (`test-ui/zetaphy/lib/storage.js`) และไม่เชื่อค่าเหล่านั้นในเรื่องที่เกี่ยวกับเงิน:

- slippage ที่เก็บไว้ต้องเป็นจำนวนเต็ม 1–500 bps (**สูงสุด 5%**) มิฉะนั้นใช้ 0.5% และถ้า **เกิน 1%** ต้องติ๊กยืนยันใหม่ทุกครั้งก่อน
  swap / เพิ่ม / ถอนสภาพคล่อง (ไม่เก็บการยืนยันไว้)
- RPC ที่เก็บไว้ต้องอยู่ในรูปที่หน้าเว็บบันทึกเองพอดี (https หรือ localhost) ถ้าไม่ใช่ค่าเริ่มต้นมีแถบเตือนตลอดและไม่ส่งให้กระเป๋า
- สวิตช์ "เหรียญหักค่าธรรมเนียมเมื่อโอน" ไม่ถูกเก็บ (ปิดทุกครั้งที่เปิดหน้า)
- เหรียญที่นำเข้าเอง: อ่านกลับเฉพาะรายการของ chain 77390 ที่ผ่านการตรวจ ไม่ซ้ำ ไม่เกิน 50 รายการ แสดงป้าย
  **"นำเข้าเอง ไม่อยู่ในรายการ"** ในตัวเลือกเหรียญและในรายการ และเตือนพร้อมที่อยู่สัญญาเมื่อเลือกใช้ และถาม Neuro ใหม่ตอนกดยืนยัน
- id กระเป๋า ภาษา และธีม ต้องตรงรูปแบบที่กำหนด

ความเสี่ยงที่ยังเหลือ: สคริปต์ที่รันบน origin เดียวกันยังทำได้มากกว่าเขียน localStorage เช่น เปิด `/zetaphy/` ในหน้าต่าง/iframe
แล้วแก้ DOM ของหน้า DEX ตรง ๆ หรือลงทะเบียน service worker ถ้ามี URL บน origin ที่คืนสคริปต์ตามที่ผู้โจมตีกำหนดได้ มาตรการข้างต้น
ลดผลของการเขียนทับค่าที่เก็บไว้เท่านั้น **การแยก DEX ไปไว้บน subdomain ของตัวเอง (เช่น `swap.sawasdeecoin.com`) จะเป็นขอบเขตที่แข็งแรงกว่า**
เพราะเบราว์เซอร์แยก storage, DOM และ service worker ตาม origin ตอนนี้เจ้าของเลือกให้อยู่บนโดเมนนี้
- ดูในเครื่อง: `cd test-ui && python3 serve.py` (หรือ server static ใดก็ได้ที่ root คือ `test-ui/`) แล้วเปิด `/zetaphy/`

## ความเสี่ยง

- **ยังไม่ผ่านการตรวจสอบความปลอดภัย (audit)** ใช้บน testnet เท่านั้น เหรียญไม่มีมูลค่า ไม่ใช่คำแนะนำการลงทุน
- ผู้ให้สภาพคล่องรายแรกเป็นผู้กำหนดราคาเริ่มต้น พูลเล็กราคาเปลี่ยนแรง (price impact) และถูก front-run / sandwich ได้: ตั้ง slippage ให้แคบ
  พูลที่มี LP น้อยมากแต่ราคาผิดจากตลาด (มีคนฝากครั้งแรกไว้นิดเดียวที่ราคาแปลก ๆ) หน้าเว็บจะคำนวณตามราคาของพูลนั้น ตรวจราคาก่อนเพิ่มสภาพคล่องเสมอ
- TWAP ของพูลที่สภาพคล่องต่ำถูกบิดได้ง่าย อย่าใช้เป็น oracle ราคาโดยไม่มีมาตรการเพิ่ม
- เหรียญที่หักค่าธรรมเนียมเมื่อโอน / rebase / มีเจ้าของบล็อกการโอนได้ อาจทำให้ธุรกรรมล้มหรือได้น้อยกว่าที่เห็น
  (เปิดตัวเลือก "เหรียญหักค่าธรรมเนียมเมื่อโอน" ในตั้งค่า)
- ผลตรวจ Neuro ดีเท่ากับข้อมูลใน ThreatRegistry: "ไม่พบธง" ไม่ได้แปลว่าปลอดภัย และธงคือผลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา
- เมื่อเปิดการตรวจบนเชน ถ้า registry หยุดตอบ (หรือใช้แก๊สเกิน 100,000) การซื้อ/เพิ่มสภาพคล่องผ่าน router จะถูกปฏิเสธทั้งหมดจนกว่า
  governance จะแก้หรือตั้งเป็น `0` (ขายเป็นเหรียญหลักและถอนได้เสมอ) นี่คือการออกแบบให้ fail closed ไม่ใช่ข้อบกพร่อง
- หน้าเว็บอยู่บน origin เดียวกับเว็บหลักของ test-ui ดู "localStorage ใช้ origin ร่วมกับเว็บหลัก" ข้างบน
- ใครก็ส่งเหรียญหลักเข้าพูลโดยตรงผ่าน bank send ได้ (ยอดเกิน reserve): `skim` ดึงออก `sync` ปรับ reserve ตาม
- ไม่มี `permit` (EIP-2612) สำหรับ LP: การถอนต้อง approve ก่อน (หน้าเว็บ approve เท่าที่ถอนพอดี)

## สัญญาอนุญาต

MIT (ดู `LICENSE`) เขียนใหม่ทั้งหมด ไม่มีโค้ดจาก Uniswap (GPL-3.0) ใช้เพียงสูตรคณิตศาสตร์ที่เผยแพร่ใน whitepaper
