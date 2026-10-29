# AI agent บน ZETAPHY: ตัวตน, intent, ป้าย, รั้วกั้น, ผู้ร่วมเซ็น (testnet)

[English](agents.md)

ห้าส่วน ทั้งหมด **testnet เท่านั้น ไม่มีเงินจริง** สัญญาอยู่ใน `zetaphy-network/contracts/`
โค้ดของ runner/solver อยู่ใน `zetaphy-network/src/` และหน้าเว็บหนึ่งหน้าใน hub (แท็บ **Agent**,
`zetaphy-hub/agents.js`, 8 ภาษา) ยังไม่ได้ deploy: hub อ่านที่อยู่จาก `hub-config.json`
(`contracts.intentExecutor`, `labelRegistry`, `agentRegistry`, `agentPolicyWallet`) หรือให้ผู้ใช้พิมพ์เอง

| # | หัวข้อ | สถานะ | ไฟล์ |
|---|------|--------|-------|
| 23 | ตัวตนและความรับผิดของ agent | **เสร็จ (ต้นแบบ)** | `AgentRegistry.sol` (+ `ConstitutionChecker`), `test/agents.test.js` |
| 24 | Proof of Intent | **เสร็จ (ต้นแบบ)** การแปลภาษาธรรมชาติเป็นเพียงคำแนะนำโดยตั้งใจ | `IntentExecutor.sol`, `zetaphy-hub/intent-core.js`, `src/intent.js`, หน้า Agent ใน hub |
| 25 | ป้ายคน/agent | **เสร็จ (ต้นแบบ)** "คน" ≠ คนเดียวไม่ซ้ำ | `WebAuthnVerifier.sol`, `HumanAgentLabels.sol` |
| 9 | รั้วกั้นกระเป๋าที่ AI ใช้ | **เสร็จ (ต้นแบบ)** | `AgentPolicyWallet.sol` |
| 14 | AI ผู้ร่วมเซ็น | **เสร็จ (ต้นแบบ)** เป็น k-of-n ECDSA ไม่ใช่ threshold crypto | `CosignCommittee`, `src/cosign.js`, `zetaphy cosign` |

ไม่ได้แก้ patch ของ node (`zetaphy-chain/setup-node.sh`) ใช้สิ่งที่เชนมีอยู่แล้ว:
- **precompile ML-DSA `0x…0900`** (FIPS 204)
- **precompile P-256 `0x…0100`** ของ cosmos/evm (อินเทอร์เฟซ RIP-7212) ซึ่งเปิดอยู่แล้วใน
  `active_static_precompiles` ดังนั้น passkey ถูกตรวจ **บนเชน** ได้เลย

การทดสอบใช้ EVM ในหน่วยความจำ ซึ่งตอนนี้รับ precompile ที่เขียนด้วย JS ได้: ตัวตรวจ ML-DSA-44 **จริง**
(`@noble/post-quantum` รูปแบบ input เดียวกับเชน) ที่ `0x…0900` และตัวตรวจ P-256 ที่ `0x…0100` พร้อม
"authenticator" ทดสอบที่สร้าง assertion ของ WebAuthn แบบเดียวกับเบราว์เซอร์ จึงเซ็นด้วยกุญแจจริงทั้งคู่

## 23. ตัวตนและความรับผิดของ agent — `AgentRegistry`

`register(account, pqKeyHash, constitution, checker)` พร้อมเงินประกันอย่างน้อย `minBond` ผู้เรียกเป็น
**ผู้ดูแล (operator)** ที่รับผิดชอบ agent: บัญชี EVM ที่ agent ใช้, hash ของกุญแจ **ML-DSA-44**,
hash ของเอกสารนโยบาย (constitution) และสัญญาตรวจนโยบาย (ถ้ามี)

- `recordAction` บันทึกการกระทำพร้อม `modelHash`, `promptHash` เซ็นด้วยกุญแจ ML-DSA-44 ของ agent
  (ตรวจด้วย precompile, มีลำดับกันเล่นซ้ำ) และจำ constitution ณ เวลานั้นไว้
