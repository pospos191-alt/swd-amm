[English](browser-ai.md) | **ภาษาไทย**

# AI ในเบราว์เซอร์: ทะเบียนโมเดล, แจกจ่ายแบบตรวจได้, P2P, แบ่งโมเดลข้ามเบราว์เซอร์, ความรู้บนเชน

สถานะ: **ต้นแบบบน testnet** ทุกอย่างทำงานโดยไม่มีเซิร์ฟเวอร์ของเรา ไม่ต้องใช้ API key และไม่เพิ่ม dependency ใหม่ ไม่มีส่วนใดเคลื่อนย้ายเงิน

| ข้อ | สถานะ |
|---|---|
| (1) ทะเบียนโมเดลบนเชน | **เสร็จ** (สัญญา, สคริปต์ deploy/propose, เทสต์) ยังไม่ได้ deploy: ต้องให้ผู้ถือ timelock ทำ |
| (2) แจกจ่ายเป็นชิ้นแบบตรวจได้ + P2P | **เสร็จ**: mirror, แลกรหัสเอง และ **ค้นหา peer อัตโนมัติผ่านเชน ZETAPHY เอง** (สัญญา SignalBoard ทดสอบครบวงจรใน Chromium) ยังไม่ใช้งานจริง: ต้อง deploy SignalBoard (คำสั่งเดียว ไม่มีเจ้าของ) แล้วใส่ที่อยู่ใน `config.js` บอร์ดแบบ WebTorrent tracker ทำไว้แต่ปิดอยู่ |
| (7) แบ่งโมเดลข้ามเบราว์เซอร์ | **เสร็จสำหรับโมเดลภาษาจริง (จิ๋ว)**: โมเดลสถาปัตยกรรม Llama 0.34 ล้านพารามิเตอร์ที่ฝึกในโปรเจกต์นี้ แบ่งเป็นช่วงชั้นรันในสองเบราว์เซอร์ที่หากันเจอบนเชน **ได้โทเคนเหมือนรันเบราว์เซอร์เดียว** (ตรงทุกบิต ทุก JS engine) เล็กและช้าโดยตั้งใจ: ไม่ใช่ผู้ช่วยที่ใช้งานได้จริง โมเดลใหญ่ยังต้องใช้ WebGPU |
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

**Signaling แบบแลกรหัสเอง** เบราว์เซอร์หนึ่งสร้างรหัสข้อเสนอ (`ZP1.` ประมาณ 0.5–1 KB) อีกฝั่งวางแล้วส่งรหัสตอบกลับ
ส่งผ่านแชต อีเมล หรือ QR ได้ ไม่มีเซิร์ฟเวอร์ ยังไม่มีตัววาด QR (รหัสเป็นข้อความธรรมดา)

**Signaling อัตโนมัติ: ใช้เชน ZETAPHY เป็นจุดนัดพบ** (`ai/browser/signal.js`, `boards.js`, `discovery.js`,
`zetaphy-network/contracts/SignalBoard.sol`) ไม่มีเซิร์ฟเวอร์ของเรา ไม่มีบุคคลที่สาม ไม่ต้องแก้ CSP (RPC เป็น https อยู่แล้ว)

1. แต่ละเบราว์เซอร์สร้าง **ตัวตนชั่วคราว** ในหน่วยความจำ (WebCrypto ECDSA P-256 ไว้เซ็น, ECDH P-256 ไว้รับ) แล้วโพสต์ **announce**
   ที่เซ็นแล้วภายใต้ **topic** = `sha256("zetaphy-signal/1|<จุดประสงค์>|<hash ของ manifest>")` (`chunks` สำหรับไฟล์โมเดล,
   `stage` สำหรับช่วงชั้นของ pipeline) พร้อม `meta` สาธารณะขนาดเล็ก เช่น `{role: 'stage', from: 3, to: 6}`
