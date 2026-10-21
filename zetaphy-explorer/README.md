# ZETAPHY Explorer (explorer.sawasdeecoin.com)

Block explorer ของเชน ZETAPHY (Cosmos SDK v0.54 + Cosmos EVM v0.7.3, chain id `zetaphy_77390-1`, EVM chain id 77390)
เป็น**เว็บนิ่งล้วน (static site)**: ไม่มีเซิร์ฟเวอร์ ไม่มีฐานข้อมูล ไม่มี indexer เบราว์เซอร์ของผู้ใช้อ่านข้อมูลจาก RPC/REST สาธารณะของโหนดโดยตรง
จึงวางบน Vercel ได้ฟรี

## มีอะไรบ้าง

| หน้า | แสดง |
|---|---|
| หน้าแรก `#/` | chain id, ความสูงบล็อก, อุปทานทั้งหมด (ลดลงเมื่อเผาค่าธรรมเนียมและเผาเหรียญที่ส่งไป `0x…dEaD` พร้อมยอดที่เผาไปใน ~1 ชม.), ยอด stake และสัดส่วน, จำนวน validator และ % พลังโหวตที่มีกุญแจโหวต PQ, บล็อกล่าสุด, ธุรกรรมล่าสุด |
| บล็อก `#/block/<เลข>` | header, ผู้เสนอบล็อก (ชื่อ validator), ธุรกรรมพร้อมสถานะ, **ใบรับรองต้านควอนตัม ML-DSA-44** ของบล็อกนี้ (อยู่ใน tx[0] ของบล็อกถัดไป): ผู้เซ็น, พลังที่เซ็นเทียบกับที่ต้องการ และ**ตรวจลายเซ็นจริงในเบราว์เซอร์** ด้วย `zetaphy-network/src/pqcert.js` |
| ธุรกรรม `#/tx/<hash>` | EVM: from/to/value/gas/fee/status/logs ถอดการโอน ERC-20 / ERC-721 / ERC-1155 (Transfer, TransferSingle, TransferBatch) · Cosmos: ถอดทุกข้อความ รวมข้อความของ ZETAPHY (`MsgEVMCall`, `MsgQuantumLock`, `MsgPQVoteKey`, `MsgPQCertificate`, `MsgSetPQEvidence`), ชนิดกุญแจผู้เซ็น (ML-DSA-44), memo, ค่าธรรมเนียม, events |
| ที่อยู่ `#/address/<0x… หรือ zetaphy1…>` | ทั้งสองรูปแบบ (20 ไบต์เดียวกัน), ยอด, nonce / sequence, เป็นสัญญาหรือไม่, บัญชี ML-DSA-44, **ล็อกควอนตัม** (ช่อง `quantumLockedTo` ของ `zetaphy_pqAccount`), เหรียญอื่น, ยอด stake, ยอดโทเคน, ธุรกรรมล่าสุด, สถานะใน **ThreatRegistry** |
| โทเคน `#/token/<0x…>` | ERC-20 / ERC-721 / ERC-1155: ชื่อ, สัญลักษณ์, ทศนิยม, อุปทาน, ลิงก์รายงาน Neuro (ตั้ง URL ได้), ThreatRegistry, การโอนล่าสุด |
| Validator `#/validators` | พลังโหวต, สถานะ, ค่าคอมมิชชัน, **ลงทะเบียนกุญแจโหวต PQ แล้วหรือยัง** (อ่านสโตร์ `zetaphypq` ด้วย `abci_query`) |
| ตั้งค่า `#/settings` | URL ของโหนด (เก็บในเบราว์เซอร์นี้), ThreatRegistry, URL รายงาน Neuro, จำนวนบล็อกที่สแกน |

ช่องค้นหารับ: เลขบล็อก, hash ธุรกรรม (EVM `0x…` หรือ Cosmos hex), hash บล็อก, ที่อยู่ `0x…` / `zetaphy1…`, `zetaphyvaloper1…`

ภาษาไทย/อังกฤษ (ปุ่ม EN/ไทย), ธีมสว่าง/มืด, ใช้บนมือถือได้ (ตารางกลายเป็นการ์ด)

### ไม่มี indexer

ประวัติล่าสุดได้จากการ**สแกน N บล็อกล่าสุดในเบราว์เซอร์** (ค่าเริ่มต้น 100 บล็อก ≈ 8 นาทีที่บล็อกละ ~5 วินาที, ตั้งได้ 1–1000)
หน้าเว็บบอกช่วงที่สแกนทุกครั้ง ธุรกรรมที่เก่ากว่านั้นเปิดได้ด้วย hash หรือเลขบล็อก แต่จะไม่ขึ้นในรายการ "ธุรกรรมล่าสุด" ของที่อยู่

- อ่านธุรกรรมเป็นช่วงละ 50 บล็อก (`tx_search` ของ CometBFT ตามช่วงความสูง) ช่วงที่จบแล้วเก็บแคชไว้ จึงถามเฉพาะช่วงบนสุดซ้ำ
  ถ้าโหนดปิด tx index ไว้ จะอ่านทีละบล็อกแทน (จำกัดไม่เกิน 40 บล็อกต่อรอบ)