- **คำร้องแบบกำหนดได้แน่นอน**: `claimByChecker` แสดงเอกสาร constitution ตัวตรวจบอกว่าผิดหรือไม่ ใครเสียหาย
  และเท่าไร แล้วจ่ายจากเงินประกันทันที (`ConstitutionChecker` เป็นตัวอย่างที่ใช้งานได้)
- **คำร้องแบบคณะกรรมการ**: `fileClaim` พร้อมเงินมัดจำ คณะกรรมการที่ governance ตั้งลงคะแนน
  ถึงเกณฑ์ "ใช่" จ่ายผู้ร้อง ถึงเกณฑ์ "ไม่" หรือไม่ตัดสินใน 7 วัน ปฏิเสธและมัดจำไปที่ผู้ดูแล
- ร้องได้ภายใน 30 วันหลังการกระทำ ถอนประกันได้หลังขอ 7 วันและไม่มีคำร้องค้าง

**ข้อจำกัด**: ตัวตรวจเลือกโดยผู้ดูแล การบันทึกเป็นแบบสมัครใจ (ควรใช้คู่กับ `AgentPolicyWallet`)
`modelHash`/`promptHash` เป็นคำยืนยัน ไม่ใช่หลักฐานว่าโมเดลนั้นสร้างผลจริง (zkML/TEE ยังเป็นงานวิจัย)

## 24. Proof of Intent

ผู้ใช้เซ็น **สิ่งที่ต้องการ** (EIP-712 `Intent`: ส่ง/แลก/stake, จ่ายไม่เกิน `maxIn`, ผู้รับได้อย่างน้อย
`minOut`, ผู้รับ, รายการสัญญาที่อนุญาต, nonce, deadline) แบบ ECDSA หรือ **ML-DSA-44** (`setPqKey`)
solver ใดก็ได้ส่ง `execute` สัญญาจะรันคำสั่ง แล้ว **วัดยอดคงเหลือ**: ผู้ใช้เสียไม่เกิน `maxIn`
ผู้รับได้อย่างน้อย `minOut` executor ไม่เก็บอะไรไว้ เรียกได้เฉพาะสัญญาในรายการ ห้ามเรียกตัว token
ห้าม `transferFrom`/`approve`/`permit` ไม่เช่นนั้นยกเลิกทั้งหมด ทดสอบกับ DEX จริงของ ZETAPHY

- ตัวแปลงเป็นธุรกรรม (`src/intent.js`, `zetaphy intent show|compile|execute`) เป็นโค้ดที่แน่นอน ไม่ใช่โมเดล
- **ภาษาธรรมชาติ → intent** ในหน้า Agent: **โมเดลของผู้ใช้เอง** ผ่านชั้น AI ของ Neuro (คีย์ของตัวเอง
  ส่งจากเบราว์เซอร์ไปผู้ให้บริการเท่านั้น) ร่าง JSON ตาม schema ตายตัว ข้อความผู้ใช้ถูกล้อมเป็น "ข้อมูล"
  ระบบเก็บเฉพาะสิ่งที่ตรวจได้ (token ในรายการ, จำนวนที่แปลงได้, ขั้นต่ำที่ระบุชัด) แล้ว **แสดงให้ตรวจทุกช่อง**
  ก่อนกด "อนุญาต executor" และ "เซ็น intent" หน้าเว็บไม่เซ็นหรือส่งเอง

**ข้อจำกัด**: ไม่มีตลาด solver หรือ relay (ไม่มีเซิร์ฟเวอร์ตลอดเวลา) ERC-20 เท่านั้น หนึ่ง token เข้าหนึ่งออก
hub เซ็นแบบ ECDSA เท่านั้น แบบ PQ ใช้ผ่าน CLI/SDK

## 25. ป้ายคนหรือ agent — `LabelRegistry`

`labelOf` → 0 ไม่มี, 1 **คน**, 2 **agent** (อ่านสดจาก `AgentRegistry` และชนะป้ายคน)
- **คน บนเชน**: `proveHumanP256` passkey เซ็น challenge ของบัญชี ตรวจ type, challenge, rpIdHash,
  ธง user-present และ **user-verified** และลายเซ็น P-256 ผ่าน **precompile `0x…0100`**