2. เบราว์เซอร์ที่อยากต่อกับ peer ที่เห็น โพสต์ **offer** ถึง peer id นั้น: SDP ที่ **เข้ารหัสถึง peer นั้นเท่านั้น**
   (ECDH → HKDF-SHA256 → AES-256-GCM, header เป็น associated data) และเซ็นแล้ว peer id ที่น้อยกว่าเสนอก่อน
   (อีกฝั่งรอ 3 รอบ) ถ้าเสนอพร้อมกันจะเหลือการเชื่อมต่อเดียว
3. peer โพสต์ **answer** ที่เข้ารหัสกลับ แล้ว data channel ก็เปิด peer ได้แค่ช่องสื่อสาร: ชิ้นโมเดลยังถูกตรวจกับ hash
   ในทะเบียน และ activation ถูกตรวจโดยผู้ประสานงาน

Envelope (ไบนารี ≤ 2048 ไบต์): `"ZS" v1 | kind | topic | to (16) | expiresAt | idPub | ecdhPub | nonce | body | sig`
ลายเซ็นครอบคลุม **domain** ที่ระบุบอร์ด (chain id + ที่อยู่สัญญา หรือ URL ของ tracker) จึงเอาไปเล่นซ้ำบนบอร์ดอื่นไม่ได้
ผู้อ่านทิ้งข้อความที่หมดอายุ (เผื่อนาฬิกาคลาด 2 นาที), topic อื่น, ลายเซ็นผิด, ข้อความที่ฟิลด์ indexed บนเชนไม่ตรงกับเนื้อหา และข้อความซ้ำ

**SignalBoard** (ไม่มีเจ้าของ ไม่ถือเงิน ไม่มีค่าตั้ง เก็บแค่ตัวนับ rate): `post(topic, to, expiresAt, payload)` ปล่อย event
`Signal(topic, to, from, expiresAt, payload)`; payload 1..2048 ไบต์; `expiresAt` ใน (now, now + 600 วินาที]; ผู้ส่งหนึ่งราย
≤ 12 โพสต์ต่อ 60 วินาที เบราว์เซอร์อ่านด้วย `eth_getLogs` (150 บล็อกล่าสุดก่อน แล้วอ่านเฉพาะของใหม่)
การโพสต์ต้องจ่ายแก๊ส: หน้าเว็บสร้าง **key ชั่วคราว** (`ai/browser/evmtx.js`: secp256k1 + RFC 6979 + ธุรกรรม EIP-155 แบบ legacy
ใน JS ล้วน ตรวจไขว้กับ `@ethereumjs/tx`; ไม่ใช่ constant-time ถือแค่เหรียญจาก faucet) ขอ faucet ของ testnet (`zetaphy_faucet`
ฟรี ครั้งเดียว) เมื่อจ่ายไม่พอ และเซ็นได้แค่ `SignalBoard.post` วัดได้: announce (envelope 303 ไบต์) 56k gas, offer
(766 ไบต์ SDP ทั่วไปใน LAN) 50k gas ≈ 0.00005 ZETAPHY testnet ต่อโพสต์ที่ 1 gwei เหรียญ 10 ZETAPHY จาก faucet จ่ายได้ราว
200,000 โพสต์ การเชื่อมต่อหนึ่งครั้งใช้ 3 โพสต์ (announce, offer, answer) ประมาณ 15 วินาทีที่บล็อกละ 5 วินาที
Deploy: `KEYFILE=… node zetaphy-network/scripts/signal-board.js deploy` แล้วใส่ `signalBoard` ใน
`zetaphy-neuro/ai/browser/config.js`; `signal-board.js show --board 0x…` แสดงโพสต์ล่าสุดแยกตาม topic

