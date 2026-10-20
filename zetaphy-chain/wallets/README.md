# ZETAPHY กับกระเป๋าต่าง ๆ

วิธีเพิ่ม ZETAPHY Testnet ในกระเป๋าที่คนใช้กันทั่วไป ไฟล์ตั้งค่าสำหรับกระเป๋า และขั้นตอนการขึ้นรายชื่อ (chainlist, Keplr, chain-registry)

> testnet เท่านั้น เหรียญทดลอง ไม่มีมูลค่า

## ค่าของเครือข่าย

โหนดหนึ่งเครื่องให้บริการทุกอย่างบน https host เดียว คือ `https://<IP ที่เปลี่ยนจุดเป็นขีด>.sslip.io` (Caddy อยู่หน้าโหนด)
ในเอกสารนี้เรียก host นี้ว่า `HOST` เช่น IP `1.2.3.4` → `HOST` = `1-2-3-4.sslip.io`

| อะไร | ค่า |
|---|---|
| EVM JSON-RPC (MetaMask ฯลฯ) | `https://HOST` (มี `zetaphy_*` ด้วย) |
| CometBFT RPC (Keplr, Leap) | `https://HOST/rpc` (เช่น `https://HOST/rpc/status`) |
| Cosmos REST / LCD (Keplr, Leap) | `https://HOST/rest` |
| ไฟล์ของโหนด | `https://HOST/zetaphy/` (`genesis.json`, `peer`, `keplr.json`, `evm-chain.json`) |
| ชื่อเครือข่าย | `ZETAPHY Testnet` |
| EVM chain ID | `77390` (`0x12e4e`) |
| สัญลักษณ์เหรียญในกระเป๋า EVM | `ZPHY` (ดูหัวข้อถัดไป) |
| ทศนิยม | 18 |
| Cosmos chain-id | `zetaphy_77390-1` |
| denom | `azetaphy` (1 ZETAPHY = 10^18 azetaphy) |
| bech32 | `zetaphy`, `zetaphyvaloper`, `zetaphyvalcons` (และ `…pub`) |
| กุญแจ | eth_secp256k1, coin type 60: ที่อยู่ `0x…` และ `zetaphy1…` คือ 20 ไบต์เดียวกัน |
| ค่าแก๊ส | ขั้นต่ำ 1 gwei (1000000000 azetaphy) แบบ EIP-1559 |
| block explorer | ยังไม่มี (เว้นว่าง) |

### ทำไมสัญลักษณ์ในกระเป๋า EVM เป็น `ZPHY` ไม่ใช่ `ZETAPHY`

`ZETAPHY` ยาว 7 ตัวอักษร แต่
- MetaMask ปฏิเสธ `wallet_addEthereumChain` ที่ `nativeCurrency.symbol` ยาวเกิน 6 ตัว
  (`Expected 1-6 character string 'nativeCurrency.symbol'` ใน `app/scripts/lib/rpc-method-middleware/handlers/ethereum-chain-utils.ts` ของ metamask-extension)
- ethereum-lists/chains (ที่ chainlist.org อ่าน) ไม่รับสัญลักษณ์ 7 ตัวขึ้นไป (`NativeCurrencySymbolMustHaveLessThan7Chars`)

ปุ่มเพิ่มเครือข่ายและรายชื่อบน chainlist จึงใช้ `ZPHY` (ชื่อเหรียญยังเป็น `ZETAPHY`) ฝั่ง Cosmos (Keplr, Leap, chain-registry) ไม่มีข้อจำกัดนี้ จึงยังเป็น `ZETAPHY`
- ถ้าจะใช้ตัวอื่น (ไม่เกิน 6 ตัว) แก้พร้อมกัน 3 ที่: `EVM_SYMBOL` ใน `zetaphy-wallet/wallets.js`, `evm-add-chain.template.json` และ `ethereum-lists/eip155-77390.json` (test ของกระเป๋าเว็บตรวจว่าตรงกัน)
- ถ้าเพิ่มเครือข่ายเองใน MetaMask แล้วพิมพ์ `ZETAPHY` ก็ได้ แต่เมื่อ ZETAPHY อยู่บน chainlist แล้ว MetaMask จะเตือนว่าสัญลักษณ์ไม่ตรงกับรายชื่อ
- ไม่ต้อง import โทเคนที่ `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` เพราะเป็นเหรียญ ZETAPHY ตัวเดียวกันในรูป ERC-20 (จะเห็นยอดซ้ำสองครั้ง)

