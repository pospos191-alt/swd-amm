# ระบบตรวจสอบ (audit) อัตโนมัติของเราเอง

English: [README.md](README.md)

ระบบนี้ตรวจสัญญาอัจฉริยะ (Solidity) และโค้ดเชน (Go) ของเราโดยอัตโนมัติ ด้วยเครื่องมือฟรีโอเพนซอร์สและสคริปต์ที่เราเขียนเอง
ทำงานแบบเดียวกับขั้นตอน "เครื่องตรวจ" ที่บริษัท audit ใช้ก่อนให้คนอ่านโค้ด ได้แก่ static analysis, การพิสูจน์เชิงรูปนัย (formal check),
fuzzing, mutation testing และการตรวจ dependency แล้วรวมผลเป็นรายงานเดียว ทุกสิ่งที่พบมีรหัสประจำตัวที่คงที่ และทุกการตัดสินของคนถูกบันทึกไว้

**นี่ไม่ใช่การ audit อิสระ และใช้แทนไม่ได้** ระบบนี้หาบั๊กตามรูปแบบที่รู้จักและกันไม่ให้กลับมาอีก แต่ไม่เข้าใจว่าสัญญาของเรา "ควร" ทำอะไร
ก่อนใช้ mainnet กับเงินจริง ยังต้องมีการ audit อิสระตาม SECURITY.md ดูหัวข้อ [ข้อจำกัด](#ข้อจำกัด)

รายงานล่าสุด: [REPORT.md](REPORT.md) (สรุปภาษาไทย: [REPORT.th.md](REPORT.th.md))

## ระดับการตรวจ (tier)

| | ระดับเร็ว (fast) | ระดับละเอียด (deep) |
|---|---|---|
| เมื่อไร | ทุก PR ที่แก้สัญญา, patch ของเชน, lockfile, `*/audit/` หรือ `audit/` | ทุกวันอาทิตย์ 02:37 UTC และกดรันเองได้ (Actions → audit → Run workflow) |
| เวลา | ไม่เกิน 15 นาที | ประมาณ 1.5–2.5 ชม. (งบ `normal`) สูงสุด 6 ชม. (งบ `long`) |
| Slither, Aderyn, Semgrep | ✓ | ✓ |
| SMTChecker ของ solc | engine BMC, สัญญาหลัก 4 ตัว ตัวละ 5 นาที | engine CHC, สัญญาหลักทั้ง 11 ตัว ตัวละ 15 นาที |
| ชุด invariant (`*/audit/invariants/`) | forge แบบสั้น (smoke) | forge เต็ม, halmos, medusa, echidna |
| Mutation testing | – | สัญญาหลัก 5 ตัว ตัวละ 15 mutant |
| Neuro อ่าน bytecode ของเราเอง | ✓ | ✓ |
| โค้ด Go ของเชน | gosec + `go test -race` เฉพาะเมื่อ `zetaphy-chain/` เปลี่ยน | + staticcheck + govulncheck |
| npm audit (dependency ที่ใช้จริง) + OSV-Scanner | ✓ | ✓ |
| ทำให้ check ไม่ผ่าน | เมื่อพบระดับ High/Critical **ใหม่** ที่ยังไม่ได้ตัดสินใน `triage.yml` | ไม่ทำให้ล้ม แต่เปิด/อัปเดต PR จาก branch `audit/report` |

สิ่งที่มีอยู่แล้วในที่อื่นและไม่ทำซ้ำ: CodeQL ตรวจเว็บแอป JS/TS, `security.yml` รันเทสต์ Go ของเชน fuzzing และ gosec ทุกครั้งที่เชนเปลี่ยน
รวมทั้ง cargo audit, `zetaphy-chain-upstream.yml` รัน govulncheck รายสัปดาห์

## ตรวจอะไรบ้าง

ดู [`scope.json`](scope.json): Solidity ใน `zetaphy-network/contracts`, `zetaphy-dex/contracts` (รวม `dlmm/`) และ `zetaphy-nft/contracts`
คอมไพล์ด้วย solc 0.8.26 และค่าเดียวกับ build ของแต่ละโปรเจกต์ ไฟล์ทดสอบ, mock, เหรียญ faucet ของ testnet และสัญญาที่ตั้งใจให้มีช่องโหว่
(สำหรับ bug bounty) ถูกตัดออกพร้อมเหตุผล ส่วนโค้ดเชน: patch ใน `zetaphy-chain/setup-node.sh` ถูกนำไปลงบน Cosmos EVM เวอร์ชันที่ปักไว้
แบบเดียวกับ CI และเซิร์ฟเวอร์ แล้วรายงานเฉพาะบรรทัดที่ **patch ของเราเพิ่มเข้าไป**

## วิธีรันเอง

```sh
bash audit/tools/install.sh ~/.audit-tools fast   # ติดตั้งเครื่องมือ (ตรวจ SHA-256 / hash ของ pip)
export PATH=~/.audit-tools/bin:~/.audit-tools/venv/bin:$PATH LD_LIBRARY_PATH=... SEMGREP_RULES=...
bash audit/run.sh --tier fast                      # ได้ audit/out/raw/ และ audit/REPORT.md
node --test audit/test/*.test.js                   # เทสต์ของระบบเอง
```

ตรวจโปรเจกต์ Solidity อื่น: `audit/run.sh --target <โฟลเดอร์> --tier fast --out <โฟลเดอร์ผลลัพธ์>`
ผลแบบเครื่องอ่าน: `node audit/report.js --json <out>` พิมพ์ JSON หนึ่งก้อน (commit, codeHashes, findings, invariants, mutationScore)

## วางชุด invariant ไว้ที่ไหน

`zetaphy-network/audit/invariants/`, `zetaphy-dex/audit/invariants/`, `zetaphy-nft/audit/invariants/`
- มี `foundry.toml` → `forge test` (ฟังก์ชัน `invariant_*` และ `test*`) และในรอบ deep `halmos` พิสูจน์ฟังก์ชัน `check_*` (`foundry.toml` อาจเป็นของแพ็กเกจเอง สองระดับขึ้นไป: `<package>/foundry.toml` ที่มี `test = "audit/invariants"` แล้ว forge รันจากรากของแพ็กเกจ; ค่า `offline = true` ใช้ solc 0.8.26 ที่ `tools/install.sh` วางไว้ที่ `~/.svm/0.8.26/solc-0.8.26` หลังตรวจ SHA-256)
- มี `medusa.json` → medusa (รอบ deep)
- มี `echidna.yaml` → echidna กับทุกสัญญาที่ชื่อมีคำว่า `Echidna` (รอบ deep)

ถ้ายังไม่มีโฟลเดอร์หรือไฟล์ตั้งค่า นับเป็น "ยังไม่ได้รัน" ไม่ใช่ "ผ่าน" คุณสมบัติที่ไม่ผ่านนับเป็นระดับ **High**

## วิธีอ่านรายงาน

1. **สรุป**: จำนวนตามระดับความรุนแรง "เปิดอยู่และใหม่" = ยังไม่อยู่ใน baseline
2. **ขอบเขต**: commit, ไฟล์และจำนวนบรรทัดที่ตรวจ, สิ่งที่ตัดออกและเหตุผล
3. **วิธีการ**: เครื่องมือแต่ละตัว รันหรือไม่ ใช้เวลาเท่าไร เวอร์ชันอะไร
4. **สิ่งที่พบ**: Critical/High แสดงเต็ม (รหัส, ตำแหน่ง, บรรทัดที่ถูกชี้, เครื่องมือ, สถานะ) Medium เป็นตาราง Low/Info จัดกลุ่มตามกฎ
5. **Formal check**: สิ่งที่ SMTChecker พิสูจน์ได้ หาเจอ หรือทำไม่ทัน
6. **Coverage**: ผล invariant, คะแนน mutation และ mutant ที่ไม่มีเทสต์จับได้ (แต่ละตัวคือเทสต์ที่ควรเขียนเพิ่ม)
7. **Neuro อ่านสัญญาของเรา**: ผู้ใช้จะเห็นอะไรเมื่อดูสัญญาของเราด้วยสแกนเนอร์ของเราเอง
8. **Code hash**: keccak-256 ของ runtime bytecode เทียบกับ `EXTCODEHASH` ของสัญญาที่ deploy จริงได้
9. **สิ่งที่รายงานนี้พิสูจน์ไม่ได้** (ระบุวันที่)

## ระดับความรุนแรง

| ระดับ | ความหมาย |
|---|---|
| **Critical (วิกฤต)** | เงินถูกขโมยหรือถูกล็อกได้ทันที โดยใครก็ได้ |
| **High (สูง)** | มีทางนำไปสู่การสูญเงินได้จริง หรือการรับประกันหลักถูกทำลาย (เช่น reentrancy ในการจ่ายเงิน, invariant ไม่ผ่าน) |
| **Medium (กลาง)** | สูญเงินได้ในบางเงื่อนไข หรือการรับประกันอ่อนลง |
| **Low (ต่ำ)** | แนวปฏิบัติที่ดี / ป้องกันเชิงลึก |
| **Info (ข้อมูล)** | รูปแบบโค้ด, gas, หมายเหตุ |

การแปลงระดับของแต่ละเครื่องมือมาเป็นสเกลนี้อยู่ใน [`lib/findings.js`](lib/findings.js) (เช่น ตัวตรวจ Slither ที่ผลกระทบสูงแต่ความมั่นใจต่ำ → Medium)

## การตัดสิน (triage)

ทุกสิ่งที่พบมีรหัส `tool:rule:file:hash` โดย hash คำนวณจากข้อความของบรรทัดที่ถูกชี้ โค้ดเลื่อนบรรทัดได้โดยรหัสไม่เปลี่ยน แต่ถ้าแก้บรรทัดนั้นรหัสจะเปลี่ยน

**มีแต่คนเท่านั้นที่แก้ [`triage.yml`](triage.yml)** ระบบอ่านอย่างเดียว ไม่เคยใส่สถานะเอง แต่ละรายการต้องมี:
`id`, `status` (`fixed` = แก้แล้ว / `false-positive` = เครื่องมือเข้าใจผิด / `accepted-risk` = รู้และยอมรับความเสี่ยง),
`reason` (เหตุผลที่ตรวจสอบได้ ชี้ไปที่โค้ดจริง), `decided_by` (ใครตัดสิน), `date`

ขั้นตอน: (1) อ่านสิ่งที่พบและโค้ดรอบ ๆ (2) ถ้าจริง แก้ใน PR แยก (3) ถ้าไม่จริงหรือยอมรับ เพิ่มรายการใน PR ให้อีกคน (หรือเจ้าของ) ตรวจ
(4) รายการที่ไม่ตรงกับสิ่งที่พบแล้วจะถูกแสดงในรายงาน ให้ลบออก (ยกเว้นรายการ `fixed` ซึ่งเก็บไว้เป็นบันทึกการแก้ รายงานแสดงในหัวข้อ "Fixed (no longer detected)")

**ใน GitHub code scanning (SARIF):** สิ่งที่พบที่ยังเปิดอยู่ระดับ Medium ขึ้นไปเป็น alert ตามระดับ ส่วนที่ตัดสินแล้ว (false-positive, accepted-risk รวมถึงที่รอเจ้าของยืนยัน) ถูกส่งไปพร้อม `suppressions` (kind `external`, status `accepted`, justification = สถานะ เหตุผล และผู้ตัดสิน) code scanning จึงแสดงเป็น "ปิดพร้อมเหตุผล" ไม่ใช่ alert ใหม่ ลบรายการเมื่อไรก็กลับมาเป็น alert ในการอัปโหลดครั้งถัดไป รายการ `fixed` ที่เครื่องมือยังพบอยู่เป็น alert อีกครั้ง

**Semgrep `basic-arithmetic-underflow`:** ชี้ทุก `a - b` ที่มีพารามิเตอร์ไหลเข้า แต่ Solidity >= 0.8 นอกบล็อก `unchecked { }` จะ revert ไม่ใช่วนค่า รายงานจึงลดเป็น **Info** (ไม่ขึ้นใน code scanning) เมื่อ pragma ของไฟล์บังคับ solc >= 0.8 และบรรทัดอยู่นอก `unchecked` ทุกบล็อก ถ้าอยู่ใน `unchecked` หรือไฟล์ยอมให้ solc < 0.8 ยังคงเป็น Medium และเป็น alert ตามเดิม (ไม่ได้ปิดกฎนี้)
`triage.yml` เริ่มต้นมีเฉพาะ false positive ที่ตรวจโดยอ่านโค้ดจริงในการรันครั้งแรก พร้อมเหตุผลทุกข้อ เจ้าของควรตรวจยืนยัน

**รอเจ้าของยืนยัน:** รายการที่ `decided_by` มีคำว่า "owner to confirm" (หรือมี `pending: true`) เป็นการตัดสินชั่วคราวของผู้รีวิวที่อ่านโค้ดแล้ว มีผลเหมือนการตัดสินที่ยืนยันแล้วทุกที่ที่มีผล (ด่านตรวจ PR, `--json`, SARIF) แต่ทุกที่ที่แสดงจะติดป้าย **PENDING OWNER CONFIRMATION** (คอลัมน์แยกในสรุปของ REPORT, บรรทัดสถานะ, สรุปภาษาไทย และ `::warning::` ของด่านตรวจ) เจ้าของยืนยันโดยใส่ชื่อตัวเองใน `decided_by` หรือปฏิเสธโดยลบรายการ

**Baseline** ([`baseline.json`](baseline.json)): รายการ High/Critical ที่ยังเปิดอยู่และมีคนเห็นแล้วในรายงานที่ผ่านการรีวิว ด่าน PR จะล้มเฉพาะเมื่อพบ
High/Critical ที่ไม่อยู่ทั้งใน triage และ baseline — ของเก่าไม่ขวางงานอื่น ของใหม่เล็ดลอดไม่ได้ baseline **ไม่ใช่** การตัดสิน รายการเหล่านั้นยังแสดงเป็น
"เปิดอยู่" ในทุกรายงานจนกว่าจะมีการตัดสินใน `triage.yml`

**PR รายสัปดาห์**: รอบ deep จะ push `audit/REPORT.md`, `REPORT.th.md` และ `baseline.json` ไปที่ branch `audit/report` (branch เดียวนี้เท่านั้น)
แล้วเปิด/อัปเดต PR ให้คนรีวิวและ merge ต้องเปิด Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"

## ข้อจำกัด

- ไม่พบปัญหา ≠ ปลอดภัย เครื่องมือรู้จักรูปแบบ ไม่รู้เจตนาของเรา บั๊กเชิงตรรกะและเศรษฐศาสตร์ (การตั้งราคา, แรงจูงใจ, flash loan, ปั่น oracle, MEV, ยึด governance) ต้องใช้คน
- SMTChecker พิสูจน์ได้เฉพาะที่รายงานว่าพิสูจน์แล้ว ภายในเวลาที่กำหนด
- fuzzing/invariant ตรวจเฉพาะคุณสมบัติที่มีคนเขียนไว้
- mutation testing สุ่มตัวอย่างเพียงไม่กี่สิบ mutant ต่อสัญญา
- ไม่ได้วัด line coverage ของเทสต์ `node --test` (รันบน EVM ในโปรเซสที่เครื่องมือ coverage วัดไม่ได้) ใช้คะแนน mutation แทน
- ไม่ครอบคลุมการ deploy และการดูแลระบบ: กุญแจ, multisig/timelock ที่ใช้จริง, ค่าที่ใส่ตอน deploy, หน้าเว็บ, RPC
- วิเคราะห์เฉพาะ patch ของเรา ไม่ได้วิเคราะห์ Cosmos EVM / CometBFT / ibc-go เอง
- เครื่องมือเองก็มีบั๊กและจุดบอด
