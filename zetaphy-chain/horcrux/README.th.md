# Horcrux สำหรับ validator ของ ZETAPHY (ทางเลือก, testnet)

[English](README.md)

[Horcrux](https://github.com/strangelove-ventures/horcrux) แบ่ง **กุญแจเซ็น ed25519** ของ validator
(`priv_validator_key.json`) ออกเป็น 3 ส่วน (shard) ไว้บนเครื่องเล็ก 3 เครื่อง (cosigner) เครื่องไหนก็ได้ 2 ใน 3
เครื่องเซ็นร่วมกัน ไม่มีเครื่องใดถือกุญแจทั้งดอกอีกต่อไป รวมถึงตัว node เอง `setup-horcrux.sh` ตั้งค่าให้บนเครื่องฟรี

## ใช้กับ ZETAPHY ได้ไหม? ได้ สำหรับกุญแจ ed25519 โดยมีข้อจำกัดด้านล่าง

ตรวจจากการอ่านโค้ด (ตุลาคม 2026) **ยังไม่ได้ลองครบทุกขั้นบน devnet ของ ZETAPHY** ขั้นตอนของสคริปต์ทดสอบกับตัวแทน
(`zetaphy-network/test/horcrux.test.js`) ให้ลองกับ validator สำรองก่อน

1. **อะไรเซ็นที่ไหน** ZETAPHY คือ cosmos/evm v0.7.3 บน CometBFT v0.39.3 (Cosmos SDK v0.54.3) CometBFT เซ็น proposal,
   prevote, precommit ด้วย ed25519 ผ่าน PrivValidator และตั้งแต่ v0.38 ยังเซ็น *vote extension* ของ precommit
   ที่ไม่ว่างด้วยกุญแจเดียวกัน PrivValidator นี้เป็นตัวเซ็นระยะไกลได้ (`priv_validator_laddr` ใน `config.toml`)
   ซึ่งเป็นจุดที่ Horcrux เสียบเข้ามา
2. **ส่วนต้านควอนตัมอยู่บน node และไม่ถูกกระทบ** แพตช์ของ ZETAPHY (ใน `setup-node.sh`: `evmd/zetaphy_pqguard.go`,
   `evmd/zetaphy_pqcert.go`) เซ็น `(chain id, ความสูงบล็อก, hash ของบล็อก)` ด้วย ML-DSA-44 ภายในแอปพลิเคชัน:
   ใน ABCI `ExtendVote` (ลายเซ็นนี้ *คือ* vote extension) และใน `PrepareProposal` สำหรับรายการของผู้เสนอบล็อกเอง
   (`pqOwnEntry`) ทั้งสองอ่าน `config/pq_vote_key.seed` บน node ไม่มีส่วนไหนผ่าน PrivValidator ดังนั้น Horcrux
   ไม่เห็นและไม่ต้องใช้กุญแจ ML-DSA ใบรับรอง finality (`MsgPQCertificate`) สร้างจาก vote extension แบบ ML-DSA
   และตรวจกับกุญแจสาธารณะ ML-DSA ที่ลงทะเบียนไว้ Horcrux แค่เซ็น ed25519 ทับไบต์ของ extension นั้นเหมือนที่ไฟล์กุญแจเคยทำ
   **ตัวเซ็นระยะไกลจึงไม่ทำให้ใบรับรอง PQ เสีย**
3. **โปรโตคอลตรงกัน** Horcrux v3.3.2 (รุ่นล่าสุด 7 มีนาคม 2025) สร้างบน CometBFT v0.38.2 และเซ็นแบบ threshold
   ให้ vote extension ด้วย (`signer/threshold_validator.go`) โปรโตคอลตัวเซ็นระยะไกลของ CometBFT v0.39.3
   (`proto/tendermint/privval/types.proto`) และข้อความ `Vote`, `CanonicalVote`, `CanonicalVoteExtension`
   ที่ใช้เซ็นเหมือนกับ v0.38.2 (เทียบแล้ว ต่างแค่การจัดรูปแบบ) จึงคุยกันได้
4. **ทำไมปลอดภัยกับ extension ของ ZETAPHY** เมื่อถูกขอซ้ำที่ความสูง รอบ และขั้นเดิม ด้วยไบต์ของโหวตเดิม (node รีสตาร์ต
   หรือมี sentry ตัวที่สอง) Horcrux คืนลายเซ็นที่ทำไว้ครั้งแรก รวมลายเซ็นของ extension โดยไม่เทียบตัว extension
   ซึ่งถูกต้องก็ต่อเมื่อบล็อกเดียวกันให้ extension เดิมเสมอ และเป็นเช่นนั้น: การเซ็น ML-DSA ของ ZETAPHY เป็นแบบ
   deterministic (`circl` `SignTo(..., randomized=false)`) ต้องคงไว้แบบนี้
5. **ไฟล์กุญแจยังสำคัญอยู่นิดหนึ่ง** นอกจากการเซ็น node ยังอ่าน `priv_validator_key.json` เพื่อเอา *address*
   ของ consensus (`pqConsAddr`): `ExtendVote` ใช้เลือก seed ที่ตรงกับกุญแจ ML-DSA ที่ลงทะเบียน (`pq_vote_key.seed`
   หรือ `.seed.old` ระหว่างลงทะเบียนกุญแจใหม่) และ `zetaphyd tx pq-vote-key` ใส่ address นี้ในการลงทะเบียน
   และตอน node เริ่ม (`cosmos/evm` `server/start.go`) จะโหลดไฟล์นี้เสมอ ถ้าไม่มีก็สร้างกุญแจสุ่มใหม่ขึ้นมา
   `switch` จึงแทนไฟล์ด้วย **ไฟล์แทน (stand-in)**: กุญแจส่วนตัวใหม่ที่ไม่ถูกใช้เลย แต่ใส่ address ของ validator
   ในช่อง `address` ระหว่างที่ตั้ง `priv_validator_laddr` ไว้ CometBFT ไม่เซ็นอะไรด้วยกุญแจนี้ ส่วนโค้ด ML-DSA และ
   `pq-vote-key` อ่าน address ที่ถูกต้อง (ถ้าแค่ลบไฟล์ทิ้ง โหวตยังเซ็นด้วย `pq_vote_key.seed` ได้ แต่การเปลี่ยนกุญแจโหวต
   ภายหลังจะเซ็น address ผิดและถูกปฏิเสธ)

## ป้องกันอะไรได้ และอะไรไม่ได้

| | เมื่อใช้ Horcrux |
|---|---|
| กุญแจเซ็น ed25519 | แบ่ง 2 ใน 3; cosigner ถูกขโมยหรือดับไป 1 เครื่องไม่มีผล |
| การเซ็นซ้ำ (double signing) | cosigner ตกลงกันเอง (Raft) และเก็บสถานะการเซ็น ไม่เซ็นต่ำกว่าความสูงที่ `switch` ให้ |
| กุญแจโหวต ML-DSA-44 (`pq_vote_key.seed`) | **ยังอยู่บน node** เหมือนเดิม |
| บัญชี stake (keyring) | **ยังอยู่บน node** (จ่ายค่าธรรมเนียม unjail และ staking) |

คนที่ได้ root บน node ยังเซ็นโหวต ML-DSA และใช้บัญชี stake ได้ แต่เซ็นโหวต ed25519 ไม่ได้ถ้าไม่มี cosigner 2 เครื่อง
และเชนต้องมีทั้งสองลายเซ็นบนโหวต node เครื่องเดียวจึงเซ็นแทน validator ไม่ได้อีกต่อไป node ต้องติดต่อ cosigner ได้
2 ใน 3 จึงจะเซ็นได้ แต่ละโหวตเพิ่มการรับส่งข้อมูลไปกลับไม่กี่รอบ (ไม่มีปัญหาในภูมิภาคเดียวกัน บล็อกห่างกันราว 5 วินาที)

## ข้อจำกัด

- สลับ **หลังจาก** node เป็น validator และลงทะเบียนกุญแจโหวต ML-DSA แล้วเท่านั้น (`zetaphy-validator status`)
  การเป็น validator ใช้ `zetaphyd comet show-validator` ซึ่งหลังสลับจะแสดงกุญแจสาธารณะของไฟล์แทน ส่วน
  `horcrux address zetaphy_77390-1 zetaphy` บน cosigner แสดงตัวจริง
- มี sentry node ตัวเดียว (ตัว validator node เอง) ถ้ามีหลายตัว ทุกตัวต้องมี `pq_vote_key.seed` เดียวกัน ซึ่งสคริปต์ไม่ได้ตั้งให้
- Horcrux ออกรุ่นล่าสุดเมื่อมีนาคม 2025 ก่อนใช้ให้ดูว่ามีรุ่นใหม่กว่าไหม แล้วปักหมุดใหม่ที่นี่ (เวอร์ชันและ SHA-256 ทั้งสอง
  จากไฟล์ `horcrux_sha256.txt` ของรุ่นนั้น)
- testnet เท่านั้น เหมือนทุกอย่างที่นี่ ถ้าจะใช้กับเงินจริงต้องมีการทดสอบบน devnet ใน CI ก่อน

## เครื่อง (ฟรี)

Oracle Cloud Always Free ในบัญชีเดียว: VM.Standard.A1.Flex (Arm รวม 4 OCPU และ 24 GB แบ่งได้ตามใจ) และ
VM.Standard.E2.1.Micro 2 เครื่อง (AMD, 1 GB)

| เครื่อง | ขนาด |
|---|---|
| validator node (มีอยู่แล้ว) | A1, 1-2 OCPU, 6-12 GB |
| cosigner 1 | E2.1.Micro |
| cosigner 2 | E2.1.Micro |
| cosigner 3 | A1, 1 OCPU, 6 GB |

boot volume 4 ก้อน ก้อนละราว 47 GB อยู่ในโควตาฟรี 200 GB ให้ทั้งสี่เครื่องอยู่ใน **VCN เดียวกัน** และใช้ **IP ภายใน**
(10.0.0.x) เป็น `COSIGNERS` และ `NODE_ADDR`: ข้อมูลระหว่าง cosigner ไม่ออกนอกเครือข่ายของ Oracle และไม่ต้องเปิดพอร์ต
สู่อินเทอร์เน็ต ใน security list ของ subnet ให้อนุญาตเฉพาะจาก IP ภายในเหล่านั้น: TCP 2222 ระหว่าง cosigner และ TCP 1234
จาก cosigner ไปยัง node สคริปต์เปิดพอร์ตเหล่านี้ใน firewall ของแต่ละเครื่องให้ด้วย (image Ubuntu ของ Oracle ปฏิเสธที่เหลือทั้งหมด)

ข้อแลกเปลี่ยนที่ต้องรู้: cosigner ทั้งสามในบัญชี Oracle เดียวจะเสียพร้อมกันถ้าบัญชีถูกยึด (รหัสผ่าน, API key)
Horcrux ป้องกันกรณีเครื่องหนึ่งถูกเจาะ ไม่ใช่กรณีบัญชีถูกยึด ใช้รหัสผ่านที่แข็งแรงและเปิด MFA ในบัญชี Oracle
ใช้ Google e2-micro เป็น cosigner ได้ แต่ cosigner ส่งข้อความกันทุกโหวต ซึ่งตอนนั้นจะวิ่งผ่านอินเทอร์เน็ต และโควตาฟรีคือ
ข้อมูลขาออก 1 GB ต่อเดือน (ยังไม่ได้วัด น่าจะเกิน) ใช้ Oracle ดีกว่า

## ขั้นตอน

ทุกคำสั่งรันบนเครื่องที่ระบุ ในหน้าต่าง SSH บนเบราว์เซอร์หรือ Oracle Cloud Shell ไม่ใช่บนคอมพิวเตอร์ของคุณเอง
ดาวน์โหลดสคริปต์ลงทุกเครื่อง:

```bash
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/zetaphy-chain/horcrux/setup-horcrux.sh -o setup-horcrux.sh
```

0. **สำรอง** `priv_validator_key.json` แบบออฟไลน์ก่อน (`sudo zetaphy-validator backup`) ขั้น switch จะทำลายไฟล์นี้
   บน node ไฟล์สำรองนั้นเป็นทางเดียวที่จะกลับไปใช้ไฟล์กุญแจเดียว
1. **Node:** `sudo COSIGNERS="10.0.0.11 10.0.0.12 10.0.0.13" NODE_ADDR=10.0.0.10 bash setup-horcrux.sh shard`
   ติดตั้ง Horcrux (ปักหมุดเวอร์ชัน ตรวจ SHA-256) สร้าง shard 3 ส่วน กุญแจเข้ารหัสของ cosigner และ bundle
   ของแต่ละ cosigner ไว้ใน `/root/zetaphy-horcrux` (อ่านได้เฉพาะ root)
2. **สำหรับ N = 1, 2, 3:** บน node `sudo bash setup-horcrux.sh bundle N` คัดลอกตั้งแต่ `BEGIN` ถึง `END`
   บน cosigner N `sudo bash setup-horcrux.sh cosigner N` แล้ววาง สคริปต์รับเฉพาะ bundle N ติดตั้ง Horcrux และ service
   `horcrux` (ยังไม่เริ่ม) และแสดงค่าตรวจสอบที่ต้องตรงกับฝั่ง node shard เดียวเซ็นไม่ได้ แต่ให้ดูแลเหมือนกุญแจ:
   ห้ามวางลงแชตหรือเก็บเป็นไฟล์บนคอมพิวเตอร์ของคุณ
3. **Node:** `sudo bash setup-horcrux.sh switch` หยุด node และบอกความสูงที่ต้องเริ่ม (สูงกว่าความสูงสุดท้ายที่กุญแจเคยเซ็น 1)
4. **ทุก cosigner:** `sudo bash setup-horcrux.sh start ความสูง` ด้วยความสูงนั้น เมื่อ 2 หรือ 3 เครื่องขึ้นว่า
   `horcrux started` ให้พิมพ์ `started` บน node สคริปต์ใส่ไฟล์แทนกุญแจ ตั้ง `priv_validator_laddr = "tcp://0.0.0.0:1234"`
   เปิดพอร์ต 1234 ให้เฉพาะ cosigner เริ่ม node และเสนอให้ทำลาย bundle ทิ้ง
5. **ตรวจ:** `sudo zetaphy-validator status` (ความสูงเพิ่มขึ้น validator ยัง BONDED ไม่ถูก jail) และบน cosigner
   `journalctl -u horcrux -f`

**กลับไปใช้ไฟล์กุญแจเดียว:** หยุด Horcrux บน cosigner **ทุกเครื่อง** (`sudo systemctl disable --now horcrux`) วางไฟล์สำรอง
ออฟไลน์ไว้ที่ `/root/priv_validator_key.json` บน node แล้ว `sudo bash setup-horcrux.sh rollback` สคริปต์ตรวจ address
ตั้งให้ node เริ่มเซ็นที่สูงกว่าบล็อกล่าสุด 2 (ไม่เซ็นความสูงที่ cosigner อาจเซ็นไปแล้ว) ล้าง `priv_validator_laddr`
แล้วรีสตาร์ต จากนั้นทำลาย shard บน cosigner ทิ้ง