## กระเป๋าไหนใช้ได้

| กระเป๋า | ใช้ได้ไหม | วิธี |
|---|---|---|
| MetaMask (ส่วนขยาย, มือถือ) | ได้ | ปุ่ม หรือเพิ่มเอง |
| Rabby | ได้ | ปุ่ม หรือเพิ่มเอง |
| Trust Wallet | ได้ | ปุ่ม (ส่วนขยายประกาศตัวด้วย EIP-6963) หรือเพิ่มเองในแอปมือถือ |
| OKX Wallet | ได้ | ปุ่ม หรือเพิ่มเอง |
| Coinbase Wallet | ได้ | ปุ่ม หรือเพิ่มเอง |
| Brave Wallet, Rainbow, Zerion, Frame | ได้ | ปุ่ม หรือเพิ่มเอง |
| Ledger / Trezor | ได้ ผ่านกระเป๋า EVM ข้างบน (เช่น MetaMask) และ Ledger ผ่าน Keplr | ดูหัวข้อ Ledger |
| Keplr, Leap | ได้ | ปุ่ม (`experimentalSuggestChain`) |
| Cosmostation | น่าจะได้ (ยังไม่ได้ลองกับของจริง) | ปุ่ม (ใช้ interface แบบ Keplr ของ Cosmostation) |
| Binance Wallet | ยังไม่ยืนยัน | ในแอป Binance: ปุ่ม ถ้ากระเป๋ารับเครือข่ายใหม่ นอกแอป: WalletConnect (ยังไม่เปิด) |
| Phantom | ไม่ได้ จนกว่า Phantom จะเพิ่ม ZETAPHY เอง | - |
| กระเป๋าที่มีรายชื่อเชนตายตัว | ไม่ได้ จนกว่ากระเป๋าจะเพิ่ม ZETAPHY เอง | - |
| กระเป๋าที่มีแต่ Solana หรือ Bitcoin | ไม่ได้เลย (ไม่ใช่กระเป๋า EVM หรือ Cosmos) | - |

- "ใช้ได้" ในตารางนี้มาจากเอกสารของกระเป๋าแต่ละตัว (รองรับ `wallet_addEthereumChain` หรือให้เพิ่มเครือข่ายเอง)
  - ฝั่ง MetaMask ตรวจจากซอร์สโค้ดแล้ว
  - ปุ่มในหน้าเว็บทดสอบกับกระเป๋าจำลองใน `zetaphy-wallet/test/wallet.e2e.js` ยังไม่ได้ลองกับกระเป๋าจริงครบทุกตัว
- **ต้านควอนตัม** มีแค่ 2 อย่าง (ดูหัวข้อท้าย ๆ): กุญแจ ML-DSA-44 ในกระเป๋าเว็บ ZETAPHY และ ZETAPHY Snap ใน MetaMask

## 1. กระเป๋า EVM (MetaMask, Rabby, Trust, OKX, Coinbase ฯลฯ)

### ด้วยปุ่มในกระเป๋าเว็บ ZETAPHY (`zetaphy-wallet`)

1. เปิดหน้ากระเป๋าเว็บ ใส่ที่อยู่ RPC เป็น `https://HOST` แล้วกดบันทึก
2. เลื่อนลงไปที่ "ใช้ ZETAPHY กับกระเป๋าอื่น"
   - หน้าเว็บแสดงกระเป๋า EVM ทุกตัวในเบราว์เซอร์ พร้อมชื่อและไอคอน (EIP-6963)
   - กระเป๋ารุ่นเก่าที่ไม่ประกาศตัว หน้าเว็บใช้ `window.ethereum` แทน
3. กดเลือกกระเป๋าที่จะใช้ (หน้าเว็บจำไว้) แล้วกด **"เพิ่ม ZETAPHY ในกระเป๋านี้"**
   - หน้าเว็บส่ง `wallet_addEthereumChain` (EIP-3085) แล้ว `wallet_switchEthereumChain` ไปที่ `0x12e4e`
   - กระเป๋าแสดงหน้าต่างให้ยืนยัน
