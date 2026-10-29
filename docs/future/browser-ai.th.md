[English](browser-ai.md) | **ภาษาไทย**

# AI ในเบราว์เซอร์: ทะเบียนโมเดล, แจกจ่ายแบบตรวจได้, P2P, แบ่งโมเดลข้ามเบราว์เซอร์, ความรู้บนเชน

สถานะ: **ต้นแบบบน testnet** ทุกอย่างทำงานโดยไม่มีเซิร์ฟเวอร์ของเรา ไม่ต้องใช้ API key และไม่เพิ่ม dependency ใหม่ ไม่มีส่วนใดเคลื่อนย้ายเงิน

| ข้อ | สถานะ |
|---|---|
| (1) ทะเบียนโมเดลบนเชน | **เสร็จ** (สัญญา, สคริปต์ deploy/propose, เทสต์) ยังไม่ได้ deploy: ต้องให้ผู้ถือ timelock ทำ |
| (2) แจกจ่ายเป็นชิ้นแบบตรวจได้ + P2P | **เสร็จ** สำหรับ mirror และ WebRTC แบบแลกรหัสเอง; **ช่องว่าง**: การค้นหา peer อัตโนมัติต้องมีช่อง signaling (ดูด้านล่าง) |
| (7) แบ่งโมเดลใหญ่ข้ามเบราว์เซอร์ | **ต้นแบบ** บนโมเดล MLP ของเล่น (พิสูจน์กลไกได้ ผลตรงกันทุกบิต) ไม่ใช่ LLM จริง |
| (8) ความรู้บนเชนสำหรับ RAG | **เสร็จ** (ตัวอ่าน, ดัชนีในเครื่อง, ต่อเข้า context, ตัวเลือกในแผง) |
| ผู้ให้บริการในเบราว์เซอร์ | **เสร็จ แต่ใช้โมเดลเล็ก**: คะแนนความเสี่ยงที่เรียนรู้ของ Neuro (87 KB) + แม่แบบ ไม่ได้รวม runtime ของ LLM |

## (1) ModelRegistry — `zetaphy-network/contracts/ModelRegistry.sol`

หนึ่งระเบียนต่อ `(id, version)`: `kind` (model / skill / prompt / ruleset), `manifestHash` (sha256 ของไบต์ไฟล์ manifest),
`chunkRoot` (Merkle root ของชิ้น), `size`, `chunkSize`, `license` (SPDX), `author`, `status`
(active / suspended / deprecated / revoked), เวลาเผยแพร่และอัปเดต `id = keccak256("zetaphy.registry" ‖ kind ‖ name)`

- **governance = ZetaphyTimelock** (รอ 48 ชม. อย่างเปิดเผย): `publish`, `setStatus`, `setGuardian`, `setGovernance` เวอร์ชันมีแต่เพิ่มขึ้น
- **guardian**: ทำได้แค่ `suspend` ทันที (ลดความเสี่ยงเท่านั้น) การเปิดใช้อีกครั้งต้องผ่าน governance
- `revoked` ถาวร (แก้โมเดล = ออกเวอร์ชันใหม่) ตัวโหลดปฏิเสธทุกอย่างที่ไม่ใช่ `active`

```sh
cd zetaphy-network
KEYFILE=~/.zetaphy/deployer.key node scripts/model-registry.js deploy --governance 0x<ZetaphyTimelock>
node scripts/model-registry.js propose --registry 0x… --release ../zetaphy-neuro/web/models/neuro-ml-gbdt/1/release.json --author 0x… --timelock 0x…
node scripts/model-registry.js show --registry 0x… --name neuro-ml-gbdt
```

สิ่งที่ยังเหลือ: deploy บน testnet แล้วเผยแพร่ `neuro-ml-gbdt` v1 ผ่าน timelock จากนั้นใส่ที่อยู่ใน `zetaphy-neuro/ai/browser/config.js`
ระหว่างนี้หน้าเว็บใช้รุ่นที่ **ปักไว้ในโค้ด** และบอกผู้ใช้ตรง ๆ ตัว monitor ยังไม่แจ้งเตือนเหตุการณ์ของทะเบียนนี้

