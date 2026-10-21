# ZETAPHY: ความปลอดภัยในแกนกลางของเชน (security core)

เอกสารนี้อธิบายกติกาความปลอดภัย 3 อย่างที่อยู่ในตัวเชนเอง (ไม่ใช่แค่ในกระเป๋าหรือสัญญา) ว่าเปลี่ยนอะไรสำหรับผู้ใช้
และ validator และมีอะไรป้องกันไม่ให้กติกาเหล่านี้กลายเป็นเครื่องมือเซ็นเซอร์

| | ทำอะไร | ใครเปิด | ค่าเริ่มต้น |
|---|---|---|---|
| **Q-day** | ตั้งแต่ความสูงที่โหวตไว้ เชนไม่รับธุรกรรมที่เซ็นด้วย ECDSA (กุญแจแบบ MetaMask) | การโหวต governance | ปิด (ยังไม่กำหนดวัน) |
| **Threat gate** | ธุรกรรมที่เรียกสัญญาที่ Neuro ติดธง "บังคับใช้" ต้องได้ความยินยอมจากเจ้าของบัญชีก่อน | การโหวต governance | ปิด |
| **IBC hold** | การโอนเข้าผ่าน IBC ที่ใหญ่เกินเกณฑ์ ถูกพักไว้ช่วงหนึ่งก่อนเข้าบัญชี | การโหวต governance | ปิด (ไม่มีเกณฑ์) |

ทั้งสามอย่าง **ปิดอยู่จนกว่าจะมีการโหวต** ทุกการตั้งค่าเป็น proposal สาธารณะ (`gov.sh`) และดูค่าที่ใช้อยู่ได้ตลอด:
`gov.sh security` หรือ JSON-RPC `zetaphy_securityStatus` หรือ `zetaphy security status`

---

## 1. Q-day: เตรียมย้ายบัญชีไปลายเซ็นต้านควอนตัม

**Q-day คืออะไร** — วันที่เครือข่ายเลิกเชื่อลายเซ็น ECDSA (secp256k1) เพราะคอมพิวเตอร์ควอนตัมที่ใหญ่พอจะปลอม
ลายเซ็นของกุญแจที่เคยเปิดเผย public key ได้ governance เป็นผู้กำหนดความสูงบล็อก (`gov.sh qday <ความสูง>`)
ล่วงหน้า ก่อนถึงวันนั้นทุกอย่างทำงานเหมือนเดิม

**ตั้งแต่ Q-day:**
- ธุรกรรม Ethereum ทุกแบบ (MetaMask, Rabby ฯลฯ ซึ่งเซ็นด้วย ECDSA เสมอ) ถูกปฏิเสธตั้งแต่ตอนส่ง
- ธุรกรรม Cosmos ผ่านได้เฉพาะเมื่อผู้เซ็นทุกคนเป็นกุญแจ ML-DSA-44 (หรือ multisig ที่มีแต่ ML-DSA-44)
- ลายเซ็น ECDSA ที่สัญญาตรวจเอง (`ecrecover`: permit, meta-transaction และ P-256 ผ่าน precompile `0x…0100`: passkey) ไม่มีผลอีก
- บัญชี ECDSA ที่ **ยังไม่ย้าย** ถูกแช่แข็ง: เงินยังอยู่ที่เดิม ไม่มีใครย้ายได้ (รวมถึงผู้ที่ปลอมลายเซ็นได้) governance
  อาจเพิ่มวิธีกู้คืนภายหลังได้ด้วยการโหวต
- สิทธิ์ที่ให้ไว้ก่อน Q-day (allowance ของ ERC-20, authz, fee grant) ยังใช้ได้ เพราะให้ไว้ตอนลายเซ็นยังเชื่อถือได้
  ควรยกเลิก allowance ที่ไม่ใช้แล้วก่อน Q-day

### สิ่งที่ผู้ใช้ควรทำ (ก่อน Q-day)
1. สร้างบัญชี ML-DSA-44 ในกระเป๋า ZETAPHY (หน้าเว็บ `zetaphy-wallet` หรือ ZETAPHY Snap ใน MetaMask) แล้วส่ง
   ธุรกรรมสักครั้ง (ให้เชนรู้ public key)
