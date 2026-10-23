[English](README.md) | **ภาษาไทย**

# ZETAPHY DEX (ZETAPHY Swap)

กระดานแลกเปลี่ยนเหรียญแบบ AMM (สูตร x·y = k) พร้อมพูลสภาพคล่อง สำหรับเชน **ZETAPHY** (Cosmos EVM,
EVM chain id `77390`, chain id `zetaphy_77390-1`, เหรียญหลัก ZETAPHY ตัวย่อในกระเป๋า **ZTPHY**, ทศนิยม 18)

> ⚠️ **Testnet เท่านั้น เหรียญไม่มีมูลค่า สัญญายังไม่ผ่านการตรวจสอบความปลอดภัย (unaudited)** อ่านหัวข้อ "ความเสี่ยง" ก่อนใช้

- สัญญา, สคริปต์ build, CLI สำหรับ deploy และชุดทดสอบ: โฟลเดอร์นี้ (`zetaphy-dex/`)
- หน้าเว็บ: `web/` เผยแพร่ที่ **https://swap.sawasdeecoin.com/** (โปรเจกต์ Vercel ของตัวเอง บน origin ของตัวเอง)
  ที่อยู่เดิม `https://swd-amm.sawasdeecoin.com/zetaphy/` redirect (308) มาที่นี่

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
| `web/` | หน้าเว็บ (HTML/CSS/JS ล้วน ไม่มีโค้ดของบุคคลที่สาม) และ `web/vercel.json` (CSP และ header ความปลอดภัย) |

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
  --web            # ไม่ใส่ชื่อไฟล์ = web/deployments.json
# 2) ดูสถานะ
node cli.js status --rpc https://<rpc>
# 3) ตั้ง/ปิด Neuro registry ภายหลัง (ต้องเป็น governance), เปิด/ปิด protocol fee
node cli.js set-registry <0xRegistry|0x0> --rpc https://<rpc> --key-file <ไฟล์>
node cli.js set-fee-to  <0xAddr|0x0>     --rpc https://<rpc> --key-file <ไฟล์>
# 4) โอน governance ให้ multisig (ฝั่ง multisig ต้องเรียก acceptGovernance())
node cli.js deploy ... --governance <0xMultisig>     # หรือเรียก setGovernance เองภายหลัง
```

ตัวเลือกอื่น: `--wnative deploy` (deploy WZETAPHY แทน precompile, สำหรับเชนอื่น ใช้คู่กับ `--any-chain`), `--fee-to`, `--out <ไฟล์>`
ผลลัพธ์เขียนที่ `deployments/<chainId>.json` และ (ถ้าใส่ `--web`) ที่ `web/deployments.json` ซึ่งหน้าเว็บอ่าน (`--web <ไฟล์>` เขียนที่อื่นแทนได้)
`--test-tokens` สร้าง tUSD และ tSWD (ไม่มีมูลค่า) พร้อมพูลกับ ZTPHY และ `mint-test <token> <to> <amount>` แจกเพิ่มได้

หลัง deploy ให้ commit `web/deployments.json` (ไม่มีความลับ มีแค่ที่อยู่สัญญาและ RPC สาธารณะ) Vercel จะ deploy หน้าเว็บใหม่เอง

## หน้าเว็บบน Vercel

หน้าเว็บอยู่ใน `web/` และ deploy เป็น **โปรเจกต์ Vercel แยกของตัวเอง** ที่ **https://swap.sawasdeecoin.com/**
(static ล้วน ไม่มี server ไม่มีขั้น build) จึงไม่ใช้ origin ร่วมกับเว็บ test-ui ที่ CSP หลวมกว่า (`'unsafe-inline'`, สคริปต์จาก CDN)
หัวเว็บหลัก (`test-ui/index.html`) มีลิงก์ "ZETAPHY Swap" ไปที่ `https://swap.sawasdeecoin.com/` (เปิดแท็บใหม่, `rel="noopener"`)
และ `test-ui/vercel.json` redirect `/zetaphy` กับ `/zetaphy/*` แบบถาวร (308) ไปที่ path เดียวกันบน `swap.sawasdeecoin.com` ลิงก์เก่าจึงยังใช้ได้

ตั้งค่าครั้งแรก (เจ้าของทำครั้งเดียว):