## (2) แจกจ่ายเป็นชิ้นแบบตรวจได้ — `zetaphy-neuro/ai/browser/`

- **Manifest** (`zetaphy-manifest/1`): รายการ sha256 ของทุกชิ้น (ค่าเริ่มต้น 4 MiB) และ Merkle root
  (`leaf = sha256(0x00‖hash)`, `node = sha256(0x01‖L‖R)`, โหนดคี่ยกขึ้นไปโดยไม่ทำซ้ำ)
- **ตัวสร้าง**: `node scripts/build-model-pack.js --in <ไฟล์> --name … --version … --runtime … --license …`
  ได้ `manifest.json`, `<sha256>.bin`, `release.json` อัปโหลดทั้งโฟลเดอร์ไปที่เว็บนี้, GitHub Releases หรือ IPFS ได้เลย
- **ตัวโหลด**: อ่านรุ่นจากทะเบียน → manifest ต้องตรงกับ `manifestHash` และ root → ทุกชิ้นต้องตรงความยาวและ sha256
  (จากแคช → peer → mirror) → ตรวจ sha256 ทั้งไฟล์อีกรอบ mirror หรือ peer ทำได้แค่ช้าหรือไม่ส่ง แก้ไบต์ไม่ได้
  แคชใช้ Cache API (สำรองด้วย IndexedDB) และตรวจ hash ซ้ำทุกครั้งที่ใช้
- **P2P**: WebRTC data channel พร้อมโปรโตคอลขอ/ตอบ แบ่งเฟรม 60 KiB, backpressure, timeout

**Signaling — อะไรฟรีและอะไรไม่ฟรี** ที่ทำแล้ว: **แลกรหัสเอง** เบราว์เซอร์หนึ่งสร้างรหัสข้อเสนอ (`ZP1.` ประมาณ 0.5–1 KB)
อีกฝั่งวางแล้วส่งรหัสตอบกลับ ส่งผ่านแชต อีเมล หรือ QR ได้ ไม่มีเซิร์ฟเวอร์ ค่าเริ่มต้นไม่มี STUN/TURN จึงใช้ได้ **ในเครื่องเดียวกันหรือ LAN เดียวกัน**
ใส่ STUN สาธารณะได้เพื่อข้าม NAT ทั่วไป แต่ **NAT แบบ symmetric ต้องใช้ TURN ซึ่งเป็นเซิร์ฟเวอร์: ไม่ได้จัดให้**
การค้นหา peer อัตโนมัติต้องมีช่องนัดพบ (เช่น tracker ของ WebTorrent หรือ relay ของ Nostr ซึ่งเป็นเซิร์ฟเวอร์ของคนอื่น) **ยังไม่ได้ทำ**
และยังไม่มีตัววาด QR (รหัสเป็นข้อความธรรมดา)

## (7) แบ่งโมเดลข้ามเบราว์เซอร์ — `pipeline.js`, `toymodel.js` (ต้นแบบ)

แบ่งชั้นเป็นช่วงต่อเนื่องให้แต่ละ peer รัน ผู้ประสานงานแบ่ง batch เป็น micro-batch และส่งหลายชุดพร้อมกันให้ทุกช่วงทำงานพร้อมกัน
(forward อย่างเดียว) activation ส่งเป็น float32 ผ่าน data channel พิสูจน์แล้วว่า **ผลตรงกับการรันเครื่องเดียวทุกบิต**
ทั้งผ่านช่องในหน่วยความจำ (3 ช่วง) และผ่าน **WebRTC จริงระหว่าง Chromium สองตัว** peer ที่โกหกถูกจับได้ด้วยการสุ่มคำนวณซ้ำ

