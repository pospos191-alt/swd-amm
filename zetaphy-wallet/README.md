# ZETAPHY PQ Wallet

กระเป๋าบนเว็บสำหรับ **บัญชี PQ แท้ (native)** บน ZETAPHY testnet
- บัญชีคุมด้วยกุญแจ ML-DSA-44 (FIPS 204) อย่างเดียว ไม่มีกุญแจ ECDSA เลย
- ธุรกรรมเป็นข้อความ Cosmos SDK (`MsgSend`, `MsgDelegate`, `MsgEVMCall` ฯลฯ) ที่เชนตรวจลายเซ็น ML-DSA เอง
- เป็นเว็บนิ่ง (static) ไม่มีโค้ดฝั่งเซิร์ฟเวอร์

> **ใช้กับ testnet เท่านั้น ไม่ใช่เงินจริง**
> seed คือกุญแจเดียวของกระเป๋า ถ้าหายหรือลืมรหัสผ่าน เงินหายถาวร

## ทำไมแยกจาก zetaphy-neuro

zetaphy-neuro สัญญากับผู้ใช้ว่า "ไม่แตะกุญแจเลย" กระเป๋านี้ต้องถือกุญแจ จึงแยกเป็นโปรเจกต์ Vercel ของตัวเอง โดเมนของตัวเอง

## ทำอะไรได้

- สร้างกุญแจใหม่ (seed 32 ไบต์จาก `crypto.getRandomValues`) หรือนำเข้า seed (hex)
- หรือ **ใช้ MetaMask (ZETAPHY Snap)**: กุญแจ ML-DSA-44 อยู่ใน MetaMask ไม่ใช่ในหน้านี้ (ดู `zetaphy-snap/README.md`)
  - กด "เชื่อม MetaMask": `wallet_requestSnaps` แล้ว `zetaphy_getAccount` หน้าเว็บคำนวณที่อยู่จาก public key เอง ไม่เชื่อที่อยู่ที่ snap บอก
  - snap ID มาจาก `<meta name="zetaphy-snap-id">` ใน `index.html` (ค่าเริ่มต้น `npm:@zetaphy/snap`)
    ตอนพัฒนาใส่ `local:http://localhost:8080` ใน "ตั้งค่าเพิ่มเติม" (บัญชีจะต่างจากของ npm)
  - โอน, โอนโทเคน, stake และ deploy ส่งให้ snap เป็นข้อความ (`zetaphy_signTx`) snap แสดงรายละเอียดและเซ็นเมื่อผู้ใช้ยืนยัน
    หน้าเว็บสร้าง tx รอบลายเซ็นเองแล้วเทียบกับที่ snap ส่งกลับ ถ้าไม่ตรงจะไม่ส่ง
  - ไม่มีไฟล์สำรอง seed: Secret Recovery Phrase ของ MetaMask คือที่สำรอง
  - ระหว่างที่ snap ยังไม่อยู่ใน allowlist ของ MetaMask ต้องใช้ MetaMask Flask
- แสดงที่อยู่ `zetaphy1…` และ `0x…` (บัญชีเดียวกัน) และยอดเงิน
- โอนไปที่อยู่ `0x…` หรือ `zetaphy1…` โดยแสดงจำนวนและค่าธรรมเนียมให้ยืนยันก่อนเซ็น
- โทเคน ERC-20 (เหมือน `zetaphy pq native token-balance` / `token-send`)
  - ใส่ที่อยู่สัญญา แสดง symbol, decimals และยอดของบัญชี อ่านด้วย `eth_call` ผ่าน RPC เดิม เบราว์เซอร์จำที่อยู่โทเคนล่าสุดไว้
  - โอนเป็น `/zetaphy.pq.v1.MsgEVMCall` ที่เรียก `transfer(address,uint256)` (calldata เข้ารหัสในหน้าเว็บเอง ไม่ใช้ ethers)
  - ถ้าสัญญา revert ธุรกรรมทั้งหมดล้มเหลวแต่ยังเสียค่าธรรมเนียม หน้าเว็บจึงจำลองด้วย `eth_call` ก่อนแสดงหน้ายืนยัน และ `callEVM` จำลองซ้ำก่อนเซ็น ถ้าจะ revert หรือ `transfer` คืน `false` จะไม่เซ็นและไม่ส่ง
  - ค่าธรรมเนียม = (EVM gas, ค่าเริ่มต้น 200000 + 400000) × gas price จ่ายเป็น ZETAPHY
