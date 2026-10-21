# ZETAPHY Snap สำหรับ MetaMask (`@zetaphy/snap`)

MetaMask เซ็นได้แค่ ECDSA snap นี้เพิ่ม **บัญชี PQ แท้ (ML-DSA-44, FIPS 204)** บนเชน ZETAPHY ให้ผู้ใช้ MetaMask
- กุญแจสร้างใน MetaMask จาก Secret Recovery Phrase (SRP) ของผู้ใช้ สำรอง MetaMask ไว้ก็กู้บัญชีนี้คืนได้
- เว็บที่ขอให้เซ็นส่งได้แค่ "ข้อความแบบมีโครงสร้าง" (โอน, stake, เรียกสัญญา, deploy, ส่งต่อบัญชีที่ล็อก) snap สร้างธุรกรรมเอง
  แสดงเป็นคำอ่านง่ายในหน้าต่างของ MetaMask และเซ็นเฉพาะเมื่อผู้ใช้กดยืนยัน
- snap ไม่เซ็นไบต์ที่ผู้ใช้อ่านไม่ได้ ไม่ส่ง seed หรือกุญแจลับออกไปไหน และการเซ็นไม่ใช้เน็ต (เว็บเป็นคนส่งธุรกรรมเข้าโหนด)
- **วัคซีนใน MetaMask ธรรมดา** (transaction insight): ทุกธุรกรรม EVM บนทุกเชนที่ผู้ใช้กำลังจะยืนยันใน MetaMask
  snap ตรวจปลายทางกับ `ThreatRegistry` ของ ZETAPHY ให้ ไม่ต้องใช้เว็บกระเป๋าของ ZETAPHY (ดู [วัคซีน](#วัคซีน-ตรวจทุกธุรกรรมใน-metamask))

> **ใช้กับ testnet เท่านั้น ไม่ใช่เงินจริง**
> snap นี้ยังไม่ผ่านการ audit และยังไม่อยู่ใน allowlist ของ MetaMask (ดู [การเผยแพร่](#การเผยแพร่-ตามจริง))

## บัญชีมาจากไหน

```
entropy = snap_getEntropy({ version: 1, salt: "zetaphy-mldsa44-v1" })   // 32 ไบต์
(publicKey, secretKey) = ml_dsa44.keygen(entropy)                        // @noble/post-quantum
address = sha256("zetaphy/mldsa44\0" || publicKey)[0:20]                 // pqAddress ใน pqtx.js
```

- `snap_getEntropy` คือ SIP-6 ของ MetaMask: BIP-32 (secp256k1) จาก SRP ใต้ `m/1399742832'/…`
  โดย path ที่เหลือมาจาก keccak256 ของ **snap ID** และ salt snap อื่นขอ entropy ตัวนี้ไม่ได้
- **บัญชีขึ้นกับ snap ID**
  - `npm:@zetaphy/snap` ให้บัญชีเดิมเสมอสำหรับ SRP เดิม (ติดตั้งใหม่ หรือย้ายเครื่องก็ได้บัญชีเดิม)
  - snap ตอนพัฒนา (`local:http://localhost:8080`) ได้ **บัญชีอื่น** อย่าใช้ snap แบบ local กับเงินที่จะเก็บไว้
  - ถ้าเปลี่ยนชื่อแพ็กเกจ npm บัญชีของทุกคนจะเปลี่ยน
- ห้ามเปลี่ยน salt `zetaphy-mldsa44-v1` (บัญชีของทุกคนจะเปลี่ยน) ถ้าต้องการรูปแบบใหม่ให้เพิ่มเป็น v2 คู่กัน
- ถ้า MetaMask มีหลาย SRP snap ใช้ SRP หลัก (ไม่ได้ส่ง `source`)
- กู้คืนนอก MetaMask ได้ด้วย SRP + snap ID + salt (SIP-6) ไฟล์ทดสอบคำนวณแบบนี้เองแล้วเทียบกับ snap
  แปลว่าใครได้ SRP ไปก็ได้บัญชีนี้ด้วย เหมือนบัญชี ECDSA ใน MetaMask
- seed ที่เป็นสูตรเดียวกัน (seed 32 ไบต์ → keygen → address) ใช้กับ CLI และเว็บกระเป๋า:
  seed `0x00..1f` → `0x6DA134EbFcb035273E87954f0641bD920ED073Ba` / `zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r`

## สิทธิ์ (permissions)

| สิทธิ์ | ใช้ทำอะไร |
|---|---|
| `snap_getEntropy` | สร้างกุญแจ ML-DSA-44 จาก SRP |
| `snap_dialog` | หน้าต่างยืนยันก่อนเซ็นทุกครั้ง |
| `endowment:rpc` (`dapps: true`, `snaps: false`) | ให้เว็บเรียก `zetaphy_getAccount`, `zetaphy_signTx` และ `zetaphy_get/setThreatSource` |
| `endowment:transaction-insight` (`allowTransactionOrigin: false`) | วัคซีน: ตรวจปลายทางของทุกธุรกรรม EVM ก่อนผู้ใช้ยืนยัน ไม่ขอเว็บต้นทางของธุรกรรม เพราะไม่ได้ใช้ (ส่งข้อมูลออกน้อยที่สุด) |
| `endowment:ethereum-provider` | อ่านโค้ดปลายทาง (`eth_getCode`) และช่อง proxy (`eth_getStorageAt`, `eth_call` ของ `implementation()`) บนเชนของธุรกรรมนั้น ผ่าน MetaMask เอง (สลับเชนของ snap ด้วย `wallet_switchEthereumChain` ถ้าต้อง) |
| `endowment:network-access` | ถาม `ThreatRegistry` ผ่าน RPC สาธารณะของ ZETAPHY ด้วย `eth_call` แบบอ่านอย่างเดียว (POST แบบ batch ครั้งเดียวต่อธุรกรรม และอีกครั้งเพื่ออ่านหลักฐานกับคำชี้แจงเมื่อมีธง) ไม่ติดต่อที่อื่น |
| `snap_manageState` | จำแหล่งตรวจภัย (RPC + ที่อยู่ registry) ที่เว็บกระเป๋า ZETAPHY ตั้งให้ (ไม่เข้ารหัส เพราะไม่มีอะไรลับ) |

- กุญแจไม่เกี่ยวกับเน็ตเลย: `snap_getEntropy` ใช้แค่ตอนเซ็น ส่วนที่ใช้เน็ตมีแค่ transaction insight
- `snap_manageState` เก็บแค่แหล่งตรวจภัย ไม่เก็บ seed กุญแจ หรือประวัติธุรกรรม
- `dapps: true` แปลว่าทุกเว็บ **ขอ** เชื่อมได้ แต่ MetaMask ให้ผู้ใช้อนุมัติการเชื่อมทีละเว็บ (`wallet_requestSnaps`)
  และหน้าต่างยืนยันทุกครั้งบอกว่าเว็บไหนขอ
- ยังไม่จำกัดโดเมน เพราะโดเมนจริงของเว็บกระเป๋ายังไม่แน่นอน เมื่อแน่นอนแล้ว ให้เปลี่ยนเป็น
  `"endowment:rpc": { "allowedOrigins": ["https://<โดเมนกระเป๋า>"] }` ก่อนเผยแพร่ (เปลี่ยนแล้วต้อง build ใหม่)

## API สำหรับเว็บ

```js
const snapId = 'npm:@zetaphy/snap';
await ethereum.request({ method: 'wallet_requestSnaps', params: { [snapId]: {} } });
const invoke = (method, params) => ethereum.request({ method: 'wallet_invokeSnap', params: { snapId, request: { method, params } } });

const acct = await invoke('zetaphy_getAccount');
// { publicKey: '0x…' (1312 ไบต์), address: 'zetaphy1…', hex: '0x…' }  ไม่มีอะไรลับ
```

### `zetaphy_signTx`

```js
const signed = await invoke('zetaphy_signTx', {
  chainId: 'zetaphy_77390-1',   // ต้องขึ้นต้น zetaphy- (เชนอื่นที่ไม่ใช่ testnet จะมีคำเตือนในหน้าต่าง)
  accountNumber: '12', sequence: '4',          // จาก zetaphy_pqAccount
  gasLimit: '400000', gasPrice: '1200000000',  // ค่าธรรมเนียม = gasLimit × gasPrice (azetaphy)
  memo: '',                                    // ไม่บังคับ ไม่เกิน 256 ตัว ห้ามอักขระควบคุม
  lang: 'th',                                  // 'th' หรือ 'en' (ภาษาของหน้าต่าง)
  messages: [{ type: 'send', to: 'zetaphy1…', amount: '1250000000000000000' }],
});
// ถ้าผู้ใช้กดยืนยัน: { signature, txHex, txHash, bodyBytes, authInfoBytes } (hex)
// ถ้ากดยกเลิก: error code 4001 ไม่มีลายเซ็น
// แล้วเว็บส่งเอง: zetaphy_sendCosmosTx(signed.txHex)
```

ตัวเลขทุกตัวเป็นสตริงเลขฐานสิบ (หรือ number ที่ไม่เกิน 2^53) ไบต์เป็น hex `0x…` ผู้ส่งคือบัญชีของ snap เสมอ เว็บกำหนดไม่ได้
ฟิลด์ที่ไม่รู้จักถูกปฏิเสธ (`-32602`) ก่อนมีหน้าต่างใด ๆ

| `type` | ฟิลด์ | หน้าต่างแสดง |
|---|---|---|
| `send` | `to`, `amount`, `denom?` | ผู้รับ (zetaphy1… และ 0x…), จำนวนและ denom |
| `delegate`, `undelegate` | `validator`, `amount`, `denom?` | validator, จำนวน (undelegate มีหมายเหตุช่วง unbonding) |
| `withdrawRewards` | `validator` | validator |
| `evmCall` | `to`, `data?`, `value?`, `gasLimit?`, `asOwner?` | สัญญา, ฟังก์ชัน (อ่านออกสำหรับ ERC-20 `transfer`/`approve`/`transferFrom` และ precompile stake/รางวัล), ไม่รู้จักก็แสดง selector + call data พร้อมคำเตือน, ZETAPHY ที่ส่งไป, EVM gas, `as_owner` |
| `evmDeploy` | `initCode`, `value?`, `gasLimit?`, `asOwner?` | "สร้างสัญญา", ขนาดโค้ดและ keccak-256 ของโค้ด |
| `quantumLock` | `owner`, `controller` | บัญชีที่ล็อกไว้, ผู้ควบคุมคนใหม่, คำเตือนว่าสละการควบคุม |

ท้ายหน้าต่าง: ค่าธรรมเนียมสูงสุด, gas × ราคา, ยอดที่บัญชีคุณจ่าย (จำนวน ZETAPHY ในข้อความ + ค่าธรรมเนียม ส่วน as_owner ออกจากบัญชีที่ล็อก), memo, chain id, account number / sequence, บัญชีที่เซ็น และเว็บที่ขอ

- snap สร้างข้อความด้วย `messageFromIntent` ของ `zetaphy-network/src/pqtx.js` (โค้ดเดียวกับ CLI และเว็บกระเป๋า) ก่อนแสดงหน้าต่าง
  หน้าต่างอ่านค่าจากข้อความที่สร้างแล้ว และเซ็นข้อความชุดนั้น
- ใน `pqtx.js` ทุกข้อความมี `intent` (ข้อความเดียวกันเป็น JSON) และ `pqClient` รับ `signTx` แทน `sign` ได้:
  `client.send({ publicKey, signTx: (req) => invoke('zetaphy_signTx', req), to, amount })`
  `pqClient` ตรวจก่อนเหมือนเดิม แล้วสร้าง tx เองรอบลายเซ็นที่ได้ ถ้า `txHex` ของ snap ไม่ตรงกับที่ขอ จะไม่ส่ง

## ใช้กับเว็บกระเป๋า (`zetaphy-wallet`)

การ์ด "ใช้ MetaMask (ZETAPHY Snap)" ในหน้าเริ่มต้น
- snap ID มาจาก `<meta name="zetaphy-snap-id">` ใน `index.html` (ค่าเริ่มต้น `npm:@zetaphy/snap`) เปลี่ยนได้ใน "ตั้งค่าเพิ่มเติม" ตอนพัฒนา
- หน้าเว็บคำนวณที่อยู่จาก public key เอง ไม่เชื่อที่อยู่ที่ snap บอก
- โอน, โอนโทเคน, stake และ deploy เซ็นผ่าน `zetaphy_signTx` ส่วนโหมดกุญแจในเบราว์เซอร์ (seed เข้ารหัสด้วยรหัสผ่าน) ยังใช้ได้เหมือนเดิม

## วัคซีน: ตรวจทุกธุรกรรมใน MetaMask

ก่อนผู้ใช้ยืนยันธุรกรรม EVM ใด ๆ ใน MetaMask (ทุกเชน ทุกเว็บ) snap แสดงผลตรวจของ ZETAPHY Neuro ในแท็บของ snap
1. **ปลายทาง:** `to` ของธุรกรรม และที่อยู่ที่ call data ระบุ: ผู้ได้สิทธิ์ใน `approve` / `increaseAllowance`, ผู้ได้สิทธิ์ทั้งหมดใน `setApprovalForAll`, ผู้รับใน `transfer` ของ ERC-20
2. **บนเชนของธุรกรรม** (ผ่าน `ethereum.request` ของ snap): อ่านโค้ดของแต่ละปลายทาง แล้วตามไปที่โค้ดจริงหลัง proxy แบบ EIP-1167 (และรูปแบบ PUSH0), EIP-1967 implementation และ beacon สูงสุด 3 ชั้น
   - ใช้โค้ดชุดเดียวกับเว็บกระเป๋า: `zetaphy-network/src/vaccine.js` (`proxyTargets`, `threatQueries`)
3. **ถาม ZETAPHY** ด้วย JSON-RPC batch เดียว: `eth_chainId` (ต้องเป็น 77390) แล้ว `eth_call` ไปที่ `ThreatRegistry` ของแต่ละปลายทาง ทั้งระดับเตือนและบังคับใช้
   - `isAddressFlagged` / `isAddressEnforced(chainId ของธุรกรรม, ที่อยู่)`
   - `isCodeFlagged` / `isCodeEnforced(keccak256(โค้ด))`
   - `isFlagged` / `isEnforced(fp1)`: ลายนิ้วมือ Neuro (`fp1`) คำนวณใน snap เอง (สำเนาสูตรของ `zetaphy-neuro/src/fingerprint.js` ใน `vaccine.js` ไม่ดึง bytecode reader ทั้งชุดเข้ามา การทดสอบเทียบกับของ Neuro ทุกไบต์)

4. **เฉพาะเมื่อมีธง** ถามอีก batch: `evidenceOf(key)` ของแต่ละธง (reportHash และ URI) และ `responseOf(key)` ของทุกคีย์ของปลายทางนั้น (คำชี้แจงของเจ้าของ)
   ถามไม่ได้ก็ยังเตือนเหมือนเดิม และบอกว่าอ่านหลักฐานไม่ได้

ทุกธงแสดงหมวดเป็นข้อเท็จจริงของโค้ด (ไม่ใช่ป้ายกล่าวหา) หลักฐานและวิธีตรวจซ้ำ คำชี้แจงของเจ้าของ (ถ้ามี) และบรรทัด
"ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา / Automated code analysis, not an accusation" เจ้าของสัญญาชี้แจงหรืออุทธรณ์ได้บนเชน
(zetaphy-network/README.md ขั้น 4) ดู [`docs/LEGAL.md`](../docs/LEGAL.md)

ผลที่ MetaMask แสดง (ไทยและอังกฤษพร้อมกัน เพราะ insight ไม่รู้ภาษาผู้ใช้):

| ผล | แสดง |
|---|---|
| ธงบังคับใช้แล้ว (เลย `enforceDelay` หรือผ่านช่องทางด่วน) | ระดับ `critical`: MetaMask ให้ยืนยันอีกชั้น พร้อมคำเตือน ที่อยู่ เหตุผล และติดธงเพราะอะไร (ที่อยู่ / โค้ด / fp1 / โค้ดหลัง proxy) |
| ติดธงแต่ยังไม่บังคับใช้ | กล่องคำเตือน ไม่ใช่ critical |
| ไม่ติดธง | "ตรวจโดย ZETAPHY Neuro แล้ว: ไม่ติดธง" |
| ตรวจไม่ได้ (RPC ล่ม, RPC ไม่ใช่ ZETAPHY, ยังไม่ตั้ง registry, อ่านโค้ดบนเชนนั้นไม่ได้) | "ZETAPHY Neuro ตรวจไม่ได้" และเหตุผล (ไม่บอกว่าปลอดภัย) |
| สร้างสัญญา (ไม่มี `to`) | บอกว่าไม่มีปลายทางให้ตรวจ |

- ถ้าอ่านโค้ดไม่ได้แต่ที่อยู่ติดธง ยังแสดงธงนั้น
- snap ไม่ปฏิเสธธุรกรรมเอง (insight ทำไม่ได้) การตัดสินใจสุดท้ายเป็นของผู้ใช้ ต่างจากเว็บกระเป๋า ZETAPHY ที่ไม่เซ็นเลยเมื่อธงบังคับใช้

### ความเป็นส่วนตัว (ข้อมูลที่ส่งออกไป)

- snap ส่ง **ที่อยู่ปลายทาง, chain id ของธุรกรรม, code hash (keccak-256) และ fp1 ของโค้ดปลายทาง** ไปที่ RPC ของ ZETAPHY
  เจ้าของ RPC นั้นจึงเห็นได้ว่ามีคนกำลังจะส่งธุรกรรมไปหาสัญญาไหน (และ IP ของผู้ใช้ เหมือน RPC ทั่วไป)
- **ไม่ส่ง** ที่อยู่ของผู้ใช้ จำนวนเงิน call data ทั้งก้อน หรือเว็บต้นทาง (`allowTransactionOrigin: false`)
- การอ่านโค้ดบนเชนของธุรกรรมไปผ่าน RPC ที่ MetaMask ใช้อยู่แล้ว
- ไม่อยากส่ง: ปิดสิทธิ์ของ snap ใน MetaMask หรือไม่ติดตั้ง snap (การเซ็นของเว็บกระเป๋าไม่เกี่ยวกับส่วนนี้)

### แหล่งตรวจภัย (RPC และ ThreatRegistry)

- ค่าตอน build อยู่ใน `snap.config.js` (`environment`) **ตอนนี้เป็นค่าตั้งต้นที่ยังใช้ไม่ได้**: RPC `https://rpc.zetaphy.invalid`, registry `0x000…0`
  ทุกธุรกรรมจึงขึ้น "ตรวจไม่ได้: no ThreatRegistry configured" จนกว่าเจ้าของจะใส่ค่าจริงแล้ว build ใหม่ (shasum เปลี่ยน ต้อง commit manifest)
- เว็บกระเป๋า ZETAPHY เปลี่ยนแหล่งได้ด้วย `zetaphy_setThreatSource` เฉพาะจาก origin ใน `ZETAPHY_WALLET_ORIGINS` (ค่าตั้งต้น `https://wallet.zetaphy.invalid` ใส่โดเมนจริงตอนรู้แล้ว)
  และผู้ใช้ต้องกดยืนยันในหน้าต่างของ MetaMask ทุกครั้ง เว็บอื่นได้ error 4100

```js
await invoke('zetaphy_setThreatSource', { rpc: 'https://<RPC ของ ZETAPHY>', registry: '0x<ThreatRegistry>' }); // หรือ { reset: true }
await invoke('zetaphy_getThreatSource'); // { rpc, registry, overridden } เว็บไหนก็อ่านได้ (ไม่มีอะไรลับ)
```

- RPC ต้องเป็น `https://` (ยกเว้น `http://localhost` / `127.0.0.1` ตอนพัฒนา) ไม่เกิน 256 ตัว ไม่มี user:password ในลิงก์
- เว็บกระเป๋ายังไม่ได้เรียก `zetaphy_setThreatSource` ให้อัตโนมัติ (ตอนนี้ต้องเรียกเองหรือใส่ค่าตอน build)

## คำสั่ง

```
npm ci
npm run build     # mm-snap build: dist/bundle.js และ shasum ใน snap.manifest.json (commit manifest)
npm test          # Jest + @metamask/snaps-jest: รัน dist/bundle.js ใน MetaMask จำลอง (ต้อง build ก่อน)
npm run serve     # เสิร์ฟ snap ที่ http://localhost:8080 สำหรับ MetaMask Flask (snap ID local:http://localhost:8080)
```

- `dist/` ไม่ได้ commit ส่วน `snap.manifest.json` commit ไว้ CI build ใหม่แล้วตรวจว่า shasum ใน manifest ตรง
  ถ้าแก้ `src/`, `snap.config.js`, `zetaphy-network/src/pqtx.js` หรือ `zetaphy-network/src/vaccine.js` ต้อง `npm run build` แล้ว commit manifest ด้วย
- `@noble/*` ที่ `pqtx.js` import ถูก resolve จาก `node_modules` ของแพ็กเกจนี้ (`snap.config.js`, `test/resolver.js`)
  bundle จึงขึ้นกับ `package-lock.json` นี้เท่านั้น
- `package.json` มี `overrides` ตรึง `@metamask/snaps-utils` 12.6.0, `snaps-controllers` 21.1.1, `snaps-execution-environments` 11.3.1
  เพราะรุ่นถัดไป (ต.ค. 2026) ใช้ `@metamask/utils` 12 ที่เป็น ESM อย่างเดียว ทำให้ Jest (CommonJS) โหลด snaps-jest ไม่ได้

### ทดสอบอะไรบ้าง (`test/snap.test.js`)

- สูตรที่อยู่: seed `0x00..1f` ได้ค่าที่รู้อยู่แล้ว ผ่านฟังก์ชัน `accountFromSeed` ที่ snap ใช้จริง
- `zetaphy_getAccount` เท่ากับ ML-DSA-44 ของ SIP-6 entropy ที่คำนวณเองจาก SRP + snap ID + salt, SRP เดิมได้บัญชีเดิม, SRP อื่นได้บัญชีอื่น, ไม่มีส่วนของกุญแจลับในคำตอบ
- ข้อความในหน้าต่างของทุกชนิด: send (และ denom อื่น, เชนอื่น), delegate/undelegate/rewards, evmCall (ERC-20, ฟังก์ชันที่ไม่รู้จัก, approve ไม่จำกัด, โอนเปล่า), as_owner + precompile stake, deploy, handover, หลายข้อความ, ภาษาไทย
- กดยกเลิก: error 4001 ไม่มีลายเซ็น
- ลายเซ็นตรวจผ่านด้วย `ml_dsa44.verify` บน SignDoc ที่สร้างใหม่ด้วย `cosmjs-types` และข้อความถอดรหัสได้ตรง
- input ผิดรูป 31 แบบถูกปฏิเสธด้วย `-32602` ก่อนมีหน้าต่าง, method ที่ไม่มีได้ `-32601`

`test/insight.test.js` (วัคซีน: เชนของธุรกรรมจำลองด้วย `snap.mockJsonRpc` ส่วน RPC ของ ZETAPHY เป็นเซิร์ฟเวอร์ JSON-RPC เล็ก ๆ บน 127.0.0.1)
- `fp1` ใน snap เท่ากับ `codeFingerprint` ของ zetaphy-neuro ทุกไบต์
- ค่าตั้งต้น (ยังไม่มี registry): "ตรวจไม่ได้"
- `zetaphy_setThreatSource`: origin อื่นได้ 4100, input ผิดรูปได้ -32602, กดยกเลิกได้ 4001, ตั้งแล้ว `getThreatSource` เห็น, `reset` กลับค่าตั้งต้น
- ไม่ติดธง: "ตรวจโดย ZETAPHY Neuro แล้ว" ส่ง batch เดียว และสิ่งที่ส่งมีแค่ที่อยู่ปลายทาง chain id code hash และ fp1 (ไม่มีที่อยู่ผู้ใช้)
- ธงบังคับใช้ (ที่อยู่, code hash, fp1): `critical` พร้อมเหตุผลไทย/อังกฤษ; ธงที่ยังไม่บังคับใช้: คำเตือน ไม่ใช่ critical
- ผู้ได้สิทธิ์ใน `approve` ที่ติดธง: critical; การอ่านปลายทางจาก call data (approve, setApprovalForAll, transfer, increaseAllowance)
- proxy: EIP-1167, EIP-1967 implementation, beacon ที่ชี้ไปโค้ดติดธง = critical; proxy ตัวเดิมหน้าโค้ดสะอาด = ไม่ติดธง
- ตรวจไม่ได้: RPC ตอบ 500, RPC ไม่ใช่ ZETAPHY, อ่านโค้ดบนเชนไม่ได้ (แต่ที่อยู่ติดธงยังขึ้น critical)
- Jest รันไฟล์ทดสอบทีละไฟล์ (`maxWorkers: 1`) เพราะ snaps-jest ใช้พอร์ต 18096 ตายตัว

ที่ทดสอบในเครื่องนี้ไม่ได้: หน้าต่างจริงใน MetaMask Flask (snaps-jest ตรวจโครงสร้าง UI ไม่ได้วาดจริง) และการส่งธุรกรรมที่ snap เซ็นเข้าเชนจริง
(สูตรธุรกรรมเดียวกันทดสอบกับเชนจริงแล้วใน `zetaphy-network/test/devnet.pq.integration.js`)

## การเผยแพร่ (ตามจริง)

- **ตอนนี้ติดตั้งได้เฉพาะใน MetaMask Flask** (รุ่นสำหรับนักพัฒนา) จาก `npm run serve` (snap ID `local:http://localhost:8080`)
  หรือจาก npm หลังเผยแพร่แล้ว
- MetaMask ปกติ (ไม่ใช่ Flask) ติดตั้งได้เมื่อ snap **เผยแพร่บน npm แล้ว และอยู่ใน allowlist ของ MetaMask** เท่านั้น
  เพราะ `snap_getEntropy` และ `endowment:rpc` เป็นสิทธิ์ที่ต้องผ่านการตรวจ (protected permissions)
- การเผยแพร่บน npm ต้องใช้บัญชี npm ของเจ้าของโปรเจกต์ **เจ้าของต้องทำเอง** (โค้ดนี้ไม่มีและไม่ควรมี token ของ npm)
- allowlist ต้องผ่านการรีวิวของทีม MetaMask (อย่างน้อยสองคน) และเพราะ snap ใช้ `snap_getEntropy` (จัดการกุญแจ)
  **ต้องมีรายงาน audit จากบริษัทภายนอกที่ MetaMask รับรอง** (รายชื่ออยู่ที่ https://github.com/MetaMask/snaps/wiki/Audits) ซึ่งมีค่าใช้จ่าย
  รายงาน audit จะถูกเปิดเผยต่อสาธารณะ และทุกเวอร์ชันใหม่ต้องยื่นขอ allowlist ใหม่

### ขั้นตอนของเจ้าของโปรเจกต์

1. **บัญชี npm**: สมัคร https://www.npmjs.com เปิด 2FA แล้วสร้าง organization ชื่อ `zetaphy` (ฟรีสำหรับแพ็กเกจสาธารณะ)
   - ถ้าชื่อ `zetaphy` ถูกใช้แล้ว ให้ใช้ scope ของตัวเอง แล้วแก้ชื่อให้ตรงกันทุกที่: `name` ใน `package.json`,
     `source.location.npm.packageName` ใน `snap.manifest.json`, `<meta name="zetaphy-snap-id">` ใน `zetaphy-wallet/index.html`
     และ `DEFAULT_SNAP_ID` ใน `zetaphy-wallet/app.js` (ชื่อแพ็กเกจเป็นส่วนหนึ่งของ snap ID: เปลี่ยนหลังมีผู้ใช้แล้วบัญชีจะเปลี่ยน)
2. **โดเมน** (แนะนำ): เมื่อรู้โดเมนจริงของเว็บกระเป๋า เปลี่ยน `endowment:rpc` เป็น `allowedOrigins` (ดูหัวข้อสิทธิ์)
3. **เวอร์ชัน**: ตั้ง `version` ใน `package.json` และ `snap.manifest.json` ให้ตรงกัน แล้ว
   ```
   cd zetaphy-snap
   npm ci
   npm run build && npm test
   git add snap.manifest.json && git commit    # shasum ใหม่ (CI ตรวจ)
   ```
4. **ตรวจไฟล์ที่จะเผยแพร่**: `npm pack --dry-run` ต้องมีแค่ `dist/bundle.js`, `images/icon.svg`, `snap.manifest.json`, `package.json`, `README.md`
5. **เผยแพร่**: `npm login` แล้ว `npm publish --access public` (`prepublishOnly` build และตรวจ manifest ให้อีกรอบ)
   - หลังเผยแพร่ ชื่อ+เวอร์ชันนั้นแก้ไม่ได้ จะแก้ต้องออกเวอร์ชันใหม่
6. **ทดสอบใน Flask**: เปิดเว็บกระเป๋าใน MetaMask Flask กด "ใช้ MetaMask (ZETAPHY Snap)" (snap ID `npm:@zetaphy/snap`)
   ลองโอน, stake, deploy บน testnet และตรวจข้อความในหน้าต่าง
7. **ขอ allowlist** (ถ้าต้องการให้ใช้ MetaMask ปกติได้):
   - ใส่ค่าจริงของวัคซีนใน `snap.config.js` (RPC ของ ZETAPHY, ThreatRegistry, โดเมนเว็บกระเป๋า) แล้ว build ใหม่
   - ลบ log และสิทธิ์ที่ไม่ใช้ (ตอนนี้ไม่มี) และสแกนด้วย [Snapper](https://github.com/sayfer-io/Snapper)
   - `endowment:network-access`, `endowment:ethereum-provider` และ `endowment:transaction-insight` ต้องอธิบายในคำขอ allowlist (ดูตารางสิทธิ์และหัวข้อความเป็นส่วนตัว)
   - จ้าง auditor จากรายชื่อของ MetaMask ให้ audit `src/` ของ snap และ `zetaphy-network/src/pqtx.js` กับ `@noble/post-quantum` (โมดูลจัดการกุญแจ)
     แก้ทุกข้อที่ระดับ medium ขึ้นไป แล้วเก็บ commit ที่ audit และ commit ที่แก้
   - กรอกฟอร์ม https://go.metamask.io/snaps-directory-request (ชื่อต้องตรงกับ `proposedName` คือ "ZETAPHY Post-Quantum"
     ห้ามมีคำว่า MetaMask, Snap, Meta, Mask) แนบรายงาน audit, ลิงก์ GitHub และ npm, ข้อมูลติดต่อฝ่ายช่วยเหลือ, รูปและวิดีโอสาธิต
   - เวอร์ชันใหม่ทุกครั้งต้องยื่นผ่าน https://go.metamask.io/snaps-directory-update-request
8. หลังอยู่ใน allowlist แล้ว แก้ข้อความ "ติดตั้งได้เฉพาะใน MetaMask Flask" ในเว็บกระเป๋า (`snapFlask` ใน `app.js`)

## ไฟล์

| ไฟล์ | คืออะไร |
|---|---|
| `src/index.jsx` | `onRpcRequest`: `zetaphy_getAccount`, `zetaphy_signTx`, `zetaphy_get/setThreatSource`; `onTransaction` (วัคซีน) |
| `src/threats.js`, `src/insight.jsx` | วัคซีน: ปลายทาง, อ่านโค้ด/proxy บนเชนนั้น, ถาม ThreatRegistry และหน้าที่แสดงใน MetaMask |
| `../zetaphy-network/src/vaccine.js` | ใช้ร่วมกับเว็บกระเป๋า: view ของ registry, การตาม proxy, fp1 |
| `src/account.js` | seed → ML-DSA-44 → ที่อยู่ (สูตรเดียวกับ CLI และเว็บกระเป๋า) |
| `src/request.js` | ตรวจพารามิเตอร์ของ `zetaphy_signTx` อย่างเข้ม |
| `src/describe.js`, `src/dialog.jsx` | ข้อความในหน้าต่างยืนยัน (ไทย/อังกฤษ) และการวาด |
| `src/pqtx.js` | re-export `zetaphy-network/src/pqtx.js` |
| `snap.manifest.json`, `snap.config.js`, `images/icon.svg` | manifest (shasum), การ build, ไอคอน |
| `test/snap.test.js`, `test/insight.test.js`, `jest.config.js`, `test/resolver.js` | การทดสอบด้วย snaps-jest |