ข้อจำกัด: เป็น MLP ของเล่น ไม่ใช่โมเดลภาษา ไม่มีการถอดรหัสทีละโทเค็น ไม่มี KV cache ไม่มี attention ไม่ทนต่อ peer หลุด
ยังโหลดเฉพาะชิ้นของช่วงตัวเองไม่ได้ และพิสูจน์ไม่ได้ว่า peer คำนวณถูก (ต้องมีน้ำหนักเพื่อสุ่มตรวจ หรือใช้สำเนาซ้ำซึ่งแพงเป็นสองเท่า)
ความหน่วงต่อโทเค็น = จำนวนช่วง × รอบเครือข่าย เร็วใน LAN ช้าข้ามอินเทอร์เน็ต โมเดล 7B+ จริงต้องมี runtime WebGPU ที่โหลดเป็นช่วงชั้นได้

## (8) ความรู้บนเชนสำหรับ RAG — `zetaphy-neuro/ai/onchain.js`

อ่าน log ของ ThreatRegistry (`Voted`, `Flagged`, `Cleared`, `Protected`) และ NeuroJobs (`JobRequested`, `Finalized`) ทีละ 500 บล็อก
แบบต่อเนื่องได้ แล้วค้นด้วยกุญแจของวัคซีน (ลายนิ้วมือ fp1, addressKey, codeKey — คำนวณเหมือนสัญญาและตรวจเทียบกับสัญญาจริงในเทสต์)
และผลตัดสินในอดีตของเป้าหมายเดียวกัน (บอกว่าตรงกับผลตัดสินของรายงานนี้หรือไม่) ใส่ใน context เป็น `facts.onchain`
ด้วยรหัสหลักฐาน `CHAIN<n>` และป้ายว่า "ข้อมูลที่ runner เขียน ไม่ใช่กฎของ Neuro อาจเก่า และไม่ลดระดับความเสี่ยง"
ข้อความที่ runner เขียน (uri) อยู่ในรั้วข้อมูลไม่น่าเชื่อถือเท่านั้น ใช้ได้กับทุกผู้ให้บริการผ่านช่องติ๊กในแผง
สิ่งที่ยังเหลือ: งาน GitHub Actions ที่เผยแพร่ snapshot ประวัติทั้งหมด และยังไม่ได้ตั้งที่อยู่ NeuroJobs

## ผู้ให้บริการในเบราว์เซอร์ — `browser`

ตัวเลือก "ในเบราว์เซอร์นี้ (โมเดลที่ตรวจแล้ว ไม่ต้องใช้ key)" รันด้วย JS ธรรมดา **ไม่มี WASM ไม่มี eval CSP จึงไม่เปลี่ยน**
ถ้าภายหลังรวม runtime ของ LLM แบบ WASM/WebGPU สิ่งเดียวที่อนุญาตให้เพิ่มคือ `'wasm-unsafe-eval'` ใน `script-src`
(ทั้ง meta ใน `web/index.html` และ `vercel.json`) และห้ามโหลดจาก CDN

พูดตรง ๆ: **ไม่ใช่โมเดลภาษา** แพ็ก `web/models/neuro-ml-gbdt/1/` คือสำเนาคงที่ของคะแนนความเสี่ยงที่เรียนรู้ของ Neuro (`ml/model.json`)
เครื่องยนต์ให้คะแนนแล้วเขียนรายงานจากแม่แบบใน 9 ภาษา อ้างเฉพาะ `F<n>`, `CHAIN<n>`, `ML` และไม่เคยบอกว่า "กังวลน้อยกว่า"
คำถามต่อจะได้ข้อมูลในบริบทที่ใกล้ที่สุด ไม่ใช่ข้อความที่สร้างขึ้น ผลผ่านตัวตรวจเดียวกับผู้ให้บริการอื่น
ที่ไม่ได้รวม LLM จริงเพราะ runtime + น้ำหนักแม้โมเดล 0.5B ก็หลายสิบถึงหลายร้อย MB ใหญ่เกินกว่าจะเก็บใน repo ทางสำหรับมันพร้อมแล้ว

เทสต์: `zetaphy-neuro/test/browserai.test.js`, `test/browserai.e2e.js`, `zetaphy-network/test/modelregistry.test.js`