- Stake (เหมือน `zetaphy pq native stake` / `unstake` / `rewards`)
  - ใส่ validator `zetaphyvaloper1…` (ตรวจ checksum) แล้วกด Stake, ถอน stake หรือรับรางวัล ทุกปุ่มมีหน้ายืนยันก่อนเซ็น
  - ยังไม่แสดงยอดที่ stake อยู่
- สร้างสัญญา (deploy เหมือน `zetaphy pq native deploy`)
  - วาง creation bytecode (hex รวม constructor arguments) หน้ายืนยันแสดงขนาดและ keccak-256 ของโค้ด
  - จำลองด้วย `eth_call` ก่อนแสดงหน้ายืนยัน และ `deploy` จำลองซ้ำก่อนเซ็น ส่งเป็น `MsgEVMCall` ที่ไม่มี `to` แล้วแสดงที่อยู่สัญญาใหม่
- ล็อกบัญชี MetaMask ให้กระเป๋านี้ (ล็อกควอนตัม แบบถาวร)
  - ต้องติ๊กยอมรับคำเตือนก่อน แล้วกดยืนยันอีกครั้งที่หน้าต่างที่แสดงทั้งสองบัญชี
  - ใช้ `window.ethereum`: `eth_requestAccounts` แล้ว `eth_sendTransaction` `{to: 0x…5051, value: 0x0, data: ที่อยู่ 0x ของกระเป๋านี้}`
  - ตรวจก่อนว่ากระเป๋านี้เคยส่งธุรกรรมแล้ว (เชนรู้กุญแจสาธารณะ), MetaMask อยู่บน chain 77390 และบัญชีนั้นยังไม่ถูกล็อก
  - หลังล็อก กุญแจ MetaMask ของบัญชีนั้นใช้กับ ZETAPHY ไม่ได้อีก ถ้า seed ของกระเป๋านี้หาย บัญชีนั้นหายด้วย
- บัญชีที่กระเป๋านี้ควบคุม
  - ใส่ที่อยู่บัญชีที่ล็อกไว้ หน้าเว็บถาม `zetaphy_pqAccount` ว่า `quantumLockedTo` เป็นกระเป๋านี้จริงก่อนใช้
  - ระหว่าง "ทำรายการในนามบัญชีนี้" การโอน ZETAPHY, โอนโทเคน และ stake/ถอน/รับรางวัล ส่งเป็น `MsgEVMCall` ที่มี `as_owner`
    - เงินและโทเคนออกจากบัญชีที่ล็อก ค่าธรรมเนียมหักจากกระเป๋านี้ stake ผ่าน precompile `0x…0800` / `0x…0801`
  - เบราว์เซอร์จำรายการที่อยู่ไว้ (แยกตามกระเป๋า) สถานะจริงอ่านจากเชนทุกครั้ง
- ดาวน์โหลดไฟล์สำรอง seed
  - เป็น hex แบบไม่เข้ารหัส ใช้เป็น `~/.zetaphy/pq.seed` ของ `zetaphy pq native` ได้เลย