2. ในการ์ด **"ล็อกบัญชี MetaMask ให้กระเป๋านี้"** ล็อกบัญชี MetaMask เดิมให้บัญชี ML-DSA-44 นั้น (ล็อกควอนตัม,
   ถาวร) — ที่อยู่ 0x ยอดเงิน โทเคน stake และสิทธิ์ในสัญญาอยู่ที่เดิม แต่จากนี้สั่งผ่านบัญชี ML-DSA-44 เท่านั้น
   ซึ่งยังใช้งานได้หลัง Q-day
3. กดปุ่ม **"เตรียมพร้อมสำหรับ Q-day → ตรวจบัญชี MetaMask ของฉัน"** เพื่อดูสถานะ: ย้ายแล้ว / กำลังย้าย /
   ยังไม่ย้าย (และกุญแจเคยถูกใช้บนเชนหรือไม่)

บน CLI: `zetaphy security migration <ที่อยู่>` และ `zetaphy pq native lock-ecdsa --yes`

### ถ้าไม่ทันก่อน Q-day: ย้ายแบบ commit–reveal (เฉพาะกุญแจที่ไม่เคยใช้บนเชน)
บัญชีที่ **ไม่เคยส่งธุรกรรมและไม่เคยมีลายเซ็นถูกตรวจบนเชน** (เช่น กระเป๋าที่รับเงินอย่างเดียว) ยังย้ายได้หลัง Q-day:
1. กระเป๋า MetaMask เซ็นข้อความย้ายบัญชี **ในเครื่องเท่านั้น** (ไม่ส่งธุรกรรม)
2. บัญชี ML-DSA-44 ใหม่บันทึก **commitment** (ค่า hash ที่ไม่เปิดเผยอะไรเกี่ยวกับกุญแจเดิม) — ทำได้ตั้งแต่ก่อน Q-day
3. รออย่างน้อย `reveal_delay` บล็อก (governance ตั้ง ค่าเริ่มต้น 720 บล็อก) แล้ว **reveal** หลัง Q-day
4. รออีก `reveal_delay` บล็อก บัญชีเดิมจึงเป็นของบัญชี ML-DSA-44 (เหมือนล็อกควอนตัม)

การรอสองช่วงนี้ทำให้คนที่เห็นข้อมูลตอน reveal แล้วพยายามแซงหน้า ทำไม่ได้: commitment ที่สร้างหลังเห็นข้อมูลยังใหม่เกิน
ไป และระหว่างช่วงรอ commitment ที่เก่ากว่าเป็นผู้ชนะ **ทำ commit ทันทีที่ประกาศ Q-day จะปลอดภัยที่สุด**
บัญชีที่กุญแจเคยถูกใช้บนเชนแล้ว ใช้ทางนี้ไม่ได้ — ต้องล็อกก่อน Q-day

ในกระเป๋า: การ์ด "เตรียมพร้อมสำหรับ Q-day" มีปุ่ม "ขั้นที่ 1" และ "ขั้นที่ 2" (MetaMask จะขอเซ็นข้อความ ไม่ใช่ธุรกรรม)
CLI: `zetaphy security qday-commit` แล้ว `zetaphy security qday-reveal`

### validator
- คะแนนโหวตบล็อกมีลายเซ็น ML-DSA อยู่แล้ว (ขั้น 5) แต่ **บัญชี operator** ที่เป็น ECDSA จะส่งธุรกรรมไม่ได้หลัง Q-day
  — ล็อกควอนตัมบัญชี operator ก่อน แล้วจัดการ validator ผ่าน `MsgEVMCall as_owner` (precompile staking,
  distribution, slashing, gov) และ `MsgPQVoteKey` ช่อง `validator_owner`
- relayer IBC (Hermes) และ faucet ของ testnet เซ็นด้วย ECDSA จึงส่งธุรกรรมไม่ได้หลัง Q-day เช่นกัน
  — IBC จะหยุดจนกว่าจะมี relayer ที่เซ็นด้วย ML-DSA-44 (ยังไม่มี) จึงยังไม่ควรตั้ง Q-day บนเชนที่ใช้ IBC จริง
- governance ควรกำหนด Q-day เมื่อ validator ส่วนใหญ่ล็อกบัญชีแล้วเท่านั้น ไม่อย่างนั้นการโหวตหลัง Q-day จะทำไม่ได้
  (`gov.sh qday` ไม่ยอมตั้งความสูงที่ใกล้เกินไป)