**บอร์ด tracker (ทางเลือก ปิดอยู่):** `trackerBoard({url})` พูดโปรโตคอล WebSocket ของ WebTorrent tracker (ส่ง offer ให้ peer
แบบสุ่ม, ตอบด้วย `to_peer_id`) tracker แค่ส่งต่อ envelope ที่เซ็นและเข้ารหัสแบบเดียวกัน ปิดเป็นค่าเริ่มต้นเพราะ tracker
สาธารณะเป็นบุคคลที่สามที่เห็น IP และ topic ของทุก peer และ CSP วันนี้ไม่อนุญาต `wss:` ถ้าจะใช้ ต้องเพิ่ม URL `wss://` ตัวนั้น
ใน `connect-src` ของ `web/index.html` และ `vercel.json` (และของ hub ถ้าฝังไว้) และใน `trackers` ของ `config.js` เปลี่ยน tracker ได้ตามต้องการ

**ขีดจำกัด** (ตัวเลือกของ `createSwarm` / `servePeer` / `config.js`): `maxPeers` 4 (นับที่กำลังเปิดด้วย), `maxPending` 2 offer,
โพสต์ได้ 10 ครั้งต่อนาที, `offerTimeoutMs` 90 วินาทีแล้วพักก่อนเสนอใหม่, จำ peer ได้ ≤ 256, จำ hash ข้อความ ≤ 4096; อัปโหลด
**2 MiB/วินาที และ 256 MiB ต่อ peer** (`maxBytesPerSecond` / `maxBytesTotal`) ตัวโหลดเลิกถาม peer ที่ตอบผิดหรือพลาด 3 ครั้ง
แล้วถอยไปใช้ **mirror** (ตรวจแบบเดียวกัน) peer ที่ช้าหรือโกหกจึงทำให้เสียเวลาได้อย่างเดียว

**ความเป็นส่วนตัว ตามจริง:** announce เป็น **สาธารณะและถาวร** บนเชน (ที่อยู่ key ชั่วคราว, topic = โมเดลไหน, เวลา) แม้ "หมดอายุ"
แล้ว (ผู้อ่านเป็นคนบังคับวันหมดอายุ) SDP (IP) ใน offer/answer เข้ารหัสถึงผู้รับคนเดียว และ key ชั่วคราวอยู่แค่ในหน้านั้น
log เก่าจึงเปิดย้อนหลังจากฝั่งนี้ไม่ได้ แต่ **peer ที่เชื่อมต่อด้วยจะเห็น IP ของคุณ** เหมือน WebRTC ทุกแบบ ICE: ค่าเริ่มต้นไม่มี
STUN/TURN → **ใช้ได้ในเครื่องเดียวกันหรือ LAN เดียวกันเท่านั้น** ใส่ `iceServers` ใน `config.js` (STUN สาธารณะ ซึ่งเป็นบุคคลที่สาม
ที่เห็น IP ผู้ถาม) เพื่อข้าม NAT บ้านทั่วไป **NAT แบบ symmetric หรือเครือข่ายที่เข้มงวดต้องใช้ TURN ซึ่งเป็นเซิร์ฟเวอร์รีเลย์: ไม่ได้จัดให้**
key ชั่วคราวเก็บใน localStorage (จึงขอ faucet ครั้งเดียวต่อเบราว์เซอร์) ไม่แสดงให้เห็น และไม่ใช่กระเป๋าเงิน

เทสต์: `zetaphy-neuro/test/signal.test.js`, `zetaphy-network/test/signalboard.test.js`, `zetaphy-neuro/test/swarm.e2e.js`
(Chromium สองตัวหากันเจอผ่านสัญญาโดยไม่ต้องแลกรหัส แล้วรันโมเดลแบบแบ่ง)

## (7) แบ่งโมเดลภาษาข้ามเบราว์เซอร์ — `llama.js`, `tokenizer.js`, `detmath.js`, `llmload.js`, `pipeline.js`