1. Vercel → **Add New… → Project** → import repo `swd-amm` เดิม (โปรเจกต์ใหม่ แยกจากโปรเจกต์ของ test-ui)
2. **Root Directory: `zetaphy-dex/web`**, Framework Preset: **Other**, ไม่ต้องมี Build Command / Output Directory (ปล่อยว่าง) แล้ว Deploy
   (`web/vercel.json` ใส่ CSP และ header ความปลอดภัยให้ทุก path)
3. DNS ของ `sawasdeecoin.com`: เพิ่มระเบียน **CNAME `swap` → `cname.vercel-dns.com`**
   (ถ้า DNS ของโดเมนอยู่ที่ Vercel เอง ข้ามขั้นนี้ได้ Vercel สร้างให้)
4. ในโปรเจกต์ใหม่ → **Settings → Domains** → เพิ่ม **`swap.sawasdeecoin.com`** รอสถานะ Valid Configuration (Vercel ออกใบรับรอง HTTPS ให้เอง)
5. ตรวจ: `curl -sI https://swap.sawasdeecoin.com/ | grep -i content-security-policy` ต้องขึ้นต้นด้วย `default-src 'none'; script-src 'self'`
   และ `curl -sI https://swd-amm.sawasdeecoin.com/zetaphy/` ต้องได้ 308 ไปที่ `https://swap.sawasdeecoin.com/`

- ตั้งค่า: `web/deployments.json` (จาก `cli.js deploy --web`) และ `web/tokenlist.json`
  (รูปแบบ token list ของ Uniswap: `{ chainId: 77390, address, name, symbol, decimals }`)
- RPC ที่หน้าเว็บใช้ต้องเป็น https และเปิด CORS ให้เบราว์เซอร์เรียกได้ (เหมือนที่ zetaphy-wallet ใช้) ผู้ใช้เปลี่ยน RPC ได้ใน "ตั้งค่า"
  แต่ถ้าไม่ใช่ RPC ของ `deployments.json` หน้าเว็บแสดงแถบเตือนตลอด (พร้อมปุ่มกลับไปใช้ค่าเริ่มต้น) และ **ไม่ส่ง RPC นั้นให้กระเป๋า**
  (`wallet_addEthereumChain` ใช้ RPC ของ `deployments.json` เสมอ) ถ้าไม่มี RPC หน้าเว็บจะอ่านผ่านกระเป๋าที่เชื่อมต่อและอยู่บน ZETAPHY
- พูลที่มี reserve แต่ยังไม่มีใครถือ LP (มีคนโอนเหรียญเข้าแล้ว `sync`): หน้าเว็บถือเป็นพูลใหม่ ไม่คำนวณจำนวนอีกฝั่งจาก reserve
  ให้ผู้ใช้ใส่ทั้งสองฝั่งเอง แสดงคำเตือน "พูลนี้มียอดเหรียญอยู่แต่ยังไม่มีใครถือ LP — คุณเป็นผู้กำหนดราคา" และส่ง **ขั้นต่ำ = จำนวนที่ใส่**
  (router จึง revert ถ้าสัดส่วนเปลี่ยน) ฝั่งสัญญา router ก็ใช้จำนวนที่ใส่ตรง ๆ เมื่อ `totalSupply == 0` (ดู "การออกแบบ")