---

## 2. Threat gate: ความยินยอม ไม่ใช่การเซ็นเซอร์

Neuro runners ติดธงสัญญาจาก **ข้อเท็จจริงของโค้ด** ที่ทดสอบซ้ำได้ (เช่น ซื้อได้แต่ขายไม่ได้ในการจำลอง) ลงใน
`ThreatRegistry` เมื่อ governance เปิด threat gate (`gov.sh threat-gate <ThreatRegistry> on`) เชนจะ:
- ปฏิเสธธุรกรรม EVM (และ `MsgEVMCall`) ที่ปลายทาง (`to`) มีธง **บังคับใช้แล้ว** พร้อมข้อความบอกเหตุผล
- **เว้นแต่** เจ้าของบัญชีให้ความยินยอมก่อน: ธุรกรรมเดียว `consent(ปลายทาง, วินาที)` ไปที่ precompile
  `0x0000000000000000000000000000000000000901` (ส่งจาก MetaMask ได้ตรง ๆ) ใช้ได้นานสุด 1 วัน ยกเลิกได้ด้วย 0 วินาที

ในกระเป๋า: การ์ด **"ยินยอมเรียกสัญญาที่ติดธง"** (ส่งจากกระเป๋า ML-DSA-44 หรือจาก MetaMask) และ ZETAPHY Snap
แสดงคำเตือนระดับวิกฤตพร้อมเหตุผล หลักฐาน คำชี้แจงของเจ้าของสัญญา และวิธียินยอม CLI: `zetaphy security consent <0x…> <วินาที>`

**สิ่งที่ป้องกันการใช้ในทางที่ผิด**
- นับเฉพาะธง **บังคับใช้** (ผ่าน enforceDelay หรือ fast lane) ธงเตือนและธงที่พักไว้ไม่ทำให้ถูกปฏิเสธ
- key ที่ governance ป้องกันไว้ (สัญญาของโปรโตคอลเอง เช่น bridge) ติดธงไม่ได้ จึงไม่มีทางทำให้การถอนเงินจากสัญญา
  ของโปรโตคอลค้าง และธงที่ถูกล้าง (โหวตล้าง หรืออุทธรณ์ชนะ) หยุดการปฏิเสธทันที
- ทุกคนไปต่อได้เสมอด้วยความยินยอมของตัวเอง ไม่มีใครปิดกั้นบัญชีใดได้ถาวร
- ที่อยู่ระบบ (precompile) และตัว registry เอง (การอุทธรณ์ คำชี้แจง) ไม่ถูกตรวจ การเรียกของ governance ไม่ถูกตรวจ
- ถ้า registry ใช้งานไม่ได้ เชนถือว่า "ไม่มีธง": เชนและธุรกรรมของผู้ใช้ไม่ค้างเพราะ registry
- ค่าใช้จ่ายจำกัด: เรียก view ของ registry ครั้งเดียวต่อธุรกรรม เพดานแก๊สคงที่ ผลเหมือนกันทุกโหนด

**ข้อจำกัด** — ด่านนี้เป็นการขอความยินยอม ไม่ได้รับประกันว่าจะกันความเสียหายได้ทุกกรณี กระเป๋า ZETAPHY และ Snap
ตรวจเพิ่มเติมก่อนเซ็นอยู่แล้ว ใช้วิจารณญาณเสมอ

---

## 3. IBC hold: พักการโอนเข้าก้อนใหญ่

governance ตั้งเกณฑ์ต่อเหรียญ (`gov.sh ibc-hold-rule <denom|*> <จำนวนขั้นต่ำ> <bps ของ supply>`) และช่วงพัก
กับ guardian (`gov.sh ibc-hold <วินาที> [guardian]` ค่าเริ่มต้น 6 ชั่วโมง) การโอนเข้าที่ถึงเกณฑ์:
- ถูกรับไว้ (ไม่หมดเวลาฝั่งต้นทาง) แต่ **ยังไม่เข้าบัญชีผู้รับ** ระหว่างพัก ดูรายการได้ที่ `gov.sh ibc-holds`,
  JSON-RPC `zetaphy_ibcHolds`, `zetaphy security ibc-holds` และ event `zetaphy_ibc_hold`