**ตัวโมเดล** `ai/browser/llama.js` รันสถาปัตยกรรม llama2.c ของ Karpathy (MIT) ใน JS ล้วน: RMSNorm, rotary position embedding,
grouped-query attention, SwiGLU, KV cache, classifier แบบผูกกับ embedding หรือแยก; `tokenizer.js` คือ tokenizer ของ llama2.c
(`encode`/`decode` แบบเดียวกัน มี byte fallback) checkpoint แบบ legacy ของ llama2.c แปลงได้ทุกตัว (`fromLlama2c`) โมเดล
TinyStories ของ Karpathy (stories260K, stories15M, MIT) จึงรันด้วยโค้ดเดียวกัน:
`node scripts/build-llm-pack.js --model stories15M.bin --tokenizer tokenizer.bin --name stories15m --license MIT`
(ไม่ได้ใส่ใน repo: ที่ที่สร้างงานนี้เข้า huggingface.co ไม่ได้ และ stories15M ใหญ่ 58 MiB)

repo มี **`zetaphy-docs-tiny` v1** (`web/models/zetaphy-docs-tiny/1/`, 1.37 MB เป็น 21 ชิ้นละ 64 KiB, ปักไว้เป็น `PINNED_LLM`
จนกว่าจะ deploy ModelRegistry): **338,240 พารามิเตอร์** (dim 64, 6 ชั้น, 8 head / 4 KV head, FFN 172, คำศัพท์ 1024, context 256)
ฝึกจากศูนย์ในโปรเจกต์นี้ด้วย `scripts/llm/train-tiny-llama.py` (numpy อย่างเดียว เขียน backward เองพร้อม gradient check,
3000 step ละ 8 × 256 โทเคน ราว 1 ชั่วโมงบน CPU หนึ่งคอร์) จากเอกสารภาษาอังกฤษของ repo นี้เอง (ย่อหน้าร้อยแก้วจาก `*.md` 45 ไฟล์,
219k โทเคน) validation loss 3.44 nats/โทเคน (perplexity ≈ 31; training loss 2.2: overfit เพราะข้อมูลน้อย)
**มันเขียนอะไร ตามจริง:** ภาษาอังกฤษที่ฟังคล้ายเอกสารเหล่านี้แต่ไม่มีความหมาย มีไว้พิสูจน์ว่า transformer ที่ฝึกจริงรันแบบแบ่ง
ข้ามเบราว์เซอร์ได้ ไม่ใช่ไว้ตอบคำถาม ใบอนุญาตเป็นของ repo (BUSL-1.1) เพราะข้อมูลฝึกคือเอกสารของ repo

**รูปแบบไฟล์ `zllm/1`** (เรียงตามชั้น): header JSON + tokenizer + embedding + final norm (+ classifier) + ส่วนต่อเนื่องหนึ่งส่วนต่อชั้น
**peer จึงดาวน์โหลดเฉพาะชิ้นของชั้นตัวเอง** (`llmload.js`, ตัวเลือก `only` ของตัวโหลด): ในโมเดลที่ให้มา ช่วงที่รันชั้น 3–6 ดึง 10 จาก 21 ชิ้น
(รวม header) ผู้ประสานงาน (head + ชั้น 0–3) ดึง 13 ทุกชิ้นที่ดึงยังถูกตรวจกับ manifest และ manifest กับรุ่นในทะเบียน
mirror หรือ peer ที่โกหกถูกปฏิเสธเหมือนไฟล์ทั้งก้อน

**แบ่งข้ามเบราว์เซอร์** `createStage(model, {from, to})` รันช่วงชั้นพร้อม KV cache ของตัวเองต่อการสร้างข้อความหนึ่งครั้ง
(session); `serveLlmStage(channel, stage)` ให้บริการ peer หนึ่งราย (session แยกตามช่อง peer ไม่ใช้ cache ร่วมกัน ตำแหน่งต้องต่อเนื่อง
ช่วงหรือโมเดลอื่นถูกปฏิเสธ); `remoteLlmStage` คือตัวแทนฝั่งผู้ประสานงาน; `chainStages([...])` ต่อช่วงในเครื่องกับช่วงระยะไกล;
`generate()` ส่ง prompt ในข้อความเดียว (prefill) แล้วหนึ่งข้อความต่อโทเคน (greedy หรือสุ่มแบบ top-p ด้วย xorshift ที่ใส่ seed)
ผู้ประสานงานถือ embedding และชั้นผลลัพธ์ ในหน้าเว็บ (แผง AI → "ในเบราว์เซอร์นี้" → "โมเดลภาษาจิ๋ว แบ่งรันหลายเบราว์เซอร์"):
**ให้ยืมเบราว์เซอร์นี้** โหลดชั้น 3–6 แล้วประกาศเป็น `stage` บน SignalBoard; **เขียน โดยแบ่งกับอีกเบราว์เซอร์** โหลด head + ชั้น 0–3
หาเบราว์เซอร์นั้นผ่านเชน สร้างข้อความ แล้วบอกว่าโทเคนตรงกับการรันทุกชั้นที่นี่ (**เขียนในเบราว์เซอร์นี้**) หรือไม่