4. ถ้ากระเป๋าไม่ยอมเพิ่ม หน้าเว็บบอกเหตุผลที่กระเป๋าตอบ แล้วเปิดค่าสำหรับเพิ่มเอง
5. "เชื่อมกระเป๋านี้" แสดงที่อยู่ของบัญชีในกระเป๋านั้นทั้งแบบ `0x…` และ `zetaphy1…`, เครือข่ายที่กระเป๋าอยู่ และยอดเงิน

กระเป๋าที่เลือกไว้ใช้กับ "ล็อกบัญชี … ให้กระเป๋านี้" (ล็อกควอนตัม) ด้วย
ส่วนโหมด ZETAPHY Snap ใช้ได้เฉพาะ MetaMask: หน้าเว็บถาม `wallet_getSnaps` ก่อน ถ้ากระเป๋าไม่รองรับจะบอกให้เลือก MetaMask

ไฟล์เดียวกันนี้ (กรอก `HOST` แล้ว) อยู่บนโหนดที่ `https://HOST/zetaphy/evm-chain.json` สำหรับเว็บอื่นที่จะทำปุ่มแบบเดียวกัน

### เพิ่มเอง (ใช้ได้กับทุกกระเป๋า EVM ที่ให้เพิ่มเครือข่ายเอง)

ใส่ 5 ช่องนี้ ช่องอื่นเว้นว่างได้:

| ช่อง | ค่า |
|---|---|
| Network name | `ZETAPHY Testnet` |
| RPC URL | `https://HOST` |
| Chain ID | `77390` |
| Currency symbol | `ZPHY` |
| Block explorer URL | (เว้นว่าง) |

ทางเข้าเมนูของแต่ละกระเป๋า (ชื่อเมนูอาจต่างไปตามรุ่น):
- **MetaMask:** กดชื่อเครือข่ายด้านบน → **Add a custom network** → กรอก → Save
- **Rabby:** More → **Custom Network** → Add
- **Trust Wallet (แอปมือถือ):** Settings → Networks/Preferences → **Add custom network** (หรือปุ่ม +) → เลือกแบบ EVM → กรอก
  ขั้นตอนตามบทความช่วยเหลือของ Trust (support.trustwallet.com/en/articles/717170)
- **OKX Wallet:** ตั้งค่าเครือข่าย (Network) → **Add custom network** → กรอก
- **Coinbase Wallet:** Settings → Networks → **+ / Add custom network** → กรอก

## 2. Ledger (ผ่าน MetaMask, ธุรกรรม EVM)

1. ใน Ledger Live ติดตั้งแอป **Ethereum** ลงเครื่อง Ledger
2. MetaMask → เมนูบัญชี → **Add hardware wallet** → Ledger → เลือกบัญชี
3. เพิ่ม ZETAPHY Testnet ใน MetaMask (ปุ่มหรือเพิ่มเอง ตามข้อ 1)
4. ส่ง ZETAPHY ได้ตามปกติ
   - Ledger แสดง chain ID 77390 (Ledger ไม่รู้จักชื่อเชนนี้ เป็นเรื่องปกติ)
   - ธุรกรรมที่มี data ต้องเปิด **Blind signing** ในแอป Ethereum ของ Ledger
     เช่น โอนโทเคน ERC-20 หรือล็อกควอนตัม (ส่งไปที่ `0x…5051`)
- กุญแจใน Ledger เป็น ECDSA เหมือนกระเป๋า EVM อื่น จึงไม่ต้านควอนตัม
  ล็อกบัญชีนั้นให้กระเป๋า PQ ได้ แล้วกุญแจ Ledger จะใช้กับ ZETAPHY ไม่ได้อีก