- ครบเวลา เชนส่งต่อให้ผู้รับเอง (ผ่าน rate limit และกติกาอื่นตามปกติ ณ ตอนนั้น)
- ระหว่างพัก guardian (เช่น multisig) หรือ governance **คืนเงินให้ผู้ส่ง** ได้ (`gov.sh ibc-hold-cancel <id>`
  หรือ `cancelIBCHold(id)` ที่ precompile 0x…0901 สำหรับ multisig แบบสัญญา) เชนต้นทางคืนเงินผ่านกลไก IBC ปกติ
  — guardian เปลี่ยนผู้รับหรือยึดเงินไม่ได้
- การโอนผ่าน IBC v2 ที่ถึงเกณฑ์ถูกปฏิเสธทันที (เงินคืนต้นทาง) ให้ใช้ channel IBC แบบปกติ (v1)
- x/ratelimit (เพดานต่อช่วงเวลา) ยังทำงานเหมือนเดิม ใช้คู่กัน

การโอนออก และการโอนที่ต่ำกว่าเกณฑ์ ไม่เปลี่ยน

**EVM bridge (BridgeGuard / BridgeAirlock):** กติกา "เฉพาะ minter ที่ลงทะเบียน" ยังอยู่ที่ระดับสัญญา ไม่ได้ย้ายมาอยู่ในเชน
เพราะเชนบังคับแบบสะอาดไม่ได้ (การ mint เกิดภายในโค้ดของสัญญา) เหรียญ IBC ที่เป็น ERC-20 ถูกสร้างโดยโมดูล IBC เท่านั้นอยู่แล้ว

---

## การอัปเกรด

- เชนใหม่ (genesis ใหม่): เปิดใช้ตั้งแต่บล็อก 1 (`app_state.zetaphypq` key `0f` = 1, `setup-node.sh` ใส่ให้) แต่ทุกกติกาปิดจนโหวต
- เชนที่รันอยู่แล้ว: `gov.sh propose-upgrade zetaphy-v3 <ความสูง H> "<สรุป>"` แล้วโหวต ทุก validator เปลี่ยน binary ที่ H
  ตั้งแต่ H+1 precompile 0x…0901 และกติกาใหม่จึงมีผล (handler ตั้ง v2 ให้ด้วยถ้ายังไม่เปิด) บล็อกก่อนหน้ารันเหมือนเดิม
- ค่าทั้งหมดอยู่ใน `app_state.zetaphypq` และติดไปกับ genesis export

## สำหรับนักพัฒนา

| | |
|---|---|
| ข้อความ | `/zetaphy.pq.v1.MsgSetQDay`, `MsgQDayCommit`, `MsgQDayReveal`, `MsgSetThreatGate`, `MsgSetIBCHold`, `MsgSetIBCHoldRule`, `MsgIBCHoldCancel` |
| precompile 0x…0901 | `consent(address,uint64)`, `consentUntil(address,address)`, `threatGate()`, `qday()`, `migration(address)`, `cancelIBCHold(uint64)`, event `Consent` |
| JSON-RPC | `zetaphy_securityStatus`, `zetaphy_migration`, `zetaphy_qdayCommitment`, `zetaphy_consent`, `zetaphy_ibcHolds` |
| event | `zetaphy_qday`, `zetaphy_qday_commit`, `zetaphy_qday_reveal`, `zetaphy_qday_migrated`, `zetaphy_threat_gate`, `zetaphy_consent`, `zetaphy_ibc_hold`, `zetaphy_ibc_hold_released`, `zetaphy_ibc_hold_cancelled`, `zetaphy_ibc_hold_stuck` |
| error | codespace `zetaphy`: 20 = Q-day, 21 = threat gate |
| JS | `zetaphy-network/src/pqtx.js` (`qdayRevealText`, `qdayCommitment`, `consentCall`, `msgQDay*`, `pqClient().securityStatus/migration/qdayCommit/qdayReveal/consent/ibcHolds`) |
| ทดสอบ | `zetaphy-chain/fork-tests/evmd/zetaphy_security_test.go`, `fork-tests/evmd/tests/ibc/zetaphy_ibchold_test.go`, `zetaphy-network/test/devnet.security.integration.js`, `zetaphy-chain/ibc/test-ibc.sh` |

รายละเอียดด้านความปลอดภัยเก็บแยกไว้สำหรับทีม
