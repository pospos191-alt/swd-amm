# อะไรเปิดได้ อะไรต้องซ่อน (ZETAPHY)

หลักการ: **ระบบต้องปลอดภัยแม้คนร้ายรู้วิธีทำงานทั้งหมด** (หลัก Kerckhoffs)
ของที่ซ่อนได้จริงมีแค่ "กุญแจ" กับ "ข้อมูลที่มีค่าเพราะยังไม่มีใครรู้" ส่วนวิธีทำงานของเชนและสัญญาต้องเปิด
เพราะ bytecode บนเชนอ่านได้อยู่แล้ว validator ทุกรายต้องได้โปรแกรมไปรัน และ auditor / bug bounty ต้องอ่านโค้ดได้

## 1. เปิดเผยได้ (ตั้งใจให้เปิด)

| อะไร | ทำไมเปิดแล้วยังปลอดภัย |
|---|---|
| โค้ดเชน (patch Cosmos EVM), สัญญาทั้งหมด, เว็บ, กระเป๋า, Snap | ความปลอดภัยมาจากกุญแจ ลายเซ็น ML-DSA และเงินค้ำ ไม่ใช่ความลับของโค้ด |
| กติกา Neuro ที่ runner โหวต (skill ใน `zetaphy-neuro/src`) | runner ทุกคนต้องรันโค้ดชุดเดียวกันจึงตรวจซ้ำได้ (skill id = hash ของไฟล์) |
| ลอตเตอรีเลือกผู้ตัดสิน | ใช้ blockhash หลังคำขอ รู้กติกาแต่เดาล่วงหน้าไม่ได้ |
| เพดานสะพาน, timelock, quarantine, เกณฑ์ช่องทางอิสระ | อยู่บนเชนอยู่แล้ว และออกแบบให้ "รู้แล้วก็ยังเจาะไม่ได้" |
| ที่อยู่สัญญา (launch state) | อยู่บนเชนอยู่แล้ว |

## 2. ต้องซ่อน และเก็บไว้ที่ไหน

| อะไร | เก็บที่ | ใครเห็น |
|---|---|---|
| กุญแจ deploy | GitHub Secret `ZETAPHY_DEPLOYER_KEY` | ไม่มีใครอ่านกลับได้ (workflow ซ่อนใน log, ลบไฟล์หลังใช้) |
| กุญแจ validator (`priv_validator_key.json`, `pq_vote_key.seed`) | บนเครื่องโหนดเท่านั้น + สำรองออฟไลน์ | เจ้าของเครื่อง |
| กุญแจ faucet / relayer | บนเครื่องโหนด (สร้างบนเครื่อง ไม่เคยพิมพ์ออก) | เจ้าของเครื่อง |
| เจ้าของ multisig (guardian / governance) | กระเป๋าฮาร์ดแวร์ของแต่ละคน | แต่ละคน |
| กุญแจ marker ของตัวเฝ้าสะพาน | GitHub Secret `BRIDGE_MARKER_KEY` | ไม่มีใคร (สิทธิ์ต่ำ: ทำเครื่องหมายได้อย่างเดียว ขยับเงินไม่ได้) |
| รายชื่อสัญญาที่เฝ้า (watch list) | GitHub Secret `BRIDGE_WATCHLIST` | ไม่มีใคร (รายงาน/issue/log ไม่แสดงที่อยู่เหล่านี้) |
| เกณฑ์แจ้งเตือนจริงของสะพาน | GitHub Secret `BRIDGE_MONITOR_THRESHOLDS` (ไฟล์ใน repo เป็นค่าเริ่มต้น) | ไม่มีใคร |
| การแจ้งเตือนสด | Telegram / Discord ส่วนตัว หรือ issue ใน repo private | ทีม |
| กฎ Neuro ใหม่ช่วงพัก (embargo) | repo private `zetaphy-private/rules/pack.json` → เซิร์ฟเวอร์ Neuro อ่านด้วย token อ่านอย่างเดียว | ทีม (ผู้ใช้เห็นแค่ผลเตือน ไม่เห็นกฎ) |
| ช่องโหว่ที่ยังไม่ได้แก้ | GitHub Private vulnerability reporting / Security advisory (draft) | ทีม จนกว่าจะแก้และประกาศ |
| token บริการ (Vercel, Upstash, `NEURO_RULES_TOKEN`) | ตัวแปรลับของ Vercel / GitHub | ไม่มีใคร |

## 3. ข้อจำกัดที่ต้องรู้ (บอกตรง ๆ)