- ก่อน `eth_sendTransaction` ทุกครั้ง หน้าเว็บถาม `eth_chainId` จากกระเป๋าอีกครั้ง ถ้าไม่ใช่ 77390 จะไม่ส่ง และใส่ `chainId: 0x12e4e` ในธุรกรรม
- ก่อนซื้อและก่อนเพิ่มสภาพคล่อง ถาม Neuro ใหม่ (ไม่ใช้แคช) อีกครั้งตอนกดยืนยัน
- ความปลอดภัย: `web/vercel.json` ใส่ CSP เข้มงวดให้ทุก path (`default-src 'none'; script-src 'self'; style-src 'self'`
  ไม่มี inline, ไม่มีสคริปต์จากที่อื่น, `connect-src` เฉพาะ https และ localhost, `frame-ancestors 'none'`)
  พร้อม HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` และ COOP `same-origin`
  หน้าเว็บใช้ `textContent` เท่านั้น กรองชื่อ/สัญลักษณ์เหรียญ (ตัดอักขระควบคุม/bidi/zero-width, จำกัดความยาว, เตือนชื่อซ้ำกับรายการ)
  และ **อนุญาต (approve) เท่าที่ต้องใช้พอดี** ไม่ใช่ไม่จำกัด ไม่มีไลบรารีของบุคคลที่สาม (ABI encoder เขียนเอง, selector คำนวณไว้แล้วและมีเทสต์ตรวจ)
- กระเป๋า: EIP-6963 (MetaMask, Rabby, OKX, Trust, Binance Wallet, Coinbase, Brave, Phantom ฯลฯ) และ provider แบบเก่า
  (`window.ethereum`, `window.binancew3w`) เพิ่มเครือข่ายด้วย `wallet_addEthereumChain` (ticker ZTPHY) บนมือถือที่ไม่มีกระเป๋ามีลิงก์เปิดในแอปกระเป๋า
- 8 ภาษา (English, 中文, Español, 한국어, 日本語, Русский, Tiếng Việt, ไทย; ค่าเริ่มต้นเป็นภาษาอังกฤษ), โหมดสว่าง/มืด, ใช้บนมือถือได้ (ทดสอบที่ความกว้าง 360 px)

**ค่าที่เก็บใน localStorage ไม่ถูกเชื่อ (M4):** เดิมหน้า DEX อยู่ที่ `/zetaphy/` บน origin เดียวกับ test-ui ซึ่ง CSP หลวมกว่า
ถ้าเว็บนั้นมีช่องโหว่ XSS สคริปต์จะเขียน localStorage ของหน้า DEX ได้ ตอนนี้หน้า DEX ย้ายไปอยู่บน `swap.sawasdeecoin.com` ของตัวเองแล้ว
(เบราว์เซอร์แยก storage, DOM และ service worker ตาม origin) แต่ยังคงตรวจทุกค่าที่อ่านกลับอย่างเข้มงวด (`web/lib/storage.js`)
เพราะค่าใน localStorage ยังถูกเขียนได้จากทางอื่น (ส่วนขยายของเบราว์เซอร์, โปรไฟล์เก่า, บั๊กในอนาคต) และไม่เชื่อค่าเหล่านั้นในเรื่องที่เกี่ยวกับเงิน:

- slippage ที่เก็บไว้ต้องเป็นจำนวนเต็ม 1–500 bps (**สูงสุด 5%**) มิฉะนั้นใช้ 0.5% และถ้า **เกิน 1%** ต้องติ๊กยืนยันใหม่ทุกครั้งก่อน
  swap / เพิ่ม / ถอนสภาพคล่อง (ไม่เก็บการยืนยันไว้)
- RPC ที่เก็บไว้ต้องอยู่ในรูปที่หน้าเว็บบันทึกเองพอดี (https หรือ localhost) ถ้าไม่ใช่ค่าเริ่มต้นมีแถบเตือนตลอดและไม่ส่งให้กระเป๋า
- สวิตช์ "เหรียญหักค่าธรรมเนียมเมื่อโอน" ไม่ถูกเก็บ (ปิดทุกครั้งที่เปิดหน้า)
- เหรียญที่นำเข้าเอง: อ่านกลับเฉพาะรายการของ chain 77390 ที่ผ่านการตรวจ ไม่ซ้ำ ไม่เกิน 50 รายการ แสดงป้าย
  **"นำเข้าเอง ไม่อยู่ในรายการ"** ในตัวเลือกเหรียญและในรายการ และเตือนพร้อมที่อยู่สัญญาเมื่อเลือกใช้ และถาม Neuro ใหม่ตอนกดยืนยัน
- id กระเป๋า ภาษา และธีม ต้องตรงรูปแบบที่กำหนด

- ดูในเครื่อง: `cd zetaphy-dex && python3 -m http.server -d web 8000` (หรือ server static ใดก็ได้ที่ root คือ `web/`) แล้วเปิด
  `http://localhost:8000/` (server นี้ไม่ส่ง header ของ `vercel.json`; `npm run test:web` ทดสอบภายใต้ CSP จริง)

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
- ใครก็ส่งเหรียญหลักเข้าพูลโดยตรงผ่าน bank send ได้ (ยอดเกิน reserve): `skim` ดึงออก `sync` ปรับ reserve ตาม
- ไม่มี `permit` (EIP-2612) สำหรับ LP: การถอนต้อง approve ก่อน (หน้าเว็บ approve เท่าที่ถอนพอดี)

## สัญญาอนุญาต

MIT (ดู `LICENSE`) เขียนใหม่ทั้งหมด ไม่มีโค้ดจาก Uniswap (GPL-3.0) ใช้เพียงสูตรคณิตศาสตร์ที่เผยแพร่ใน whitepaper