- **Ledger ผ่าน Keplr ก็ได้**
  - chain-id `zetaphy_77390-1` เป็นแบบ Ethermint (`<ชื่อ>_77390-<n>`) และ `keplr.json` มี feature `force-enable-evm-ledger` ตามที่ Keplr ต้องการ
  - Keplr → Connect Ledger → เลือกแอป **Ethermint/EVM** ใน Ledger (ใช้แอป Ethereum) แล้วเซ็นแบบ EIP-712
  - เชนตรวจลายเซ็น EIP-712 แบบนี้ผ่านแล้วในชุดทดสอบ แต่ยังไม่ได้ลองกับเครื่อง Ledger จริง

## 3. กระเป๋า Cosmos (Keplr, Leap, Cosmostation)

ในกระเป๋าเว็บ ZETAPHY กด **"เพิ่มใน Keplr"**, **"เพิ่มใน Leap"** หรือ **"เพิ่มใน Cosmostation"**
- หน้าเว็บส่ง chain info ด้วย `experimentalSuggestChain` แล้ว `enable("zetaphy_77390-1")`
- จากนั้นแสดงที่อยู่ `zetaphy1…` ที่กระเป๋าตอบ (และแบบ `0x…` ของบัญชีเดียวกัน)
- Cosmostation ใช้ `window.cosmostation.providers.keplr` (interface แบบ Keplr ของ Cosmostation)

chain info คือ `keplr-chain-info.template.json` (โหนดเผยแพร่ฉบับกรอก HOST แล้วที่ `https://HOST/zetaphy/keplr.json`):
- `rpc` = `https://HOST/rpc`, `rest` = `https://HOST/rest`, `bip44.coinType` = 60
- `gasPriceStep` = 1e9 / 2e9 / 4e9 azetaphy
- `features`: `eth-address-gen`, `eth-key-sign` และ **`eth-secp256k1-cosmos`**
  - ตัวหลังจำเป็นสำหรับเชนที่สร้างจาก github.com/cosmos/evm (ตามคู่มือของ keplr-chain-registry)
  - ชนิด pubkey ของเชนนี้คือ `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey`
    ถ้าไม่มี feature นี้ Keplr ใส่ `/ethermint.crypto.v1.ethsecp256k1.PubKey` ซึ่งเชนถอดรหัสไม่ได้ ธุรกรรมจาก Keplr จึงไม่ผ่านเลย
  - ทดสอบบนเชนจริงด้วย `npm run test:devnet:cosmoswallet` ใน `zetaphy-network`
- `evm: {chainId: 77390, rpc: "https://HOST"}` ให้ Keplr รุ่นใหม่ใช้ฝั่ง EVM ด้วย
- `isTestnet: true`

สิ่งที่โหนดต้องมี (setup-node.sh ทำให้):
- `/rpc` ส่งต่อไปที่ CometBFT RPC รวม websocket (`wss://HOST/rpc/websocket`)
- `/rest` ส่งต่อไปที่ Cosmos REST
- ทั้งสองต้องเป็น https: Keplr ไม่รับ http

## 4. มือถือ

- **ทางที่ง่ายที่สุด:** เปิดหน้ากระเป๋าเว็บ ZETAPHY ใน **เบราว์เซอร์ที่อยู่ในแอปกระเป๋า**
  (MetaMask Mobile, Trust, OKX, Coinbase Wallet, แอป Binance)
  - แอปเหล่านี้ใส่ `window.ethereum` ให้หน้าเว็บ หน้าเว็บจึงเห็นกระเป๋าในรายการเหมือนบนคอมพิวเตอร์ แล้วกด "เพิ่ม ZETAPHY ในกระเป๋านี้" ได้เลย
- ถ้าเปิดหน้าเว็บในเบราว์เซอร์ธรรมดาบนมือถือ หน้าเว็บแสดงลิงก์ "เปิดในแอป" ของ MetaMask, Trust Wallet, Coinbase Wallet และ OKX Wallet
- เพิ่มเองในแอป: ใช้ค่า 5 ช่องในข้อ 1 (Trust Wallet: Settings → Networks → Add custom network)
- **WalletConnect** (เชื่อมกระเป๋าบนมือถือจากเบราว์เซอร์อื่น) ยังปิดอยู่ ดูหัวข้อถัดไป

### WalletConnect: ขั้นต่อไป