- **ทุกอย่างบนเชนเป็นสาธารณะ** สัญญาที่ deploy แล้วถูกอ่าน bytecode / storage ได้เสมอ การซ่อนทำได้แค่ "ไม่มีป้ายบอก" ไม่ใช่ล่องหน
- **ปลายทาง early warning ของ Neuro ถูกลองถามซ้ำ ๆ ได้** (คนร้ายแก้โค้ดแล้วถามจนไม่ขึ้นเตือน) การจำกัดอัตราแค่ทำให้ช้าลง และผลเตือนเป็นคำแนะนำ ไม่ใช่คำตัดสินบนเชน
- **IP ของ validator** ตอนนี้ประกาศที่ `/zetaphy/peer` (จำเป็นให้เครื่องอื่นเข้าร่วม) ก่อน mainnet ต้องใช้ sentry node ซ่อน validator ตัวจริง
- **สัญญาที่เฝ้าดูลับได้แค่จนถูกใช้ครั้งแรก** การทำเครื่องหมาย (`Tripped`) อยู่บนเชน ใครย้อนดูธุรกรรมของคนที่ถูกมาร์กก็หาสัญญาเจอ ถือว่าเปิดเผยแล้วหลังโดนครั้งแรก
- **RPC ที่ตัวเฝ้าใช้มองเห็นรายการเฝ้า** (อยู่ในคำขอ `eth_getLogs`) ให้ใช้โหนดของเราเอง ไม่ใช่ RPC ของคนอื่น และถ้า URL ของ RPC มี API key ให้เก็บเป็น Secret ไม่ใช่ Variable
- **การมาร์กไม่ได้เกิดทันที** ต้องตั้ง quarantine ให้นานกว่ารอบของตัวเฝ้า + ความล่าช้าของ GitHub (แนะนำ ≥ 2 ชม. กับรอบ 15 นาที) เมื่อมีเงินจริงควรรันตัวเฝ้าบนเครื่องของเราด้วย
- **กุญแจ marker ถูกทำให้เปลืองแก๊สได้** (คนเรียกสัญญาที่เฝ้าจากหลายที่อยู่) ให้เติมแก๊สและดูการแจ้ง `mark-failed`
- **faucet** จำกัดต่อวันทั้งระบบ คนเดียวใช้หลายที่อยู่กวาดโควต้าวันนั้นได้ (ไม่เสียเงินจริง แค่คนใหม่ต้องรอวันถัดไป)

## 4. ก่อนเปลี่ยน repo เป็น Public (เช็กลิสต์)

ผลสแกนความลับทั้งประวัติ (21 ต.ค. 2026, gitleaks + สแกนเฉพาะคริปโต): **ไม่พบกุญแจหรือ token** ที่เจอเป็นค่าทดสอบสาธารณะ / ชื่อฟีเจอร์
อีเมลผู้เขียน commit จะมองเห็นได้ (ปิดสำหรับ commit ใหม่: GitHub → Settings → Emails → Keep my email addresses private)

หลังกด **Settings → Danger Zone → Change visibility → Public** ให้ตั้งต่อ (ฟรีทั้งหมด):
1. **Settings → Code security**: เปิด **Private vulnerability reporting**, **Secret scanning** + **Push protection**, **Dependabot alerts**
2. **Settings → Actions → General**: Fork pull request workflows → **Require approval for all external contributors**; Workflow permissions → **Read repository contents** (ค่าเริ่มต้นแบบอ่านอย่างเดียว)
3. **Settings → Branches → Add rule** สำหรับ `main`: Require a pull request + Require status checks (CI)
4. เปิดตารางเวลา bridge-monitor ได้ฟรีเมื่อมีสะพานจริง (`*/15`)

## 5. รอบดูแล

- หลังมีการเฝ้าสัญญาใดถูกเรียก: เปลี่ยนรายการใน `BRIDGE_WATCHLIST` (ตัวที่ถูกเรียกแล้วถือว่าเปิดเผยแล้ว)
- กฎ Neuro ที่ครบกำหนดพัก: workflow ใน `zetaphy-private` เปิด issue ให้ย้ายมา repo สาธารณะ แล้วโหวต skill ใหม่
- เปลี่ยน `BRIDGE_MARKER_KEY` และ token ต่าง ๆ ทุก 6 เดือน หรือทันทีที่สงสัยว่าหลุด
  - เปลี่ยน marker: governance โหวต `setMarker(ใหม่, true)` แล้ว `setMarker(เก่า, false)`
  - เปลี่ยน watch list / marker key / thresholds แล้ว ตัวเฝ้าจะเริ่มความจำใหม่ (state เข้ารหัสด้วยค่าเหล่านี้) แต่ไม่ต้องสแกนบล็อกเก่าซ้ำ
- หลัง governance `untrip` ใครสักคนต้องเรียก `release` เองสำหรับรายการที่ค้างไว้