## DLMM (สภาพคล่องแบบแบ่งช่องราคา / bins) — ⚠️ ยังไม่ผ่านการตรวจสอบความปลอดภัย (UNAUDITED)

> ⚠️ **ส่วนนี้ใหม่ ยังไม่ผ่าน audit ใช้บน testnet เท่านั้น** เหรียญทดสอบไม่มีมูลค่า ไม่ใช่คำแนะนำการลงทุน

DLMM คือพูลที่แบ่งสภาพคล่องเป็น **ช่องราคา (bin)** แต่ละช่องมีราคาคงที่ ผู้ให้สภาพคล่องเลือกช่วงราคาที่จะวางเหรียญเองได้
(สภาพคล่องกระจุกตัว) เป็นการพอร์ตการออกแบบ DLMM ของเราเองบน Solana (`programs/swd_amm/src/dlmm.rs`
และค่าธรรมเนียมตามความผันผวนจาก `swdmm_math.rs`) มาเป็น Solidity **เขียนใหม่ทั้งหมดภายใต้ MIT**
(ตรวจแล้ว: Trader Joe Liquidity Book `traderjoe-xyz/joe-v2` ใช้สัญญาอนุญาต MIT แต่ **ไม่ได้คัดลอกโค้ดของใครมา**)
แยกจาก AMM x·y = k เดิมโดยสมบูรณ์ (ไม่ได้แก้ Factory / Pair / Router เดิม)

| ไฟล์ | หน้าที่ |
|---|---|
| `contracts/dlmm/DlmmMath.sol` | คณิตศาสตร์ fixed-point 128.128 (ราคาของแต่ละ bin, mulDiv 512 บิต) และ bitmap หา bin ถัดไปที่มีสภาพคล่อง |
| `contracts/dlmm/ZetaphyDlmmPair.sol` | พูล DLMM (bins, swap ข้าม bin, ฝาก/ถอน, ค่าธรรมเนียม, บัญชีหุ้นต่อ bin) และ `ZetaphyDlmmPairDeployer` (เก็บโค้ดของพูล) |
| `contracts/dlmm/ZetaphyDlmmFactory.sol` | สร้างพูล 1 พูลต่อ (คู่เหรียญ, bin step) และค่าที่ governance ตั้งได้ |
| `contracts/dlmm/ZetaphyDlmmRouter.sol` | ฟังก์ชันที่ผู้ใช้เรียก: เพิ่ม/ถอนสภาพคล่องเป็นช่วง, swap (exact in / exact out, หลายทอด), เหรียญหลัก, ตรวจ Neuro |
| `contracts/test/DlmmTestHelpers.sol` | สัญญาสำหรับเทสต์เท่านั้น |
| `dlmm-cli.js` | deploy DLMM (factory + router + preset เริ่มต้น) และตั้งค่า governance |
| `web/dlmm.js`, `web/lib/dlmm.js` | แท็บ DLMM ในหน้าเว็บ (เลือกคู่/bin step, ดู bin รอบราคา, เพิ่ม/ถอนสภาพคล่องเป็นช่วง, swap) |
| `test/dlmm*.test.js`, `test/web.dlmm.e2e.js`, `test/devnet.dlmm.integration.js` | เทสต์ (ดูด้านล่าง) |

**การทำงาน**

- **ราคาของ bin:** bin หมายเลข `id` มีราคา `(1 + binStep/10000)^id` (หน่วย: tokenY ต่อ tokenX แบบหน่วยเล็กสุด ไม่สนทศนิยม)
  `binStep` เป็น bps เช่น 10 = ห่างกัน 0.1% ต่อ bin คำนวณแบบ fixed-point 128.128 ราคาอยู่ในช่วง 2⁻⁹⁶ ถึง 2⁹⁶
  (bin ที่อยู่นอกช่วงนี้ใช้ไม่ได้) tokenX คือเหรียญที่ที่อยู่ (address) น้อยกว่า
- **active bin** คือราคาปัจจุบัน: bin ที่สูงกว่าราคาถือ X อย่างเดียว (ขาย X เมื่อราคาขึ้นถึง), bin ที่ต่ำกว่าถือ Y อย่างเดียว,
  active bin ถือได้ทั้งสองอย่าง การฝากต้องเป็นไปตามกฎนี้