- **ใช้ ZETAPHY กับกระเป๋าอื่น** (`wallets.js`, รายละเอียดและตารางว่ากระเป๋าไหนใช้ได้อยู่ใน `zetaphy-chain/wallets/README.md`)
  - แสดงกระเป๋า EVM ทุกตัวในเบราว์เซอร์ด้วย EIP-6963 (ชื่อและไอคอน: MetaMask, Rabby, Coinbase, OKX, Trust, Brave, Phantom ฯลฯ)
    - กระเป๋ารุ่นเก่าและเบราว์เซอร์ในแอปมือถือ: `window.ethereum`, `window.binancew3w.ethereum` (Binance Wallet), `window.phantom.ethereum`
    - ไอคอนแสดงเฉพาะ `data:image/…` (CSP `img-src 'self' data:`) ชื่อแสดงเป็นข้อความล้วน ตัดอักขระควบคุมและ bidi ออก
  - ผู้ใช้เลือกกระเป๋าเอง (จำไว้) กระเป๋าที่เลือกใช้กับ "เพิ่ม ZETAPHY", "เชื่อมกระเป๋า", ล็อกควอนตัม และโหมด Snap
    - Snap ถาม `wallet_getSnaps` ก่อน ถ้ากระเป๋าไม่ใช่ MetaMask จะบอกให้เลือก MetaMask
  - "เพิ่ม ZETAPHY ในกระเป๋านี้": `wallet_addEthereumChain` (EIP-3085) แล้ว `wallet_switchEthereumChain`
    - RPC มาจากช่อง RPC ด้านบน ต้องเป็น https หรือ localhost
    - ถ้ากระเป๋าปฏิเสธ (เช่น 4200 ใน Binance Wallet หรือ Phantom) บอกเหตุผลและเปิดค่าสำหรับเพิ่มเอง
    - สัญลักษณ์ฝั่ง EVM คือ `ZPHY` เพราะ MetaMask และ chainlist รับได้ไม่เกิน 6 ตัว
  - แสดงค่าสำหรับเพิ่มเองในกระเป๋าใดก็ได้: ชื่อเครือข่าย, RPC, chain ID, สัญลักษณ์, ทศนิยม
  - "เพิ่มใน Keplr / Leap / Cosmostation": `experimentalSuggestChain(chainInfo)` แล้ว `enable` และแสดงที่อยู่ `zetaphy1…` ที่กระเป๋าตอบ
    - rpc = `<host>/rpc`, rest = `<host>/rest` จาก host เดียวกับช่อง RPC
  - มือถือ: ในเบราว์เซอร์ของแอปกระเป๋า กระเป๋าจะอยู่ในรายการเอง ถ้าเปิดจากเบราว์เซอร์ธรรมดาจะมีลิงก์ "เปิดในแอป"
  - WalletConnect: ปุ่มปิดอยู่จนกว่าจะมี projectId (ดูหัวข้อด้านล่าง)
- ภาษาไทย (ค่าเริ่มต้น) และอังกฤษ

## WalletConnect: ขั้นต่อไป

ยังไม่มี WalletConnect SDK ใน bundle ปุ่ม WalletConnect ในหน้าเว็บจึงยังเชื่อมไม่ได้
- เจ้าของต้องสมัคร **projectId ของ Reown ฟรี** ที่ cloud.reown.com และใส่โดเมนของกระเป๋าใน allowlist ของโปรเจกต์
- ใส่ projectId ใน `<meta name="zetaphy-walletconnect-project-id" content="…">` ของ `index.html` (หรือช่อง "ตั้งค่าเพิ่มเติม" ในหน้าเว็บ)
  - พอมี projectId ปุ่มจะกดได้ แต่ยังบอกว่าเป็นขั้นต่อไป
- **ขั้นต่อไป:** ใส่ SDK ใน `src/entry.js` แล้ว `npm run build` (และ commit `vendor/pqwallet.js`) แล้วต่อเข้ากับปุ่ม
- ต้องใช้กับกระเป๋าบนมือถือเมื่อเปิดหน้านี้จากเบราว์เซอร์อื่น เช่น Binance Web3 Wallet นอกแอป Binance

## เก็บกุญแจอย่างไร

- seed เก็บใน localStorage **แบบเข้ารหัสเท่านั้น**
  - PBKDF2-SHA256 600,000 รอบ จากรหัสผ่านที่ผู้ใช้พิมพ์ แล้วเข้ารหัสด้วย AES-256-GCM (WebCrypto)
- seed และกุญแจลับอยู่ในหน่วยความจำเฉพาะตอนปลดล็อก กด "ล็อกกระเป๋า" แล้วล้างทิ้ง
- สิ่งเดียวที่ส่งออกไปคือ JSON-RPC ไปยังโหนดที่ผู้ใช้ใส่เอง: ที่อยู่ ยอดเงิน และธุรกรรมที่เซ็นแล้ว ไม่มี seed
- โหมด MetaMask Snap: หน้าเว็บไม่มี seed เลย ส่งให้ MetaMask (ผ่าน `window.ethereum` ในเครื่อง) แค่ข้อความธุรกรรมที่จะให้เซ็น
- ไม่โหลดสคริปต์จาก CDN หรือที่อื่น โค้ดทั้งหมดอยู่ใน `app.js` และ `vendor/pqwallet.js`
- `vercel.json` ตั้ง CSP เข้ม (`script-src 'self'`, `frame-ancestors 'none'`) และ `X-Content-Type-Options: nosniff`
  - `connect-src *` เพราะผู้ใช้ใส่ RPC ของโหนดตัวเอง