ปุ่ม WalletConnect ในหน้าเว็บกดไม่ได้จนกว่าจะมี projectId และตอนนี้ยังไม่มีโค้ด WalletConnect ในหน้าเว็บ
1. เจ้าของสมัคร projectId ฟรีที่ **cloud.reown.com** (Reown คือ WalletConnect เดิม)
   - ใส่โดเมนของกระเป๋าเว็บใน allowlist ของโปรเจกต์
2. ใส่ projectId ใน `<meta name="zetaphy-walletconnect-project-id" content="…">` ของ `zetaphy-wallet/index.html`
   หรือในช่อง "ตั้งค่าเพิ่มเติม" ของหน้าเว็บ (จำไว้ในเบราว์เซอร์นั้น)
3. ขั้นต่อไปคือใส่ WalletConnect SDK ลงใน bundle (`zetaphy-wallet/src/entry.js` → `npm run build`) แล้วต่อเข้ากับปุ่มนี้
   - CSP มี `connect-src *` อยู่แล้ว จึงต่อ relay ของ WalletConnect ได้

## 5. Binance

- **ในแอป Binance (DApp browser ของ Binance Web3 Wallet):**
  - กระเป๋าใส่ `window.binancew3w.ethereum` ให้หน้าเว็บ หน้าเว็บแสดงเป็น "Binance Wallet"
  - ถ้ากระเป๋าประกาศตัวด้วย EIP-6963 (rdns `com.binance.wallet` หรือชื่อมีคำว่า Binance) ก็แสดงด้วย
  - ปุ่มเพิ่มเครือข่ายและล็อกควอนตัมใช้วิธีเดียวกับกระเป๋า EVM อื่น
  - **ยังไม่ยืนยัน** ว่า Binance Wallet ยอมให้เพิ่มเครือข่ายใหม่ ถ้าไม่ยอม (เช่น error 4200 หรือปฏิเสธเชน) หน้าเว็บบอกว่ากระเป๋านี้อาจยังไม่รับเครือข่ายใหม่ และเปิดค่าสำหรับเพิ่มเอง
- **นอกแอป Binance:** Binance Web3 Wallet เชื่อมด้วย WalletConnect v2 ซึ่งต้องมี projectId ของ Reown และ SDK ก่อน (ดูหัวข้อ WalletConnect)
- **ให้ Binance (กระดาน) รับฝาก/ถอน ZETAPHY** เป็นการยื่นขอ listing กับ Binance ทางธุรกิจ โค้ดทำแทนไม่ได้

## 6. Phantom

Phantom ให้เพิ่มเครือข่ายเองไม่ได้ รองรับเฉพาะเชนที่ Phantom เลือกไว้
(Solana, Ethereum, Polygon, Bitcoin, Base, HyperEVM, Robinhood Chain ตาม help.phantom.com/hc/en-us/articles/46595961428627)
- Phantom จึงใช้กับ ZETAPHY ไม่ได้จนกว่า Phantom จะเพิ่ม ZETAPHY เอง ซึ่งเป็นการขอทางธุรกิจกับ Phantom ไม่ใช่โค้ด
- หน้าเว็บยังแสดง Phantom ในรายการถ้าเจอ (EIP-6963 rdns `app.phantom` หรือ `window.phantom.ethereum`)
  - พอเลือก หน้าเว็บเตือนก่อนว่า Phantom เพิ่มเครือข่ายไม่ได้ และแนะนำกระเป๋าอื่น
  - ถ้ากดเพิ่มแล้ว Phantom ปฏิเสธ หน้าเว็บอธิบายแบบเดียวกับ Binance

## 7. กระเป๋าไหนต้านควอนตัม

| กระเป๋า | ลายเซ็น | ต้านควอนตัม |
|---|---|---|
| กระเป๋าเว็บ ZETAPHY (กุญแจในหน้าเว็บ) | ML-DSA-44 (FIPS 204) | ใช่ |
| ZETAPHY Snap ใน MetaMask | ML-DSA-44 (กุญแจสร้างใน MetaMask จาก Secret Recovery Phrase) | ใช่ |
| MetaMask, Rabby, Trust, OKX, Coinbase, Binance, Ledger, Keplr, Leap, Cosmostation ฯลฯ | ECDSA secp256k1 | ไม่ |