**ตรงทุกบิตโดยการออกแบบ** น้ำหนักและ activation เป็น float32 ทุก dot product รวมด้วย float64 ในลำดับตายตัว exp / sin / cos / pow มาจาก
`detmath.js` ที่สร้างจากการดำเนินการที่ IEEE 754 กำหนดผลแน่นอนเท่านั้น (+ − × ÷, sqrt, round) มีเทสต์ค่าบิตตายตัว
การแบ่งจึงได้ **บิตเดียวกับรันเบราว์เซอร์เดียวในทุก JS engine** (ไม่พึ่งว่า `Math.exp` ของ V8 / SpiderMonkey / JavaScriptCore เท่ากัน)
เทสต์เทียบ logits ทุก step และข้อความแบบ greedy และแบบสุ่ม สำหรับ 2 และ 3 ช่วง (GQA, MHA, classifier แยก) และใน Chromium ผ่าน WebRTC
(`test/swarm.e2e.js`) เทียบกับ **การ implement อิสระ** (numpy, float64, ไม่มี KV cache, โหมด `--reference` ของสคริปต์ฝึก)
logits ของโมเดลที่ให้มาต่างกันไม่เกิน **3.3e-6** และโทเคน greedy ตรงกัน (`test/fixtures/llm-reference.json`) ยังไม่ได้เทียบกับโค้ด C
ของ llama2.c เอง (สภาพแวดล้อมที่สร้างงานนี้ไม่อนุญาตให้รันโค้ดที่ดาวน์โหลดมา) รูปแบบไฟล์และ tokenizer ทำตาม run.c และมีเทสต์แปลงไปกลับ

**ความเร็วและขนาด ตามจริง** เบราว์เซอร์เดียว: ราว 400–500 โทเคน/วินาทีสำหรับโมเดล 0.34M นี้บน CPU หนึ่งคอร์ (ต้นทุน ≈ 2 × จำนวนพารามิเตอร์
flops ต่อโทเคน) แบบแบ่ง: ทุกโทเคนต้องไปกลับหนึ่งรอบต่อช่วงระยะไกล วัดได้ **7–11 ms ต่อรอบ** ระหว่าง Chromium สองตัวในเครื่องเดียว
(`test/swarm.e2e.js` ราว 90–150 โทเคน/วินาที) ใน LAN จริงนานกว่านี้ และข้ามอินเทอร์เน็ตเป็นหลักสิบถึงหลักร้อย ms การหากันเจอใช้ 5–6 วินาทีในเทสต์
(เชนที่ขุดบล็อกทันที) บน testnet คาดว่า 15–20 วินาที (3 โพสต์ บล็อกละ ~5 วินาที บวกรอบ polling) จึง **ช้ากว่าเบราว์เซอร์เดียวเสมอสำหรับโมเดลที่ใส่เครื่องเดียวได้**
คุ้มเฉพาะเมื่อโมเดลใหญ่เกินเครื่องเดียว stories15M (15M พารามิเตอร์, 58 MiB) น่าจะได้ราว 10 โทเคน/วินาทีต่อเบราว์เซอร์ในทาง JS ล้วนนี้
(ประเมินจาก flops ไม่ได้วัด) โมเดล 1B+ ต้องใช้ runtime WebGPU น้ำหนักแบบ quantise และ CSP ที่มี `'wasm-unsafe-eval'`: **ยังไม่ได้ทำ**