- **swap** เริ่มที่ active bin แล้วข้ามไปทีละ bin ที่มีสภาพคล่อง (ข้าม bin ว่างได้ทันทีด้วย bitmap) ในแต่ละ bin ราคาไม่ขยับ
  ข้ามได้สูงสุด 100 bin ต่อ swap (ถ้าต้องมากกว่านั้นให้แบ่งเป็นหลายครั้ง) ถ้าสภาพคล่องไม่พอ ธุรกรรมจะ revert ทั้งหมด (ไม่มีการเติมบางส่วน)
- **การปัดเศษเข้าข้างพูลเสมอ:** จำนวนที่ผู้ใช้จ่ายและค่าธรรมเนียมปัดขึ้น จำนวนที่ได้รับและหุ้นที่ได้ปัดลง
- **หุ้น (shares) แยกต่อ bin** (บัญชีภายในแบบ ERC-1155 ไม่มี callback): ฝากครั้งแรกใน bin ว่างได้หุ้น = `x·ราคา + y·2¹²⁸`
  ฝากครั้งต่อไปได้หุ้นตามสัดส่วน และ bin จะรับเหรียญตามสัดส่วน X:Y ที่มีอยู่เท่านั้น ส่วนเกินคืนให้ผู้ฝาก
  ถอนได้ส่วนแบ่งของ bin ตามสัดส่วนหุ้น ฝาก/ถอน/โอนได้สูงสุด 100 bin ต่อครั้ง
- **ค่าธรรมเนียม** = ค่าพื้นฐาน (base fee ตาม preset ของ bin step) + **ค่าตามความผันผวน** (volatility fee: ยิ่งราคาเพิ่งวิ่งผ่านหลาย bin
  ยิ่งสูง ค่อย ๆ ลดลงตามเวลา มีเพดาน) รวมไม่เกิน 10% ค่าธรรมเนียมอยู่ใน bin ที่เกิดการซื้อขาย (เป็นของ LP ของ bin นั้น)
  ยกเว้น **protocol share** (ค่าเริ่มต้น 0, สูงสุด 50% ของค่าธรรมเนียม) ซึ่งใครก็สั่ง `collectProtocolFees()` ให้ส่งไปที่ `feeTo` ได้
- **บัญชีภายใน:** พูลจำยอดของตัวเอง เหรียญที่โอนเข้ามาตรง ๆ (donation) ไม่เปลี่ยน bin หรือราคา `skim(to)` ดึงส่วนเกินออก
- **ไม่มี flash swap และไม่มี callback** ทุกฟังก์ชันที่เปลี่ยนสถานะมี reentrancy lock

**Router** (`ZetaphyDlmmRouter`) ทุกฟังก์ชันมี `deadline` และขอบเขต slippage ของผู้ใช้:

- `addLiquidity(params)` / `addLiquidityNATIVE(params)`: ระบุ bin แบบ **สัมพัทธ์กับ active bin** (`deltaIds`) พร้อมจำนวน X และ Y ของแต่ละ bin
  (รูปแบบการกระจาย เช่น spot / curve / bid-ask เป็นเรื่องของหน้าเว็บ), `activeIdDesired` + `idSlippage` (ราคาเลื่อนได้กี่ bin),
  `amountXMin` / `amountYMin` (ยอดที่ถูกใช้จริงขั้นต่ำ) ส่วนที่ bin ไม่รับคืนให้ทันที (เหรียญหลักคืนเป็นเหรียญหลัก)
  ถ้าพูลยังว่างทั้งพูล router จะตั้ง active bin เป็น `activeIdDesired` ก่อนฝากในธุรกรรมเดียวกัน (**ผู้ฝากรายแรกเป็นผู้กำหนดราคา**)
- `removeLiquidity` / `removeLiquidityNATIVE`: ต้องเรียก `pair.setApprovalForAll(router, true)` ก่อน (อนุญาตให้ router เผาหุ้นของเรา;
  ยกเลิกได้ด้วย `false`) พร้อม `amountXMin` / `amountYMin`
- `swapExactTokensForTokens`, `swapTokensForExactTokens`, `swapExactNATIVEForTokens`, `swapNATIVEForExactTokens`,
  `swapExactTokensForNATIVE`, `swapTokensForExactNATIVE`: เส้นทาง `path = (binSteps[], tokens[])` หลายทอดได้
  ใบเสนอราคา: `getAmountsOut` / `getAmountsIn` (หรือ `pair.getSwapOut` / `pair.getSwapIn`)