ทำไมกระเป๋าอื่นไม่ต้านควอนตัม:
- ECDSA ปลอดภัยเพราะถอดกุญแจลับจากกุญแจสาธารณะไม่ได้ในทางปฏิบัติ
- แต่คอมพิวเตอร์ควอนตัมที่ใหญ่พอทำได้ด้วย Shor's algorithm
- กุญแจสาธารณะถูกเปิดเผยบนเชนตั้งแต่ธุรกรรมแรกของบัญชี ใครเก็บไว้ก็รอถอดทีหลังได้
- กระเป๋าเหล่านี้ทำงานกับกุญแจ ECDSA เท่านั้น การเพิ่มเครือข่าย ZETAPHY ไม่ได้เปลี่ยนชนิดลายเซ็น

ทางป้องกันบน ZETAPHY คือ **ล็อกควอนตัม**:
- ย้ายการควบคุมบัญชี ECDSA (เช่น ใน MetaMask หรือ Ledger) ไปให้กระเป๋า ML-DSA
- หลังล็อก เชนไม่รับลายเซ็น ECDSA ของบัญชีนั้นอีก
- ทำได้จากการ์ด "ล็อกบัญชี … ให้กระเป๋านี้" ในกระเป๋าเว็บ ด้วยกระเป๋า EVM ที่เลือกไว้

## 8. ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `evm-add-chain.template.json` | พารามิเตอร์ของ `wallet_addEthereumChain` (EIP-3085) ห้ามเพิ่ม key อื่น เพราะ MetaMask ปฏิเสธ |
| `keplr-chain-info.template.json` | chain info ของ `experimentalSuggestChain` (Keplr, Leap, Cosmostation) |
| `chain-registry/zetaphytestnet/` | `chain.json`, `assetlist.json`, `images/zetaphy.svg` สำหรับ `testnets/` ของ cosmos/chain-registry |
| `ethereum-lists/eip155-77390.json` | สำหรับ `_data/chains/` ของ ethereum-lists/chains (chainlist.org) |

- กรอก `HOST` ด้วยชื่อ https ของโหนด (ไม่มี `https://`):
  ```bash
  sed 's/HOST/1-2-3-4.sslip.io/g' keplr-chain-info.template.json > keplr.json
  ```
- `chain-registry/zetaphytestnet/chain.json` มี `NODE_ID` ด้วย คือส่วนหน้า `@` ในไฟล์ `https://HOST/zetaphy/peer`
- หน้าเว็บ (`zetaphy-wallet/wallets.js`) สร้างค่าชุดเดียวกันเองจากที่อยู่ RPC ที่ผู้ใช้ใส่ test ตรวจว่าตรงกับ template ทุกช่อง
- `keplr.json` และ `evm-chain.json` ที่ `setup-node.sh` เผยแพร่ควรตรงกับ template เหล่านี้
  (สัญลักษณ์ `ZPHY`, `features` มี `eth-secp256k1-cosmos`, `isTestnet: true`)
- ชื่อโฟลเดอร์คือ `zetaphytestnet` ไม่ใช่ `zetaphy-testnet` เพราะ chain-registry บังคับ:
  - `chain_name` ต้องตรงกับชื่อโฟลเดอร์
  - URL ของรูปต้องเป็น `[a-z0-9]+` (ทั้ง registry ไม่มีชื่อเชนที่มีขีด)

ตรวจแล้ว (20 ต.ค. 2026):
- `chain.json` และ `assetlist.json` ผ่าน schema ของ chain-registry, `validate_data.mjs` และ `@chain-registry/cli validate`
  ไม่มีเชนอื่นใช้ chain-id หรือ prefix นี้
- `eip155-77390.json` ผ่าน schema ของ ethereum-lists, กฎใน `processor/Main.kt` และ prettier
  77390 ยังว่างใน ethereum-lists (ไม่มีไฟล์ `eip155-77390.json`) และไม่มีเชนอื่นใช้ชื่อหรือ shortName นี้

## 9. ขึ้นรายชื่อ: chainlist, Keplr, chain-registry

### ต้องมีก่อน

