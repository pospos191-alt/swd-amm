# ZETAPHY NFT: สร้างและซื้อขาย NFT บนเชน ZETAPHY

ระบบสร้างคอลเลกชัน NFT และตลาดซื้อขาย NFT สำหรับเชน ZETAPHY (Cosmos EVM, EVM chain id `77390`, chain id `zetaphy_77390-1`, เหรียญ ZETAPHY ใช้ ticker `ZTPHY` ในกระเป๋า EVM, 18 ตำแหน่ง)
เว็บเป็นแบบ static ไม่มีเซิร์ฟเวอร์ โฮสต์ฟรีบน Vercel ที่ `nft.sawasdeecoin.com`

> **คำเตือน: ใช้บนเครือข่ายทดสอบ (testnet) เท่านั้น** สัญญาทั้งหมดยังไม่ผ่านการตรวจสอบความปลอดภัย (audit) จากบุคคลภายนอก
> อย่าใช้กับเงินหรือสินทรัพย์ที่มีมูลค่าจริง ดูหัวข้อ [ความเสี่ยง](#ความเสี่ยง)

## สิ่งที่มีในโฟลเดอร์นี้

| ส่วน | ไฟล์ |
|---|---|
| สัญญา (Solidity 0.8.26) | `contracts/CollectionBase.sol`, `ZetaphyERC721.sol`, `ZetaphyERC1155.sol`, `NFTFactory.sol` (มี `ERC721Deployer` / `ERC1155Deployer`), `NFTMarketplace.sol`, `interfaces/Interfaces.sol` |
| ไฟล์คอมไพล์แล้ว (commit ไว้) | `artifacts/*.json` (abi, bytecode, standard-JSON input สำหรับ verify บน explorer) |
| สคริปต์ | `scripts/build.js` (คอมไพล์, `--check` ตรวจว่า artifacts ตรงกับซอร์ส), `scripts/build-web.js` (bundle `web/vendor/zetaphy-lib.js`), `scripts/serve.js` (เปิดเว็บในเครื่องพร้อม CSP จริง) |
| CLI | `cli.js` (สร้างกุญแจ, deploy, ดูข้อมูล, คำสั่ง governance), `src/keys.js` |
| เว็บ | `web/index.html`, `web/app.js`, `web/style.css`, `web/lib/*.js`, `web/vendor/zetaphy-lib.js`, `web/deployments.json`, `web/vercel.json`, `web/logo.svg` |
| ทดสอบ | `test/*.test.js` (หน่วย), `test/web.e2e.js` (เบราว์เซอร์), `test/devnet.integration.js` (เชนจริง), `test/helpers/` |

## การออกแบบ

### สัญญา

**NFTFactory** ใครก็สร้างคอลเลกชันได้ ผู้เรียกเป็นเจ้าของคอลเลกชัน โรงงานไม่มีเจ้าของ ไม่เก็บค่าธรรมเนียม และควบคุมคอลเลกชันไม่ได้
- `createERC721(config)` / `createERC1155(config)` โดย `config` คือ ชื่อ, สัญลักษณ์, base URI (เว้นว่าง = ใส่ URI รายโทเคนตอน mint),
  contract URI, ผู้รับและอัตราค่าลิขสิทธิ์ EIP-2981 (**สูงสุด 10%**), จำนวนสูงสุด (0 = ไม่จำกัด; ERC-1155 นับต่อรหัสโทเคน),
  เปิด mint สาธารณะหรือไม่ และราคา mint
- `isCollection(address)` บอกว่าคอลเลกชันสร้างจากโรงงานนี้หรือไม่ (เว็บแสดง "สร้างจากโรงงาน ZETAPHY" หรือ "สัญญาภายนอก")
- ตัวโรงงานแยกตัว deploy ออกเป็น `ERC721Deployer` / `ERC1155Deployer` เพื่อให้แต่ละสัญญาเล็กกว่าขีดจำกัด 24 KB มาก

**ZetaphyERC721 / ZetaphyERC1155** เขียนเองแบบเรียบง่าย (ไม่มี OpenZeppelin ในเครื่อง และไม่ดึงของเสียเงิน)
- ERC-165 ตอบเฉพาะ interface ที่ทำจริง: 721 = `0x01ffc9a7, 0x80ac58cd, 0x5b5e139f, 0x2a55205a`, 1155 = `0x01ffc9a7, 0xd9b67a26, 0x0e89341c, 0x2a55205a` และตอบ `false` กับ `0xffffffff`
- safe transfer และ safe mint ตรวจผู้รับที่เป็นสัญญา (`onERC721Received` / `onERC1155Received` / `onERC1155BatchReceived` ต้องคืนค่า magic ที่ถูกต้อง; revert แบบมีข้อความจะส่งต่อข้อความ; revert เปล่าหรือไม่มีฟังก์ชัน = `InvalidReceiver`)
- เจ้าของ mint ได้เสมอ; mint สาธารณะต้องจ่าย `ราคา × จำนวน` พอดี เงินอยู่ในสัญญาจนเจ้าของกด `withdraw` (ไม่ส่งเงินระหว่าง mint)
- จำนวนสูงสุด: ลดได้หรือตั้งจากไม่จำกัดได้ แต่เพิ่มไม่ได้ และไม่ต่ำกว่าที่ mint ไปแล้ว; การ mint ERC-721 จองรหัสก่อนเรียก callback ของผู้รับ จึงเกินจำนวนสูงสุดไม่ได้แม้มีการเรียกซ้อน
- URI รายโทเคนแก้ไม่ได้; base URI / contract URI แก้ได้จนกว่าเจ้าของจะ `freezeMetadata()`
- ทุกค่าตั้งเก็บใน storage (ไม่ใช้ immutable) คอลเลกชันชนิดเดียวกันทุกอันจากโรงงานจึงมีโค้ด (code hash) เดียวกัน ตรวจครั้งเดียวได้ทั้งหมด
- `renounceOwnership` ต้องถอนเงิน mint ออกก่อน (มิฉะนั้นเงินจะค้างตลอดไป)

**NFTMarketplace**
- ลงขายราคาคงที่ด้วย ZETAPHY แบบ **ไม่ฝาก NFT ไว้กับตลาด**: NFT อยู่ในกระเป๋าผู้ขายจนขาย ผู้ขาย `setApprovalForAll` (หรือ `approve` ทีละโทเคนสำหรับ 721)
- ERC-721 (จำนวน 1) และ ERC-1155 (ราคาต่อชิ้น ซื้อบางส่วนได้ จำนวนที่เหลือลดลงตามที่ขาย)
- ทุกการขายแบ่งเงิน: ค่าธรรมเนียมโปรโตคอล `feeBps` (ค่าเริ่มต้น 1%, governance ตั้งได้ **ไม่เกิน 5%**) ให้ `feeRecipient`;
  ค่าลิขสิทธิ์ตาม EIP-2981 ที่คอลเลกชันรายงาน **ตัดที่ 10% ของราคา** (ถ้า `royaltyInfo` revert, ใช้แก๊สเกิน 50,000, ตอบผิดรูปแบบ หรือผู้รับเป็นศูนย์ = ไม่มีค่าลิขสิทธิ์); ที่เหลือให้ผู้ขาย ปัดเศษลงทั้งหมด เศษ wei ตกเป็นของผู้ขาย
- **Pull payment**: เงินทุกส่วนบันทึกใน `owed[address]` แล้วเจ้าของกด `withdraw()` หรือ `withdrawTo(address)` เอง ผู้รับที่ปฏิเสธเงินจึงขวางการขายไม่ได้
- **Reentrancy guard** ที่ `buy`, `makeOffer`, `cancelOffer`, `acceptOffer`, `withdrawTo`; อ่านสถานะด้วย view (staticcall) และส่ง NFT หลังบันทึกสถานะเสร็จ
- ยกเลิก (`cancel`), ยกเลิกทุกรายการของตัวเองในธุรกรรมเดียว (`cancelAll` ด้วย nonce), หมดอายุ (`expiry`, สูงสุด 365 วัน)
- **รายการที่ใช้ไม่ได้แล้ว**: ถ้าผู้ขายโอน NFT ออกไปหรือถอนการอนุญาต การซื้อจะ revert (`SellerLacksToken` / `NotApproved`) และ `listingStatus(id, qty)` บอกเหตุผล เว็บซ่อนรายการเหล่านี้
- ข้อเสนอซื้อ (offer): ผู้ซื้อฝาก ZETAPHY ไว้ที่ตลาด ผู้ถือ NFT รับข้อเสนอได้ ผู้ซื้อยกเลิกได้ทุกเมื่อ (รวมหลังหมดอายุ) เงินคืนเข้าที่ `owed`
- หลังโอนตลาดตรวจว่าผู้ซื้อได้รับ NFT จริง (ป้องกันโทเคนที่แกล้งทำว่าโอน); ตรวจชนิดสัญญาด้วย ERC-165 ตามวิธีของ EIP-165
- EIP-712 signed listing: **ไม่ได้ทำ** (มีเฉพาะการลงขายบนเชน)

### Neuro (จุดเด่นของ ZETAPHY)

- governance ตั้งที่อยู่ `ThreatRegistry` (`zetaphy-network/contracts/ThreatRegistry.sol`) ให้ตลาดได้ด้วย `setThreatRegistry` (ศูนย์ = ปิด)
- ตลาด **ปฏิเสธ** การลงขาย การซื้อ การยื่นข้อเสนอ และการรับข้อเสนอ ของคอลเลกชันที่ `isContractEnforced(collection)` เป็นจริง (ธงที่ที่อยู่บนเชนนี้หรือที่โค้ด และ "บังคับใช้แล้ว" คือพ้น `enforceDelay` หรือผ่านช่องทางเร่งด่วน) ด้วย error `CollectionRefused(reason)`
  การยกเลิกและการถอนเงินทำได้เสมอ ถ้า registry ตอบไม่ได้ ตลาดจะปฏิเสธ (fail closed) จน governance แก้หรือตั้งเป็นศูนย์
- เว็บถาม registry เพิ่มอีก 3 แบบเหมือนกระเป๋า ZETAPHY (`zetaphy-network/src/vaccine.js`): ที่อยู่, code hash และลายนิ้วมือ fp1 ทั้งมุมมองเตือน (`is*Flagged`) และบังคับใช้ (`is*Enforced`)
  - ธงใหม่ที่ยังไม่บังคับใช้: แสดงกล่องเตือนสีเหลือง พร้อมเหตุผลแบบข้อเท็จจริงของโค้ด และยังซื้อขายได้
  - ธงที่บังคับใช้แล้ว: กล่องสีแดง ปิดปุ่มลงขาย/ซื้อ/ข้อเสนอ
  - ทุกกล่องมีข้อความ **"ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา"** และวิธีตรวจซ้ำ ถ้อยคำเป็นกลางตาม `docs/LEGAL.md` (การทดสอบตรวจว่าไม่มีคำอย่าง scam / หลอกลวง)
- เว็บแสดงว่าคอลเลกชันสร้างจากโรงงานที่เชื่อถือได้ หรือเป็น **สัญญาภายนอก** (มีคำเตือนว่าโค้ดไม่เป็นที่รู้จัก)
- **สำคัญสำหรับ governance**: คอลเลกชันจากโรงงานชนิดเดียวกันใช้โค้ดเดียวกัน ถ้ามีคนติดธงที่ code hash นั้น (เช่นเหตุผล "สร้างเพิ่มได้ไม่จำกัด" เพราะเจ้าของ mint ได้เมื่อไม่ตั้งจำนวนสูงสุด) ทุกคอลเลกชันจะโดนพร้อมกัน
  `deploy` จึงเขียน `collectionCodeHashes` ลง deployments JSON ให้ governance เรียก `ThreatRegistry.setProtected([codeKey(hash721), codeKey(hash1155)], true)` ส่วนธงรายที่อยู่ (`addressKey`) ยังใช้ได้ตามปกติ
  (`test/neuro.test.js` ทดสอบกับ ThreatRegistry ตัวจริงทั้งสองกรณี)

### รูปและเมทาดาตา (ฟรี $0)

- token URI รองรับ `ipfs://` (เปิดผ่านเกตเวย์สาธารณะแบบ https ที่เปลี่ยนได้ในหน้าตั้งค่า), `https://` และ `data:` ส่วน `http:`, `javascript:` และอื่น ๆ ไม่เปิด
- อ่านเมทาดาตาได้ไม่เกิน 256 KB, timeout 10 วินาที, ไม่ส่ง cookie/referrer; data URI ของรูปไม่เกิน 2 MB
- รูปแสดงใน `<img>` เท่านั้น SVG แสดงเป็น `img src` (สคริปต์ใน SVG ไม่ทำงาน) ไม่เคยแทรก SVG ลงหน้าเว็บตรง ๆ ไม่โหลด `animation_url`
- ชื่อ คำอธิบาย และ trait ใส่ด้วย `textContent` เท่านั้น ตัดอักขระควบคุม bidi และอักขระที่มองไม่เห็นออก จำกัดความยาว
- CSP ใน `web/vercel.json`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; frame-ancestors 'none'` …

### เว็บ (`web/`)

- static ล้วน ไม่มีเซิร์ฟเวอร์ ไม่มีสคริปต์จากที่อื่น ไลบรารีเดียวที่ใช้ (`@noble/hashes` + ส่วนอ่านของ vaccine) bundle ไว้ที่ `web/vendor/zetaphy-lib.js`
  และ `test/bundle.test.js` build ใหม่ในหน่วยความจำแล้วเทียบกับไฟล์ที่ commit (ทำซ้ำได้ด้วย `package-lock.json`) เหมือน zetaphy-wallet
- ABI encode/decode เขียนเอง (`web/lib/abi.js`) ทดสอบเทียบกับ ethers
- หน้า: สำรวจ (รายการขายล่าสุดจากอีเวนต์ `Listed` + คอลเลกชันล่าสุด), คอลเลกชัน, ชิ้นงาน (ซื้อ/ลงขาย/ข้อเสนอ/ยกเลิก), สร้างคอลเลกชัน, Mint, NFT ของฉัน (จากอีเวนต์ Transfer/TransferSingle/TransferBatch ถึงที่อยู่ของคุณ แล้วตรวจว่ายังถืออยู่), ตั้งค่า
- ค้นอีเวนต์ฝั่งเบราว์เซอร์: ครั้งละไม่เกิน 2,000 บล็อก (ตามขีดจำกัดของโหนด ถ้าโหนดปฏิเสธจะแบ่งครึ่ง) ไม่เกินจำนวนบล็อกที่ตั้งไว้ (ค่าเริ่มต้น 50,000 กด "ค้นบล็อกเก่ากว่านี้" เพื่อขยาย) และเก็บแคชใน localStorage
- กระเป๋าผ่าน EIP-6963 (รูปแบบเดียวกับ `zetaphy-wallet/wallets.js`) เพิ่ม/สลับเครือข่าย ZETAPHY (ticker ZTPHY) ให้อัตโนมัติ; จำลองธุรกรรมด้วย `eth_call` ก่อนส่งและแปล error เป็นข้อความอ่านง่าย
- ภาษาไทย/อังกฤษ, โหมดสว่าง/มืด, ใช้งานบนมือถือได้ (ทดสอบที่ความกว้าง 360px), แบรนด์ SAWASDEE COIN

## ติดตั้งและทดสอบ

```bash
cd zetaphy-nft
npm ci
npm run build -- --check      # artifacts ตรงกับ contracts/ (npm run build เพื่อคอมไพล์ใหม่)
npm test                      # ทดสอบหน่วยทั้งหมด (สัญญาใน @ethereumjs/evm, ไลบรารีเว็บ, bundle, กุญแจ)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e        # เบราว์เซอร์ headless + node จำลองบน EVM จริง + กระเป๋าจำลอง
flock /tmp/ci-test/devnet.lock env ZETAPHYD=/path/to/zetaphyd PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:devnet
npm run serve                 # เปิดเว็บที่ http://localhost:8091 พร้อม CSP เหมือน Vercel
```

`test:devnet` ใช้ `zetaphy-network/scripts/devnet.sh` เปิดเชนจริงชั่วคราว (พอร์ต `DEVNET_PORT`, ค่าเริ่มต้น 25545) deploy ด้วย CLI, สร้างคอลเลกชัน, mint, ลงขาย, ซื้อ (ERC-721 และ ERC-1155),
ถอนเงิน, ทดสอบรายการที่ใช้ไม่ได้และการปฏิเสธของ registry แล้วเปิดเว็บให้ค้นรายการจาก `eth_getLogs` ของโหนดจริงและซื้อผ่านกระเป๋าที่เซ็นธุรกรรมจริง

## Deploy สัญญา

1. สร้างกุญแจผู้ deploy (เก็บในเครื่องเท่านั้น ไม่พิมพ์กุญแจออกมา):
   ```bash
   node cli.js key new                          # ~/.zetaphy/deployer.key (สิทธิ์ 0600) แสดงเฉพาะที่อยู่
   ZETAPHY_PASSPHRASE='…' node cli.js key new   # หรือเก็บแบบเข้ารหัส (keystore) deployer.key.json
   ```
   ใช้ไฟล์อื่นได้ด้วย `--key-file` หรือ `ZETAPHY_KEY_FILE`; หรือส่งกุญแจผ่าน env `ZETAPHY_PRIVATE_KEY` (testnet เท่านั้น)
2. เติม ZETAPHY ของ testnet ให้ที่อยู่นั้น (faucet ของ testnet)
3. Deploy แล้วเขียนไฟล์ให้เว็บ:
   ```bash
   node cli.js deploy --rpc https://<rpc ของ testnet> \
     [--governance 0x…] [--fee-bps 100] [--fee-recipient 0x…] \
     [--registry 0x<ThreatRegistry>] [--public-rpc https://<rpc ที่เว็บใช้>] \
     --out web/deployments.json
   node cli.js info                             # ตรวจค่าที่ใช้อยู่บนเชน
   ```
   CLI ตรวจว่า EVM chain id เป็น 77390 (ใช้ `--any-chain` เพื่อข้าม) แล้ว commit `web/deployments.json`
4. คำสั่ง governance (ใช้กุญแจของ governance):
   ```bash
   node cli.js gov set-fee 100 0x<ผู้รับ>         # ไม่เกิน 500 (5%)
   node cli.js gov set-registry 0x<ThreatRegistry>  # 0 = ปิดการตรวจ
   node cli.js gov set-governance 0x<multisig>
   ```
   แนะนำให้โอน governance ไปที่ multisig (เช่น `SimpleMultisig` ของ zetaphy-network) หรือ gov module ของเชน และ protect code hash ของคอลเลกชันใน ThreatRegistry ตามหัวข้อ Neuro

## Deploy เว็บบน Vercel (ฟรี)

1. เข้า vercel.com ด้วยบัญชี Hobby (ฟรี) → **Add New… → Project** → Import ที่เก็บโค้ดนี้จาก GitHub
2. ตั้งค่าโปรเจกต์:
   - **Root Directory**: `zetaphy-nft/web`
   - **Framework Preset**: Other
   - Build/Install/Output: ไม่ต้องตั้ง `web/vercel.json` กำหนดไว้แล้ว (ไม่มีขั้น build; `vendor/zetaphy-lib.js` commit ไว้แล้ว)
3. กด Deploy ทุกครั้งที่ push ไป branch หลัก Vercel จะ deploy ใหม่เอง
4. หรือใช้ CLI: `npx vercel --cwd zetaphy-nft/web` (และ `--prod` เมื่อพร้อม)

`web/vercel.json` ใส่ header ความปลอดภัย (CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS …) ให้ทุกไฟล์

## โดเมนย่อย `nft.sawasdeecoin.com`

1. ที่ผู้ให้บริการ DNS ของ `sawasdeecoin.com` เพิ่มระเบียน:
   | Type | Name | Value |
   |---|---|---|
   | CNAME | `nft` | `cname.vercel-dns.com` |

   ถ้าใช้ Cloudflare ให้ตั้งเป็น **DNS only** (เมฆสีเทา) เพื่อให้ Vercel ออกใบรับรอง SSL ได้
2. ใน Vercel: Project → **Settings → Domains** → Add `nft.sawasdeecoin.com`
3. รอ Vercel ตรวจ DNS และออก HTTPS ให้เอง (ปกติไม่กี่นาที) ถ้าขึ้น "Invalid Configuration" ให้ตรวจว่า CNAME ถูกต้องและไม่ได้เปิด proxy
4. ไม่มีค่าใช้จ่าย (Vercel Hobby + ระเบียน DNS ที่มีอยู่แล้ว)

RPC ที่เว็บใช้ต้องเป็น https และส่ง header CORS (`Access-Control-Allow-Origin`) ซึ่ง Caddy ใน `zetaphy-chain/setup-node.sh` ทำให้แล้ว

## เก็บรูปและเมทาดาตาฟรี (IPFS)

รูปและไฟล์ JSON ใหญ่เกินจะเก็บบนเชน ให้อัปโหลดขึ้น IPFS แล้ววาง CID หรือ `ipfs://CID/1.json` ในหน้า Mint (CID เปล่าจะแปลงเป็น `ipfs://` ให้)
โครงการนี้ไม่มีบัญชีหรือคีย์ของบริการใด ๆ ผู้สร้างเลือกเองได้ตามสะดวก:

1. **โหนด IPFS ของตัวเอง** — IPFS Desktop หรือ Kubo (ฟรี โอเพนซอร์ส) เพิ่มโฟลเดอร์ คัดลอก CID แล้วเปิดเครื่องไว้ หรือให้คนอื่น pin ซ้ำ
2. **แพ็กเกจฟรีของบริการ pinning** — เช่น Pinata หรือ Filebase แบบฟรี (ผู้สร้างสมัครเอง ตรวจขีดจำกัดล่าสุดของบริการ)
3. **บริการแบบ NFT.Storage / Storacha** เมื่อมีแบบฟรี — อัปโหลดในเบราว์เซอร์แล้วคัดลอก CID
4. **data: URI** — รูปเล็ก (SVG/PNG เล็ก ๆ) หรือ JSON ฝังลงใน token URI ได้เลย ไม่ต้องฝากไฟล์ แต่เก็บบนเชนจึงเสียแก๊สมากกว่า (จำกัด 8 KB ต่อ URI)

ไฟล์บน IPFS เปิดได้เฉพาะเมื่อยังมีคน pin ไว้ เกตเวย์ที่เว็บใช้เปลี่ยนได้ในหน้าตั้งค่า (ค่าเริ่มต้น `https://ipfs.io/ipfs/`)
ตัวอย่างเมทาดาตา:
```json
{ "name": "Siam Cat #1", "description": "…", "image": "ipfs://bafy…/1.png", "attributes": [{ "trait_type": "Color", "value": "Gold" }] }
```

## ความเสี่ยง

- **ยังไม่ audit และใช้บน testnet เท่านั้น** สัญญาเขียนเองโดยไม่ได้ใช้ไลบรารีที่ผ่าน audit (ไม่มีให้ใช้แบบออฟไลน์) มีชุดทดสอบ แต่ไม่ใช่สิ่งทดแทน audit
- รายการขายแบบไม่ฝาก NFT: ถ้าผู้ขายโอน NFT ออกไปแล้ว **ได้กลับคืนมา** รายการเดิมที่ยังไม่หมดอายุจะกลับมาซื้อได้อีก ควร `cancel` หรือ `cancelAll` เมื่อไม่ต้องการขายแล้ว
- governance เปลี่ยนค่าธรรมเนียม (ไม่เกิน 5%) และ registry ได้ทุกเมื่อ รวมถึงระหว่างที่มีรายการขายอยู่; registry ที่ตอบไม่ได้ทำให้ซื้อขายหยุด (fail closed)
- ค่าลิขสิทธิ์ EIP-2981 ขึ้นกับสิ่งที่คอลเลกชันรายงาน (ตัดที่ 10%); คอลเลกชันภายนอกอาจทำงานต่างจากมาตรฐาน — เว็บเตือน และตลาดตรวจว่าผู้ซื้อได้ NFT จริง แต่ไม่รับประกันพฤติกรรมอื่นของสัญญาภายนอก
- เจ้าของคอลเลกชันแก้ base URI ได้จนกว่าจะ freeze; ไฟล์บน IPFS/https อาจหายถ้าไม่มีใคร pin
- ธงของ Neuro เป็นข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา และไม่ใช่คำแนะนำการลงทุน; การตรวจบนเชนครอบคลุมที่อยู่และโค้ด (ลายนิ้วมือ fp1 คำนวณนอกเชน เว็บจึงตรวจเพิ่มให้; สัญญาแบบ proxy ยังไม่ได้ตรวจเป้าหมายที่ proxy ชี้ไป)
- การค้นอีเวนต์จำกัดช่วงบล็อก รายการที่เก่ามากอาจไม่แสดงจนกว่าจะกด "ค้นบล็อกเก่ากว่านี้"

## สิ่งที่ยังไม่ได้ทำ

- EIP-712 signed listings (ลงขายนอกเชนแบบเซ็น) — มีเฉพาะการลงขายบนเชน
- การประมูล, ข้อเสนอระดับคอลเลกชัน, การชำระด้วยโทเคน ERC-20
- การตรวจ proxy (EIP-1967/1167) ของคอลเลกชันภายนอกในเว็บ (กระเป๋า ZETAPHY ทำอยู่) และการแสดงหลักฐาน/คำชี้แจงของธงแบบละเอียด
- ยังไม่ได้ deploy บน testnet จริงและยังไม่ได้ตั้งค่า Vercel/DNS (ทำตามขั้นตอนด้านบน)