- เหรียญหลัก (NATIVE) ใช้ `WNATIVE` แบบเดียวกับ router เดิม: บน ZETAPHY คือ precompile `0xEeee…EEeE` (ทดสอบบน devnet จริงแล้ว)
- **ไม่รองรับเหรียญหักค่าธรรมเนียมเมื่อโอน** (router ปฏิเสธด้วย `FeeOnTransferNotSupported`) และ **ไม่รองรับเหรียญ rebase**
  (ถ้ายอดของพูลลดลงเอง พูลจะไม่ยอมจ่ายเกินที่ถืออยู่: `BalanceBelowReserves`)

**Neuro:** กฎเดียวกับ router เดิม เมื่อ governance ตั้ง `dlmmFactory.setThreatRegistry(<ThreatRegistry>)` router ปฏิเสธการซื้อ (swap เข้า)
และการเพิ่มสภาพคล่องของเหรียญที่ธง "มีผลบังคับ" แล้ว (`TokenEnforced(token, reason)`) และ fail closed (`RegistryUnavailable`)
ถ้า registry ไม่ตอบ การขายเป็นเหรียญหลักและการถอนสภาพคล่องทำได้เสมอ ผลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา

**governance (บอกตามจริง):** ฟังก์ชันผู้ดูแลทั้งหมดอยู่ใต้ **บทบาทเดียว `governance`** จึงส่งมอบทั้งหมดให้ TimelockController
(หรือ multisig) ได้ในสองขั้น: `setGovernance(<timelock>)` แล้วให้ timelock execute `acceptGovernance()`

- *ทำได้:* เปิด/แก้/ปิด preset (bin step + ค่าธรรมเนียม) สำหรับ **พูลใหม่**, ตั้ง `feeTo`, ตั้ง protocol share (≤ 50% ของค่าธรรมเนียม)
  ของพูลใหม่และพูลที่มีอยู่, ตั้ง/ปิด `threatRegistry` (ซึ่งหยุดการซื้อผ่าน router ได้ถ้า registry หยุดตอบ เหมือน router เดิม),
  `router.sweep(to)` (เหรียญหลักที่หลงเข้า router)
- *ทำไม่ได้:* ย้ายเงินของใคร หยุดพูล เปลี่ยนค่าธรรมเนียมหรือ bin step ของพูลที่สร้างแล้ว หรืออัปเกรดสัญญา (ไม่มี proxy)

**Deploy และหน้าเว็บ**

```bash
cd zetaphy-dex
# deploy factory + router (WNATIVE = precompile บน ZETAPHY) + preset 1/10/25/100 bps
# แล้วเพิ่ม contracts.dlmmFactory / dlmmRouter ลงไฟล์ deployments ของ cli.js และ (ถ้าใส่ --web) web/deployments.json
node dlmm-cli.js deploy --rpc <url> --key-file <file> [--web] [--governance <timelock>] [--fee-to <addr>]
node dlmm-cli.js status --rpc <url>
node dlmm-cli.js set-registry <ThreatRegistry|0x0> --rpc <url> --key-file <file>
```

กฎของไฟล์กุญแจเหมือน `cli.js` (ไฟล์เท่านั้น chmod 600, ไม่รับกุญแจทาง command line) และ deploy ได้เฉพาะเชน 77390 ยกเว้นใส่ `--any-chain`
preset เริ่มต้น: bin step 1 / 10 / 25 / 100 bps, ค่าธรรมเนียมพื้นฐานเท่ากับ bin step, ค่าตามความผันผวนสูงสุด +50 / +100 / +150 / +300 bps

แท็บ **DLMM** ในหน้าเว็บอ่าน `contracts.dlmmFactory` / `contracts.dlmmRouter` จาก `web/deployments.json` (ไม่มี = แสดงว่ายังไม่ได้ deploy)
ใช้กระเป๋า, RPC, การตรวจ Neuro (ปฏิเสธเหรียญที่ธงมีผลบังคับ เตือนและให้ติ๊กยืนยันเมื่อมีธง) และค่า slippage/deadline เดียวกับหน้าเดิม
อนุญาตเหรียญเท่าที่จะใช้พอดี และขอ `setApprovalForAll` เฉพาะตอนถอน (มีปุ่มยกเลิกสิทธิ์)

**ทดสอบ**