## ใช้กับโหนด

ใส่ที่อยู่ JSON-RPC ของโหนด ZETAPHY (พอร์ต 8545) ในช่อง RPC ไม่มีค่าเริ่มต้น เบราว์เซอร์จำไว้ให้
- หน้าเว็บบน Vercel เป็น https จึงต้องใช้ RPC แบบ https ด้วย (เบราว์เซอร์บล็อก http)
  - โหนดที่ติดตั้งด้วย `zetaphy-chain/setup-node.sh` (หรือ `cloud-init.sh`) มี https ให้แล้ว:
    `https://<IP ที่เปลี่ยนจุดเป็นขีด>.sslip.io` เช่น `https://1-2-3-4.sslip.io` (ต้องเปิดพอร์ต 80 และ 443)
- โหนดต้องตอบ CORS (preflight `OPTIONS`) ให้โดเมนของกระเป๋า
- หน้าเว็บตรวจ `eth_chainId` ว่าเป็น ZETAPHY testnet (77390) ก่อนใช้งานทุกครั้ง
- บัญชีจะมีบนเชนหลังได้รับเงินครั้งแรก ก่อนหน้านั้นโอนออกไม่ได้ หน้าเว็บจะบอกให้โอนเข้าก่อน

## ไฟล์

| ไฟล์ | คืออะไร |
|---|---|
| `index.html`, `app.js`, `style.css` | หน้าเว็บ |
| `wallets.js` | ค่าเครือข่ายสำหรับกระเป๋าอื่น (EIP-3085, Keplr chain info) และการหากระเป๋า EVM (EIP-6963) ตรงกับ `zetaphy-chain/wallets/*.template.json` |
| `vendor/pqwallet.js` | bundle ของ `zetaphy-network/src/pqtx.js` + ML-DSA-44 จาก `@noble/post-quantum` + `@noble/hashes` (commit ไว้ Vercel จึงไม่ต้อง build) |
| `src/entry.js`, `scripts/build.js` | สร้าง bundle ด้วย esbuild |
| `scripts/serve.js` | เซิร์ฟเวอร์สำหรับรันบนเครื่อง ใช้ header ชุดเดียวกับ `vercel.json` |
| `test/wallet.e2e.js` | ทดสอบในเบราว์เซอร์จริง (Playwright) |

## คำสั่ง

```
npm install
npm run build     # สร้าง vendor/pqwallet.js ใหม่ แล้ว commit
npm run serve     # http://localhost:8090/ (สำหรับนักพัฒนา)
npm test          # Chromium headless: สร้างกุญแจ, เข้ารหัส/ปลดล็อก, โอน, โอนโทเคน (และที่ถูกปฏิเสธ), stake, deploy,
                  # ล็อกบัญชี MetaMask (window.ethereum จำลอง), ทำรายการแทนบัญชีที่ล็อก
                  # และโหมด MetaMask Snap (snap ปลอมหลัง window.ethereum: wallet_requestSnaps / wallet_invokeSnap) กับ RPC จำลอง
                  # กระเป๋าอื่น: กระเป๋าปลอมที่ประกาศตัวด้วย EIP-6963, Binance Wallet (4200), Phantom, Keplr/Leap/Cosmostation,
                  # WalletConnect ที่ปิดอยู่ และตรวจว่าค่าในหน้าเว็บตรงกับ zetaphy-chain/wallets/
```

ถ้าแก้ `zetaphy-network/src/pqtx.js` ต้อง `npm run build` แล้ว commit `vendor/pqwallet.js` ด้วย CI ตรวจว่าไฟล์ที่ commit ตรงกับที่ build ใหม่

## ติดตั้งบน Vercel (ฟรี)

1. สร้างโปรเจกต์ใหม่ใน Vercel จาก repo นี้
2. ตั้ง Root Directory เป็น `zetaphy-wallet`
3. ไม่ต้องตั้งอะไรเพิ่ม: `vercel.json` ปิดขั้น install และ build ไว้แล้ว