- **โหนดสาธารณะที่เปิดตลอด**
  - ตอบ `eth_chainId` = `0x12e4e`
  - `https://HOST/rpc/status` บอก network `zetaphy_77390-1`
  - `https://HOST/rest/cosmos/base/tendermint/v1beta1/node_info` ตอบได้
  - websocket `wss://HOST/rpc/websocket` เปิดได้
  - registry ตรวจการเชื่อมต่อเหล่านี้ตอนรับ PR
- **ชื่อโดเมนที่ไม่เปลี่ยน** (แนะนำ)
  - `sslip.io` ผูกกับ IP ถ้า IP ของเครื่องเปลี่ยน ทุกรายชื่อพังพร้อมกัน
  - ใช้โดเมนของตัวเอง (A record ชี้ไปที่ IP) แล้วให้ Caddy ขอใบรับรองให้ชื่อนั้น
- **บัญชี GitHub ของเจ้าของ** สำหรับ fork และเปิด PR
- ถ้ามีโหนดสาธารณะหลายเครื่อง ใส่ทุกเครื่องในรายการ RPC: โหนดเดียวคือจุดล้มจุดเดียว

### chainlist.org (PR ไปที่ ethereum-lists/chains)

chainlist.org และ chainid.network อ่านรายชื่อจาก github.com/ethereum-lists/chains
MetaMask ก็ใช้ข้อมูลนี้เตือนเมื่อชื่อหรือสัญลักษณ์ไม่ตรง
1. เปิด https://github.com/ethereum-lists/chains/pulls ค้นหา `77390` ให้แน่ใจว่าไม่มี PR อื่นขอ chain ID นี้อยู่
   - PR แรกที่ merge ได้ chain ID ไป
2. กด **Fork** แล้ว clone fork ของคุณ:
   ```bash
   git clone https://github.com/<บัญชีของคุณ>/chains.git && cd chains
   git checkout -b add-zetaphy-testnet
   ```
3. คัดลอกไฟล์และกรอก HOST:
   ```bash
   sed 's/HOST/<ชื่อ https ของโหนด>/g' <repo นี้>/zetaphy-chain/wallets/ethereum-lists/eip155-77390.json > _data/chains/eip155-77390.json
   ```
   - `faucets` ว่างไว้ เพราะ faucet ของ ZETAPHY เป็นเมธอด JSON-RPC (`zetaphy_faucet`) ไม่ใช่หน้าเว็บ
   - ถ้ามีหน้าเว็บ faucet ใส่ URL ได้
   - `infoURL` ชี้ไปที่ github.com/pospos191-alt/zetaphy-chain ถ้ามีเว็บของโปรเจกต์ใช้เว็บนั้นแทน
4. (ไม่บังคับ) ไอคอน:
   - เพิ่ม `_data/icons/zetaphy.json` ตามรูปแบบใน README ของ ethereum-lists
   - ไฟล์ต้องอยู่บน IPFS และดึงได้ด้วย `ipfs get`, ขนาดน้อยกว่า 250 kB
   - แล้วใส่ `"icon": "zetaphy"` ในไฟล์เชน
5. ตรวจก่อนส่ง:
   ```bash
   npx prettier --check _data/chains/eip155-77390.json
   ./gradlew run                      # ต้องมี Java 17 ขึ้นไป
   ./gradlew run --args="rpcConnect"  # ต่อ RPC จริงแล้วเทียบ chain ID
   ```
6. commit แล้วเปิด PR ชื่อ `Add ZETAPHY Testnet (77390)` รอ CI เขียว
   - ถ้าแก้ตาม CI แล้ว ให้กด re-request review
7. หลัง merge chainid.network อัปเดตเอง แล้ว chainlist.org จะแสดง ZETAPHY Testnet พร้อมปุ่ม "Add to MetaMask"

### Keplr (PR ไปที่ chainapsis/keplr-chain-registry)

