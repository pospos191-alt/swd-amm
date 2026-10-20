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
- ดาวน์โหลดไฟล์สำรอง seed
  - เป็น hex แบบไม่เข้ารหัส ใช้เป็น `~/.zetaphy/pq.seed` ของ `zetaphy pq native` ได้เลย
- ภาษาไทย (ค่าเริ่มต้น) และอังกฤษ

## เก็บกุญแจอย่างไร

- seed เก็บใน localStorage **แบบเข้ารหัสเท่านั้น**
  - PBKDF2-SHA256 600,000 รอบ จากรหัสผ่านที่ผู้ใช้พิมพ์ แล้วเข้ารหัสด้วย AES-256-GCM (WebCrypto)
- seed และกุญแจลับอยู่ในหน่วยความจำเฉพาะตอนปลดล็อก กด "ล็อกกระเป๋า" แล้วล้างทิ้ง
- สิ่งเดียวที่ส่งออกไปคือ JSON-RPC ไปยังโหนดที่ผู้ใช้ใส่เอง: ที่อยู่ ยอดเงิน และธุรกรรมที่เซ็นแล้ว ไม่มี seed
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
| `vendor/pqwallet.js` | bundle ของ `zetaphy-network/src/pqtx.js` + ML-DSA-44 จาก `@noble/post-quantum` + `@noble/hashes` (commit ไว้ Vercel จึงไม่ต้อง build) |
| `src/entry.js`, `scripts/build.js` | สร้าง bundle ด้วย esbuild |
| `scripts/serve.js` | เซิร์ฟเวอร์สำหรับรันบนเครื่อง ใช้ header ชุดเดียวกับ `vercel.json` |
| `test/wallet.e2e.js` | ทดสอบในเบราว์เซอร์จริง (Playwright) |

## คำสั่ง

```
npm install
npm run build     # สร้าง vendor/pqwallet.js ใหม่ แล้ว commit
npm run serve     # http://localhost:8090/ (สำหรับนักพัฒนา)
npm test          # Chromium headless: สร้างกุญแจ, เข้ารหัส/ปลดล็อก, โอน, โอนโทเคน (และที่ถูกปฏิเสธ), stake กับ RPC จำลอง
```

ถ้าแก้ `zetaphy-network/src/pqtx.js` ต้อง `npm run build` แล้ว commit `vendor/pqwallet.js` ด้วย CI ตรวจว่าไฟล์ที่ commit ตรงกับที่ build ใหม่

## ติดตั้งบน Vercel (ฟรี)

1. สร้างโปรเจกต์ใหม่ใน Vercel จาก repo นี้
2. ตั้ง Root Directory เป็น `zetaphy-wallet`
3. ไม่ต้องตั้งอะไรเพิ่ม: `vercel.json` ปิดขั้น install และ build ไว้แล้ว