**ยังขาด:** ทนต่อ peer หลุด (ช่วงที่ออกไปทำให้การสร้างข้อความจบ ผู้ประสานงานยังไม่ย้ายเส้นทาง), การพิสูจน์ว่าช่วงระยะไกลคำนวณถูก
(ผู้ประสานงานคำนวณซ้ำได้เฉพาะเมื่อถือชั้นนั้นเอง หรือใช้อีกช่วงเป็นสำเนา), การรวมโทเคนของหลายผู้ใช้ในรอบเดียว และผู้ประสานงานที่หา
หลายช่วงสำหรับแบ่ง 3 ทางขึ้นไปเอง (โค้ดรองรับกี่ช่วงก็ได้ หน้าเว็บต่อไว้สองช่วง)

ต้นแบบแบบ batch บน MLP ของเล่น (`toymodel.js`, `createPipeline` / `serveStage`, micro-batch แบบ GPipe, สุ่มตรวจ) ยังอยู่เหมือนเดิม (`test/browserai.e2e.js`)

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

สิ่งที่โมเดลที่แจกจับได้ (`nml-3ab3cd303911` แทน `nml-b4c35477f7b1`; ชุดทดสอบสังเคราะห์ 390 แถว และ red team รอบใหม่ที่ไม่เคยใช้ฝึก
รายละเอียดใน `zetaphy-neuro/ml/README.th.md`):

| | ก่อน | หลัง |
|---|---:|---:|
| AUC / recall ที่เตือนผิด 1% | 0.9975 / 0.950 | 1.000 / 1.000 |
| ความคลาดของความน่าจะเป็น (ECE) / Brier | 0.026 / 0.020 | 0.010 / 0.002 |
| หลอกลวงที่แสดง medium+ (โทเคนปกติที่ medium+) | 95.0% (22.8%) | 99.5% (22.8%) |
| red team รอบใหม่ จับได้ seed B / C | 84% / 83% | 97% / 97% |
| กลุ่มหลอกลวงที่ไม่เคยเห็น (ตัดออกทีละกลุ่ม) สัดส่วนเตือนต่ำสุด | 0.62 (mint แฝง) | 0.71 (blacklist) |
| ขนาดแพ็ก | 87 KB, 6 ชิ้น | 75 KB, 5 ชิ้น |

ของใหม่: ฟีเจอร์ตามเส้นทางของแต่ละฟังก์ชัน (`ml/flow.js`: ใครเรียกได้ ย้ายหรือสร้างเหรียญไหม มีเพดานตายตัวไหม `transfer()` ขึ้นกับอะไร)
การตรวจตายตัวสามข้อที่ยกระดับเองได้ (`ml/checks.js`: เจ้าของย้าย/สร้างเหรียญได้ไม่จำกัด, ตั้งค่าธรรมเนียมเท่าไรก็ได้, ซ่อนตัวหลัง `owner() = 0`)
และ "สัญญาณที่แรงที่สุด" ในแผงแสดงเฉพาะสิ่งที่ดันความเสี่ยงขึ้นเป็นภาษาคน ตัวเลขเป็นข้อมูลสังเคราะห์ จึงดูดีเกินจริงสำหรับสัญญาจริง

นี่คือโมเดล **ในเบราว์เซอร์** คะแนนบนเชน (`NeuroScore`) และวงจร zk ยังใช้โมเดลก่อนหน้า `nml-b4c35477f7b1` จนกว่าจะจัดพิธี zk
สาธารณะครั้งใหม่ (`onchain-ml.th.md`) โทเคนเดียวกันจึงอาจแสดงระดับที่นี่ต่างจากบนเชน

เทสต์: `zetaphy-neuro/test/browserai.test.js`, `test/browserai.e2e.js`, `zetaphy-network/test/modelregistry.test.js`