```bash
cd zetaphy-dex
npm run build && npm test     # รวมเทสต์ DLMM: dlmm.math / dlmm / dlmm.security / dlmm.neuro / dlmm.fuzz / dlmm.web-lib / dlmm.cli
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:web                          # รวมแท็บ DLMM (web.dlmm.e2e.js)
ZDLMM_FUZZ_SEED=1,2,3,4 ZDLMM_FUZZ_STEPS=200 node --test test/dlmm.fuzz.test.js     # fuzz เพิ่ม (seed หลายค่าได้)
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet:dlmm  # บน devnet จริง (พอร์ต ZDLMM_DEVNET_PORT, ค่าเริ่มต้น 24745)
```

ครอบคลุม: ราคาเทียบค่าที่คำนวณแบบแม่นยำ ขอบช่วงราคา mulDiv 512 บิต bitmap, swap ตรงกับโมเดล BigInt ทุก wei, exact-out ที่น้อยที่สุด,
ค่าธรรมเนียมตามความผันผวน, protocol fee, หลายทอด, เหรียญหลัก, slippage/deadline, การฝากครั้งแรก, reentrancy, donation,
เหรียญหักค่าธรรมเนียม/rebase, bin สุดขอบ, ขีดจำกัดการข้าม bin, Neuro และ fuzz ที่ตรวจ invariant ทุกขั้น
(ยอดรวมของ bin = reserve, พูลถือเหรียญครบ, หุ้นรวม = totalSupply, มูลค่าต่อหุ้นของ bin ไม่ลดลง)

**แก๊ส (โดยประมาณ)**

| การทำงาน | EVM ในหน่วยความจำ (execution gas ไม่รวม 21,000 + calldata) | devnet จริง (gasUsed ของธุรกรรม, ผ่าน precompile เหรียญหลัก) |
|---|---|---|
| swap ภายใน 1 bin | ~60,700 | 143,594 (ZTPHY → tUSD), 139,044 (tUSD → ZTPHY) |
| swap exact-out (1 bin, คืนเงินทอน) | — | 160,986 |
| swap ข้าม 6 / 21 / 50 bin | ~106,800 / ~243,300 / ~508,900 | 179,551 (25 ZTPHY ข้ามหลาย bin) |
| swap ข้ามสูงสุด (100 ครั้ง) | ~1,000,700 | — |
| swap 2 ทอด | — | 198,427 |
| เพิ่มสภาพคล่องใน bin ใหม่ | ~77,000–80,000 ต่อ bin | 5,458,820 (21 bin รวมสร้างพูลใหม่ ~3.6M) |
| ถอนสภาพคล่อง 21 bin | — | 455,540 |

(คอลัมน์ devnet ใช้ preset เริ่มต้นของ `dlmm-cli.js` ซึ่งมีค่าธรรมเนียมตามความผันผวน; คอลัมน์ในหน่วยความจำใช้ preset ไม่มีค่าตามความผันผวน)

**ยังไม่ได้ทำ:** TWAP/oracle ของ DLMM (ห้ามใช้ราคา active bin เป็น oracle), เส้นทาง swap อัตโนมัติข้ามหลายพูลในหน้าเว็บ (แท็บ DLMM swap ภายในพูลที่เลือก; router รองรับหลายทอดแล้ว)
และยังไม่ได้ deploy บน testnet

**ความเสี่ยง (สำหรับผู้ใช้):** ยังไม่ผ่าน audit; ผู้ให้สภาพคล่องรายแรกของพูลเป็นผู้กำหนดราคาเริ่มต้น ตรวจ active bin ก่อนฝากเสมอ
(ตั้ง `idSlippage` ให้แคบ); สภาพคล่องที่อยู่ในช่วงราคาแคบจะกลายเป็นเหรียญอีกฝั่งทั้งหมดเมื่อราคาวิ่งผ่าน (impermanent loss
สูงกว่าพูล x·y = k ได้); swap ใหญ่ที่ต้องข้ามมากกว่า 100 bin ต้องแบ่งทำหลายครั้ง; ตั้ง slippage ให้แคบเพราะถูก front-run / sandwich ได้;
`setApprovalForAll(router)` ให้สิทธิ์ router เผาหุ้นทุก bin ของพูลนั้นในนามเรา (router ใช้กับผู้เรียกเองเท่านั้น) ยกเลิกได้เมื่อเลิกใช้
รายละเอียดด้านความปลอดภัยเก็บแยกไว้สำหรับทีม