- **คน ผ่านผู้รับรอง**: runner ที่ governance อนุมัติตรวจ WebAuthn นอกเชน แล้วเซ็น EIP-712 `HumanAttestation`
- **Hook**: `LabelFaucet` (จำนวนต่อป้าย, cooldown ต่อบัญชีและต่อ passkey) และ `LabelSwapGate` (วงเงินต่อชั่วโมงต่อป้าย)
- หน้า Agent: ดูป้าย และปุ่ม "ยืนยันว่าเป็นคน (passkey)"

**ข้อจำกัด**: ป้ายคนบอกแค่ว่ามีคนใช้อุปกรณ์ **ไม่ได้พิสูจน์ว่าคนหนึ่งมีบัญชีเดียว** (สร้าง passkey ได้หลายอัน)
faucet ของ node ยังไม่อ่านป้าย (ต้องแก้ patch ของเชน ซึ่งอยู่นอกขอบเขต) DEX ไม่ได้ถูกแก้

## 9. รั้วกั้นกระเป๋าที่ AI ใช้ — `AgentPolicyWallet`

เจ้าของถือเงินและนโยบาย agent ทำได้แค่ในกรอบ: วงเงินต่อรอบต่อ token, รายการผู้รับและสัญญาที่อนุญาต,
ห้าม `transferFrom`/`increaseAllowance`/`setApprovalForAll`/`permit`, เกินเกณฑ์ต้อง **รอ timelock**
(เจ้าของยกเลิกได้) หรือมี **ลายเซ็นร่วมของ runner** และ **แช่แข็งฉุกเฉิน** ได้ด้วยบัญชีเจ้าของ,
**passkey** ของเจ้าของ หรือกุญแจ **ML-DSA-44** ของเจ้าของ (สองอย่างหลังใครส่งแทนก็ได้) ปลดได้เฉพาะเจ้าของ
ทุกการกระทำบันทึก `modelHash`, `promptHash` หน้า Agent แสดงสถานะ ตั้ง passkey ฉุกเฉิน และแช่แข็งด้วย passkey

**ข้อจำกัด**: วงเงินนับเป็นจำนวน token ไม่ใช่ราคา ถอดรหัสเฉพาะ `transfer`/`approve` สัญญาอื่นในรายการต้องเชื่อถือได้

## 14. AI ผู้ร่วมเซ็น — `CosignCommittee` + `src/cosign.js`

คณะกรรมการ runner (k-of-n) ที่ **governance ตั้ง** runner ใช้ `zetaphy cosign review` อ่านสิ่งที่การกระทำแตะ
ด้วยกฎตายตัวของ Neuro (โค้ดเดียวกับ NeuroJobs ไม่ได้แก้ `zetaphy-neuro/src/`) ปฏิเสธถ้าระดับ **high**
(หรือ **medium** เมื่อ `--strict`) ไม่เช่นนั้นเซ็น digest ที่ผูกเชน กระเป๋า nonce ปลายทาง จำนวน calldata
`reportHash` และ deadline แล้ว `zetaphy cosign combine` เรียงลายเซ็นให้ `executeCosigned`

**ข้อจำกัด**: เป็นลายเซ็น ECDSA แยก k อัน ไม่ใช่ threshold crypto และไม่ใช่ PQ คณะกรรมการยังไม่มีเงินประกัน/รางวัล
กฎของ Neuro ตัดสินสัญญา ไม่ใช่เจตนา จึงยังต้องมีวงเงินและรายการอนุญาต

## การทดสอบ

- `zetaphy-network`: `npm test` (ใหม่: agents 9, intents 11, labels 8, policywallet 7, agentscli 2)
- `zetaphy-hub`: `npm test` (ใหม่: agents.test.mjs 8) และ `npm run test:e2e` (ใหม่: agents.e2e.mjs บน Chromium)

## สิ่งที่ยังเหลือ

deploy บน testnet, การเซ็น typed data แบบ PQ ในกระเป๋า PQ, relay ของ solver ที่ไม่ต้องมีเซิร์ฟเวอร์,
เงินประกัน/รางวัลของคณะกรรมการ, factory ของกระเป๋า, faucet ของ node อ่านป้าย (ต้องแก้ patch),
การพิสูจน์ว่าเป็นคนไม่ซ้ำ ทำไม่ได้ด้วย passkey อย่างเดียว