Keplr มี registry ของตัวเองที่ github.com/chainapsis/keplr-chain-registry และรับ testnet (`isTestnet: true`)
**ไม่ได้อ่านจาก cosmos/chain-registry** ต้องส่ง PR แยก
1. Fork แล้ว clone https://github.com/chainapsis/keplr-chain-registry
2. สร้าง `cosmos/zetaphy-testnet.json`
   - ชื่อไฟล์คือ chain-id ที่ตัดเลขรุ่น `-1` ออก
   - ใช้ `keplr-chain-info.template.json` ที่กรอก HOST แล้ว และเพิ่ม:
     ```json
     "chainSymbolImageUrl": "https://raw.githubusercontent.com/chainapsis/keplr-chain-registry/main/images/zetaphy-testnet/chain.png",
     "nodeProvider": { "name": "ZETAPHY", "email": "<อีเมลติดต่อเรื่องโหนด>", "website": "<เว็บของโปรเจกต์>" }
     ```
   - คง `"isTestnet": true` ไว้ และห้ามใส่ `coinGeckoId` (testnet ใส่ไม่ได้)
3. ใส่รูป `images/zetaphy-testnet/chain.png` เป็น PNG 256×256
   Keplr ตัดเป็นวงกลม ใช้รูปจาก `chain-registry/zetaphytestnet/images/zetaphy.svg` แปลงเป็น PNG ได้
4. ตรวจ:
   ```bash
   yarn install
   yarn validate cosmos/zetaphy-testnet.json
   ```
   - ต่อ RPC, websocket, REST และ EVM RPC จริง โหนดจึงต้องเปิดอยู่
5. commit แล้วเปิด PR
   - หลัง merge Keplr จะแสดง ZETAPHY Testnet ในรายการเชน (ติดป้าย "Community-Driven")

### cosmos/chain-registry (PR ไปที่ testnets/)

github.com/cosmos/chain-registry เป็นแหล่งข้อมูลกลางที่เครื่องมือ Cosmos หลายตัวอ่าน (cosmos-kit, explorer, Skip ฯลฯ)
1. Fork แล้ว clone https://github.com/cosmos/chain-registry
2. คัดลอกโฟลเดอร์ แล้วกรอก HOST และ NODE_ID:
   ```bash
   cp -r <repo นี้>/zetaphy-chain/wallets/chain-registry/zetaphytestnet testnets/
   sed -i 's/HOST/<ชื่อ https ของโหนด>/g; s/NODE_ID/<node id จาก https://HOST/zetaphy/peer>/' testnets/zetaphytestnet/chain.json
   sed -i 's/HOST/<ชื่อ https ของโหนด>/g' testnets/zetaphytestnet/assetlist.json
   ```
   - ถ้ามีหลายโหนด เพิ่มใน `apis` และ `peers` ได้
   - (ไม่บังคับ) เพิ่ม PNG สี่เหลี่ยมจัตุรัสใน `images/` แล้วอ้างใน `images` ทั้งสองไฟล์
     ทุกรูปในโฟลเดอร์ต้องถูกอ้างถึง
3. ตรวจ (แบบเดียวกับ CI ของเขา):
   ```bash
   npx @chain-registry/cli@1.47.0 validate --registryDir . --logLevel error
   (cd .github/workflows/utility && node validate_data.mjs NO_API)
   ```
4. commit แล้วเปิด PR ชื่อ `Add ZETAPHY Testnet (zetaphy_77390-1)`
   - เมื่อมี release ที่ติด tag ให้เพิ่ม `codebase.recommended_version` และ `compatible_versions`

### Leap และ Cosmostation

- ปุ่ม `experimentalSuggestChain` ในหน้าเว็บใช้ได้ทันทีโดยไม่ต้องรอรายชื่อ
- ให้ขึ้นเป็นเชนในตัวกระเป๋า:
  - **Leap:** อ้างข้อมูลเชน Cosmos จาก cosmos/chain-registry ส่ง PR นั้นก่อน แล้วติดต่อทีม Leap (ยังไม่ได้ยืนยันขั้นตอนของ Leap)
  - **Cosmostation:** repo chainlist ของเขา (ตอนนี้ย้ายไป github.com/CosmosLabsKR/chainlist) ใช้เพิ่ม asset และ endpoint ของเชนที่ Cosmostation รองรับแล้วเท่านั้น
    การเพิ่มเชนใหม่ต้องติดต่อทีม Cosmostation (ช่องทางอยู่ท้าย README ของ repo นั้น)