- ยอดโทเคนของที่อยู่ หาจากอีเวนต์ Transfer ในช่วงเดียวกัน (`eth_getLogs`) แล้วอ่าน `balanceOf` สด
  (log ของ `MsgEVMCall` ไม่อยู่ใน `eth_getLogs` ตาม README ของ zetaphy-chain จึงอาจไม่ครบ)
- ทุกคำขอผ่านคิวเดียว: พร้อมกันไม่เกิน 4 คำขอ, ไม่เกิน 8 คำขอ/วินาที, แคชในหน่วยความจำ (บล็อกและธุรกรรมที่ยืนยันแล้วเก็บนาน ข้อมูล "ล่าสุด" หมดอายุใน 4 วินาที), คำขอซ้ำที่กำลังรอใช้คำตอบเดียวกัน
- หน้าแรกรีเฟรชทุก 6 วินาทีเฉพาะตอนแท็บเปิดอยู่

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

### ความปลอดภัย

- ไม่ใช้ `innerHTML` (หรือ sink อื่น) กับข้อมูลใด ๆ: สร้าง DOM ด้วย `textContent` ผ่าน `src/dom.js` (ลิงก์ได้เฉพาะ `#/…` หรือ `https:`)
- ข้อความจากเชน (ชื่อ/สัญลักษณ์โทเคน, moniker, memo, events, คำชี้แจง) ตัดอักขระควบคุม, อักขระกลับทิศ (bidi เช่น U+202E), zero-width ออก และจำกัดความยาว (`safeText` ใน `src/format.js`)
- CSP ใน `vercel.json`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` และ header อื่น (HSTS, nosniff, no-referrer, X-Frame-Options)
- ไม่มีสคริปต์หรือฟอนต์จากภายนอก ทุกไลบรารีอยู่ใน `vendor/zetaphy-lib.js` ที่ build จาก repo นี้
- คำขอไปโหนดไม่ส่ง cookie (`credentials: 'omit'`) และรับเฉพาะ URL แบบ `https://` (เว้น `http://localhost` ตอนทดสอบในเครื่อง)

**ทำไม `connect-src` เป็น `https:`:** ผู้ใช้เปลี่ยนโหนดเองได้ในหน้าตั้งค่า CSP จึงต้องอนุญาต host แบบ https ใดก็ได้
ถ้าต้องการล็อกให้ใช้ได้เฉพาะโหนดของเรา แก้ใน `vercel.json` เป็น เช่น `connect-src 'self' https://1-2-3-4.sslip.io`
(ผลคือโหนดที่ผู้ใช้ตั้งเองจะถูกเบราว์เซอร์บล็อก)

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
npm run build              # สร้าง vendor/zetaphy-lib.js ใหม่ (เมื่อ pqcert.js / pqtx.js / vaccine.js เปลี่ยน) แล้ว commit
npm run serve              # http://localhost:8095 พร้อม CSP เดียวกับ vercel.json
npm test                   # unit + เบราว์เซอร์ (mock node)
npm run test:devnet        # กับเชนจริง (ดูด้านล่าง)
```

- `npm test` = `test/unit.test.js` (ตัวถอดรหัสธุรกรรม Cosmos/EVM, การโอนโทเคน, ตัวจัดรูปแบบ, config, คิว/แคช, ThreatRegistry, การสแกน, i18n, ตรวจ CSP/sink) และ
  `test/explorer.e2e.js` (Chromium ผ่าน Playwright; ใช้ `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` หรือ `CHROMIUM_PATH`)
  โหนดจำลองใน `test/mock-chain.js` สร้างบล็อกที่ hash ถูกต้องจริงและลายเซ็น ML-DSA-44 จริง (มีบล็อกหนึ่งลายเซ็นเสียเพื่อทดสอบว่าถูกปฏิเสธ)
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
src/format.js    จัดรูปแบบตัวเลข/ที่อยู่/เวลา, safeText
src/dom.js       สร้าง DOM แบบไม่ใช้ HTML
src/i18n.js      ข้อความไทย/อังกฤษ
src/config.js    ค่าเริ่มต้น, config.json, ค่าในเบราว์เซอร์
vendor/zetaphy-lib.js  bundle ของ pqcert.js, pqtx.js, vaccine.js และ @noble (สร้างด้วย npm run build)
```

---

English summary: a static, serverless ZETAPHY block explorer (no database, no indexer). The browser talks to the node's public
EVM JSON-RPC, CometBFT RPC and Cosmos REST (behind Caddy) directly, scans the last N blocks for recent history (bounded, cached,
rate-limited), verifies each block's ML-DSA-44 certificate in the browser with `pqcert.js`, decodes ZETAPHY's custom messages and
EVM token transfers, and shows ThreatRegistry flags in neutral wording with the disclaimer. Deploy on Vercel with Root Directory
`zetaphy-explorer`; point `explorer.sawasdeecoin.com` with a CNAME `explorer` → `cname.vercel-dns.com`, then add the domain in the
Vercel project. Set the node in `config.json` (`node`) or per browser on the Settings page.
