[English](specs-and-proofs.md) | **ภาษาไทย**

# สเปกและการพิสูจน์: เครื่องร่างสเปก คนอนุมัติ เครื่องพิสูจน์ (testnet)

ใช้บน testnet เท่านั้น (ZETAPHY testnet, chain 77390) ไม่มีส่วนไหนถือหรือจ่ายเงินจริง และยังไม่มีบริษัทภายนอกตรวจ (audit)
เอกสารนี้เป็นส่วนหนึ่งของ "SS tier" ใน[เครือข่ายตรวจสอบแบบเปิด](audit-network.th.md):

- **SS6** *AI ร่างสเปก เครื่องพิสูจน์*: `audit/spec/` อ่านสัญญา Solidity แล้วร่างคุณสมบัติ (property) แบบเป็นทางการ
  ผู้ตรวจอนุมัติ แล้วเครื่องมือแปลงสเปกที่อนุมัติแล้วเป็นการทดสอบเชิงสัญลักษณ์ของ Halmos เป้าหมายของ solc SMTChecker
  และ invariant test ของ forge จากนั้นรันด้วยเครื่องมือเวอร์ชันที่ตรึงไว้
- **A3** ระดับ **Proven**: `ProofRegistry` บันทึกต่อ code hash ว่าสเปกที่อนุมัติคืออะไร ไฟล์หลักฐาน (artifact) อะไร
  เครื่องมือเวอร์ชันไหน และสูตรทำซ้ำ (recipe) หลักฐานจะนับก็ต่อเมื่อผู้รัน (runner) ที่วางเงินค้ำ 2 ใน 3 คนทำซ้ำแล้วได้ "ทุกคุณสมบัติพิสูจน์แล้ว"
  ใบรับรองระดับ **Gold** ที่ยังใช้ได้และโค้ดถูกพิสูจน์แล้ว จะแสดงเป็น **Proven**
- **S9** **ตลาดหลักฐาน**: โปรโตคอลตั้งรางวัล (bounty) ให้กับชุดคุณสมบัติ ผู้พิสูจน์รับรางวัลได้ด้วยหลักฐาน
  (ตรวจรับแบบข้างบน) หรือด้วยตัวอย่างค้าน (counterexample) ที่เล่นซ้ำบนเชนแล้วยืนยันได้

| ส่วน | อยู่ที่ |
|---|---|
| CLI: `draft`, `approve`, `gen`, `prove`, `hash`, `outcome` | `audit/spec/cli.js` |
| แบบจำลองจาก AST ของ solc 0.8.26: การเขียน storage, การเช็กผู้เรียก, การเรียกออกภายนอก, lock, pause | `audit/spec/lib/analyze.js` |
| ฮิวริสติกที่ให้ผลเหมือนเดิมทุกครั้ง (ไม่ใช้ AI) | `audit/spec/lib/heuristics.js` |
| ขั้น LLM แบบเลือกได้ (เฉพาะเมื่อมี `ANTHROPIC_API_KEY` และสั่ง `--llm`) ตอบเป็น JSON ตามรูปแบบที่กำหนด และผ่านตัวกรอง | `audit/spec/lib/llm.js` |
| รูปแบบสเปก ภาษานิพจน์ spec hash และ Markdown สำหรับรีวิว | `audit/spec/lib/spec.js` |
| ตัวสร้าง: Halmos `check_*`, forge invariant, wrapper ของ SMTChecker, การเล่นซ้ำตัวอย่างค้าน | `audit/spec/lib/gen.js` |
| ตัวรันการพิสูจน์, `proof.json` / `PROOF.md` | `audit/spec/lib/prove.js` |
| สัญญาตัวอย่างที่ตั้งใจให้มีบั๊ก (ใช้ทดสอบเท่านั้น) | `audit/spec/fixtures/BuggyVault.sol` |
| สเปก ไฟล์ของผู้ตรวจ และผลการพิสูจน์ของตัวอย่าง | `audit/spec/examples/` |
| `ProofRegistry` (ระดับ Proven และตลาดหลักฐาน) | `zetaphy-network/contracts/ProofRegistry.sol` |
| commitment และ tuple ฝั่ง JS | `zetaphy-network/src/proofs.js` |
| การทดสอบ | `audit/test/spec.test.js`, `zetaphy-network/test/proofs.test.js` |

## 1. ขั้นตอน

```
contract.sol (+ เอกสาร)
  │  node audit/spec/cli.js draft X.sol --contract X [--docs d.md] [--llm] [--with review.json]
  ▼
X.spec.json + X.spec.md      ทุกคุณสมบัติเป็น "proposed": ฮิวริสติก (ทุกครั้ง), LLM (ถ้าเลือก), ผู้ตรวจ (--with)
  │  คนอ่าน X.spec.md แล้วสั่ง approve --reviewer <ชื่อ> --ids … | --all  [--reject …]
  ▼
สเปกที่อนุมัติแล้ว, spec hash = keccak256(JSON แบบ canonical ของ target + harness + การตั้งค่า prover + คุณสมบัติที่อนุมัติ)
  │  node audit/spec/cli.js prove X.spec.json
  ▼
โฟลเดอร์งาน: test/Spec.t.sol (Halmos checks + forge invariants), smt/SpecSMT.sol, proof.json, PROOF.md
  │  ผู้พิสูจน์ commit ก่อน แล้วจึงส่ง (hash ของ artifact, เครื่องมือ, recipe) เข้า ProofRegistry พร้อมค่าธรรมเนียมของผู้รัน
  ▼
ผู้รัน NeuroJobs 3 คนรัน `prove` ซ้ำบนสเปกและโค้ดเดียวกัน, commit, reveal → 2 ใน 3 ตรงกันว่า "พิสูจน์ครบ"
  ▼
ProofRegistry: isProven(codeHash) · levelOf(chainId, target) = PROVEN ซ้อนบนใบรับรอง Gold ที่ยังใช้ได้
```

spec hash ครอบคลุมสิ่งที่ถูกพิสูจน์พอดี ถ้าใครแก้ harness คุณสมบัติ หรือการตั้งค่า prover หลังอนุมัติ `gen` และ `prove`
จะไม่ยอมรัน ("the spec changed after approval: approve it again")

## 2. การร่างสเปก

### 2.1 ฮิวริสติก (ไม่ใช้ AI ผลเหมือนเดิมทุกครั้ง)

`analyze.js` คอมไพล์สัญญาด้วย solc (ไบนารี 0.8.26 ที่ตรึงไว้ หรือ solc-js ใน `zetaphy-network`) แล้วไล่ AST
โดยขยายการเรียกฟังก์ชันภายใน modifier (โค้ดก่อนและหลัง `_`) และตัวชี้ storage (`Route storage r = _use(...)`) จากนั้นร่าง:

| รูปแบบที่พบ | คุณสมบัติที่ร่าง | ตรวจด้วย |
|---|---|---|
| ฟังก์ชันที่เปลี่ยนสถานะและ revert เมื่อ `msg.sender != x` / `!m[msg.sender]` | **access**: ผู้เรียกที่อยู่นอกกลุ่มนี้ revert ทุกครั้ง ไม่ว่าอาร์กิวเมนต์และ ETH ที่แนบมาจะเป็นอะไร | Halmos |
| uint ที่มีแต่เพิ่ม (`+=`, `++`) | **monotonic**: ไม่มีวันลดลง | Halmos |
| `mapping(address => uint)` กับ uint ยอดรวมที่ถูกเขียนคู่กัน (`balanceOf`/`totalSupply` ของโทเคน, เงินฝากของ vault) | **conservation**: แต่ละการเรียกเปลี่ยนยอดรวมเท่ากับผลรวมการเปลี่ยนยอดของบัญชีที่แตะพอดี | Halmos |
| uint ที่เพิ่มในฟังก์ชัน payable และลดตรงที่ ETH ออก | **backing** (supply ≤ backing): `address(t).balance >= t.x()` หลังลำดับการเรียกใดๆ | Halmos, SMTChecker (CHC), forge |
| ตัวแปร `paused` | **pause-noloss**: pause และ unpause ไม่เปลี่ยนยอดเงินหรือสถานะสาธารณะใด นอกจากตัวแปรนั้นเอง; **paused-blocks**: ฟังก์ชันที่เช็กตัวแปรนี้ revert ระหว่างหยุด | Halmos |
| ฟังก์ชันที่เรียกออกภายนอก | **cei**: ไม่มีการเขียน storage หลังการเรียกภายนอกครั้งแรก เว้นแต่มี reentrancy lock จริงคุ้มอยู่ | ตัวตรวจ AST |

สิ่งที่ไม่ใช่คุณสมบัติจะไปอยู่ใน "Notes for the reviewer" เช่น ฟังก์ชันเปลี่ยนสถานะที่ไม่มีใครคุ้ม การเดาทุกข้อเป็นแค่ร่าง:
ใน BuggyVault ฮิวริสติกเดาว่า `deposits` (ตัวนับ) เป็นผลรวมของยอดคงเหลือ ผู้ตรวจปฏิเสธข้อนี้
ถ้าอนุมัติไป ตัวพิสูจน์ก็จะหักล้างมัน

แบบจำลอง AST แยก reentrancy lock ออกจากบัญชีที่บังเอิญชื่อ `locked` ได้ lock คือตัวแปรที่ถูกอ่านในเงื่อนไข revert
และมีแต่การ *กำหนดค่า* (ตั้งตอนเข้า คืนค่าตอนออก) ดังนั้น `locked -= amount` ใน HyperlaneLockBoxV2 จึงเป็นบัญชี ไม่ใช่ lock

### 2.2 ขั้น LLM แบบเลือกได้

`draft --llm` จะเรียกโมเดลก็ต่อเมื่อมี `ANTHROPIC_API_KEY` (ค่าเริ่มต้น `claude-opus-5-5` เปลี่ยนได้ด้วย `ZETAPHY_SPEC_MODEL`)
ถ้าไม่มีคีย์ ร่างจะมาจากฮิวริสติกอย่างเดียวและไม่มีอะไรล้มเหลว โมเดลต้องตอบตาม JSON schema (`output_config.format`)
และเพิ่มได้เพียง 3 ชนิด:

- `invariant`: `expr` เป็นจริงหลังการตั้งค่าและหลังทุกการเรียกในลำดับ
- `post`: หลังการเรียกที่สำเร็จของฟังก์ชันใน `functions` แล้ว `expr` เป็นจริง โดย `old(e)` คือค่าของ e ก่อนเรียก
- `reverts`: การเรียกจะ revert ทุกครั้งที่ `when` เป็นจริง

ทุกข้อเสนอต้องผ่าน `screen()` ซึ่งเป็นตัวตรวจเดียวกับที่ใช้กับคุณสมบัติของผู้ตรวจ นิพจน์คือ boolean ของ Solidity ที่ใช้ได้เฉพาะ
`t.<view>(…)` (เฉพาะ view ที่สัญญามีจริง), `h.<view>(…)` (view ที่ harness ประกาศ), `address(t).balance`, ค่าคงที่ หน่วย และตัวดำเนินการ
ห้ามคำสั่ง (statement) เครื่องหมาย `;` วงเล็บปีกกา cheatcode (`vm`) `call` `assembly` `new` `this` `msg` และฟังก์ชันที่เปลี่ยนสถานะ
ข้อที่ผ่านจะเข้ามาเป็น `proposed` ความมั่นใจ `low` ข้อที่ไม่ผ่านจะแสดงใน Markdown พร้อมเหตุผล
และไม่มีอะไรที่โมเดลพูดถือว่าพิสูจน์แล้ว จนกว่าตัวพิสูจน์จะพิสูจน์ได้

### 2.3 harness และไฟล์ของผู้ตรวจ

Halmos ต้องมีสัญญาที่ deploy แล้วหนึ่งตัว ถ้า constructor รับแค่ค่าธรรมดา ร่างจะเขียน harness ให้เอง (ที่อยู่คงที่ ตัวเลขที่สมเหตุสมผล)
ถ้าต้องใช้สัญญาอื่น (Mailbox, ISM, airlock) harness จะถูกทำเครื่องหมาย `needs-review` แล้วผู้ตรวจเขียนไฟล์ `--with`:
โค้ด harness (helper, state, setup, actor, action เฉพาะ, view ของ harness, ขั้นของลำดับการเรียก) การตั้งค่า prover และคุณสมบัติเพิ่ม
ไฟล์นี้เป็นส่วนหนึ่งของสเปกที่อนุมัติและของ hash ด้วย ดู `audit/spec/examples/review/HyperlaneLockBoxV2.review.json`
และ `BridgeGuard.review.json`

## 3. การพิสูจน์

`node audit/spec/cli.js prove X.spec.json [--tools halmos,forge,smtchecker] [--code <runtime hex ที่ deploy แล้ว>]`
สร้าง artifact ลงใน `<โฟลเดอร์สเปก>/X.proof/` แล้วรัน:

- **Halmos 0.3.3**: `check_*` หนึ่งตัวต่อคุณสมบัติและฟังก์ชัน อินพุตทุกตัวเป็น word หนึ่งของพารามิเตอร์ `uint256[N] w`
  จึงเป็นสัญลักษณ์ทั้งหมด ผ่าน = พิสูจน์แล้วสำหรับ**ทุกอินพุตภายในขอบเขตที่ระบุ** (ระบุไว้ทุกคุณสมบัติ เช่น "ทุกลำดับ 3 การเรียก
  ของ lock, handle, claim, … จากสถานะหลังตั้งค่า") ลำดับถูกจำกัดด้วย `prover.depth` โค้ดที่สร้างไม่มี loop ให้ตัวพิสูจน์ต้องตัด
  ถ้า check ใดยังถูกตัด loop (`num_bounded_loops > 0`) จะเป็น `unknown` ไม่ใช่ proven
- **solc SMTChecker (CHC)**: invariant ที่อ่านแค่สถานะของสัญญาเอง ถูกคอมไพล์เป็น `assert` ในคลาสลูกของสัญญา
  ถ้า CHC พิสูจน์ได้ แปลว่าจริงใน**ทุกสถานะที่เข้าถึงได้ (ไม่จำกัดจำนวนขั้น)** ถ้าได้ "might happen" (พิสูจน์ไม่ทันเวลา) จะเป็น `unknown`
- **forge 1.2.3**: invariant ชุดเดียวกันภายใต้ stateful fuzzer เป็นแค่หลักฐานประกอบ ไม่ใช่การพิสูจน์ (`fuzz-passed`)
- **ตัวตรวจ AST** สำหรับ `cei`

**ตัวอย่างค้านถูกเล่นซ้ำ**: model ของ Halmos แต่ละตัวถูกเขียนกลับเป็นการทดสอบ forge แบบค่าจริง (`test/SpecReplay.t.sol`)
ซึ่งเรียก check ที่ล้มด้วยอินพุตนั้นพอดี และต้องเจอ `assert` เดียวกันล้ม (Panic 0x01) ในการรันบน EVM จริง `PROOF.md`
แสดงตัวอย่างค้านเป็นลำดับการเรียก ("deposit(value …) by 0xA11CE แล้ว emergencyWithdraw() by 0xA11CE")

**กฎความซื่อตรง**: คุณสมบัติจะเป็น `proven` ก็ต่อเมื่อตัวพิสูจน์พิสูจน์ได้ (ทุก check ของ Halmos หรือ CHC หรือตัวตรวจ AST)
และไม่มีเครื่องมือใดเจอตัวอย่างค้าน เครื่องมือที่ไม่ได้ติดตั้งจะเป็น `not-installed` การรันที่หมดเวลาหรือพังจะเป็น `unknown`
ทั้งสองอย่างไม่มีวันนับเป็น proven และ exit code จะเป็น 0 ก็ต่อเมื่อทุกคุณสมบัติที่อนุมัติพิสูจน์ได้ (1: มีตัวอย่างค้าน, 2: กรณีอื่น)
นิพจน์ของสเปกถูก assert ภายใน `unchecked` นิพจน์ที่ผิดจึงล้มเป็น assertion แทนที่จะเป็น arithmetic panic ที่ Halmos มองข้าม

`proof.json` เก็บ spec hash, source hash, runtime code hash (keccak ของ runtime ที่คอมไพล์โดยให้ immutable เป็นศูนย์; `--code`
เทียบกับสัญญาที่ deploy แล้วหลังปิด immutable ของมัน) เวอร์ชันเครื่องมือ hash ของ artifact, recipe, ผลรายคุณสมบัติ และ **result hash**
result hash คือ keccak ของผลแบบ canonical ซึ่งมีแค่สถานะ ไม่มีเวลา log หรือ model ของ solver
ผู้รันที่ซื่อตรงสองคนจึงได้ hash เดียวกัน

## 4. ผลบน repository นี้ (2026-11-03, forge 1.2.3, halmos 0.3.3, solc 0.8.26)

ทุกแถวมาจากการรันจริง ผลเต็มอยู่ใน `audit/spec/examples/<Name>.proof.json` และ `<Name>.PROOF.md` ส่วนสเปกที่อยู่ข้างกันคือสิ่งที่อนุมัติ

| สัญญา | สเปก | ผล | เวลา Halmos |
|---|---|---|---|
| `BuggyVault` (ใช้ทดสอบเท่านั้น ฝังบั๊กไว้ 2 ตัว) | ฮิวริสติกร่าง 11 ข้อ ผู้ตรวจปฏิเสธ 1 ข้อ (`deposits` เป็นตัวนับ ไม่ใช่ผลรวม) อนุมัติ 10 ข้อ | **พิสูจน์ได้ 7 ข้อ มีตัวอย่างค้าน 3 ข้อ**: `backing-totalDeposits` (Halmos เล่นซ้ำใน forge แล้ว, fuzzer ของ forge, SMTChecker CHC), `conservation-balanceOf-totalDeposits` (Halmos บน `emergencyWithdraw` เล่นซ้ำแล้ว), `cei-withdraw` (ตัวตรวจ AST: เขียน `balanceOf`, `totalDeposits` หลังการเรียก) ลำดับที่ Halmos หาเจอสำหรับบั๊กที่ 1: `deposit(value 39614081257132168796771975168) by 0xA11CE` แล้ว `emergencyWithdraw() by 0xA11CE` | 22 วินาที |
| `BridgedToken` (อยู่ใน `BridgeGuard.sol`) | ร่าง 3 ข้อ อนุมัติทั้งหมด harness เครื่องมือร่างเอง ไม่ต้องรีวิว | **พิสูจน์ได้ 3 จาก 3**: มีแค่ guard ที่ mint/burn ได้; ทุก mint, burn, transfer และ transferFrom เปลี่ยน `totalSupply` เท่ากับการเปลี่ยนยอดคงเหลือที่มันทำพอดี | 34 วินาที |
| `HyperlaneLockBoxV2` | ร่าง 20 ข้อ + ผู้ตรวจเพิ่ม 3 ข้อ; harness รีวิวแล้ว (MockMailbox, ISM ที่รับ**ทุก**ข้อความ, ล็อกไว้ 5 ETH ตอนตั้งค่า) | **พิสูจน์ได้ 23 จาก 23** รวมกฎ backing `locked-never-below-releases` (ทุกลำดับ 2 การเรียกของ lock / ข้อความ release ใดๆ / claim / pause / veto: ที่จ่ายออก ≤ ที่ล็อก และ `locked` = ที่ล็อก − ที่จ่าย), `backing-locked` (ETH ≥ `locked`), `daily-limit`, `claim-pays-from-locked`, การควบคุมสิทธิ์ของทั้ง 12 ฟังก์ชันที่มีการคุ้ม, `nonce` / `received` ไม่ลดลง, pause ไม่ทำให้เสียอะไร ทั้งนี้ SMTChecker พิสูจน์ `backing-locked` **ไม่จบ**ใน 300 วินาที (`timeout`) หลักฐานข้อนั้นจึงเป็นแบบจำกัดขั้นของ Halmos; fuzzing ของ forge ไม่พบอะไร | 114 วินาที |
| `BridgeGuard` | ร่าง 21 ข้อ + ผู้ตรวจเพิ่ม 5 ข้อ (ลิมิต); harness รีวิวแล้ว (ตัวแทน airlock และ ThreatRegistry, route IN 600/วัน และ OUT 400/วัน ใต้เพดาน 1000) | **พิสูจน์ได้ 26 จาก 26**: ไม่มี inbound / releaseHeld ไหนทำให้ยอดของวันเกินเพดานรวม outbound ก็เช่นกัน ลิมิตต่อ route ทั้งสองทิศ, inbound ครั้งเดียว mint ไม่เกินลิมิตของ route, access 14 ข้อ, pause ไม่ทำให้เสียอะไร, pause หยุด inbound / releaseHeld / outbound, checks-effects-interactions | 111 วินาที |

**ตรวจว่าไม่ว่างเปล่า (vacuity)** หลักฐานแบบ "หลัง X สำเร็จทุกครั้ง P เป็นจริง" ไม่มีความหมายถ้า X สำเร็จไม่ได้เลย สำหรับทุก
post-condition เราจึงรันสเปกอีกชุดที่ใส่ข้อที่ผิดโดยเจตนา (`false` หลัง X) ซึ่งต้องได้ตัวอย่างค้าน เพื่อแสดงว่า X สำเร็จได้จริง
harness แรกของ BridgeGuard ไม่มี threat registry ทำให้ `releaseHeld` ไม่มีวันสำเร็จ และ check `cap-in` ของมันว่างเปล่า
การตรวจนี้จับได้ ตอนนี้ harness จึงสร้าง mint ที่ถูกพักไว้หนึ่งรายการ และมีขั้น `unhold`
หลังแก้แล้ว ทุกการเรียกที่ post-condition อ้างถึง (inbound, outbound, releaseHeld, lock, handle, claim) ถูกแสดงว่าเข้าถึงได้

**สิ่งที่ไม่สำเร็จในครั้งแรก** (เก็บไว้เป็นหลักฐานว่ากฎความซื่อตรงใช้ได้): การรัน Halmos กับ HyperlaneLockBoxV2 ที่ความลึก 3
ไม่จบใน 30 นาที (สเปกจึงใช้ความลึก 2 และล็อก 5 ETH ไว้ตอนตั้งค่า) และการรันบน build cache เก่าทำให้ Halmos ข้ามทุกสัญญา
ทั้งสองกรณีออกมาเป็น `unknown` (unknown 21 จาก 23, พิสูจน์ได้ 2 ข้อด้วยตัวตรวจ AST) ไม่มีครั้งไหนเป็น proven
ตอนนี้ `prove` เริ่มจาก build ที่สะอาดทุกครั้ง

## 5. ProofRegistry: ระดับ Proven (A3)

`zetaphy-network/contracts/ProofRegistry.sol` เป็นส่วนเพิ่ม AuditCertificate ไม่ถูกแก้

1. **commit ก่อน แล้วจึงส่ง** ผู้พิสูจน์ commit `keccak256("zetaphy.proof.submit", codeHash, specHash, artifactsHash, prover, salt)`
   แล้วส่งจากบล็อกถัดไป: code hash (EXTCODEHASH), spec hash, source hash, จำนวนคุณสมบัติที่อนุมัติ, hash ของ artifact (ไม่เกิน 32),
   เวอร์ชันเครื่องมือ, URI และ hash ของ recipe พร้อมค่าธรรมเนียมของผู้รัน (อย่างน้อย `minFee`) commitment ผูก artifact ไว้กับผู้พิสูจน์
   คนที่ลอกหลักฐานจึงชิงส่งก่อนไม่ได้
2. **ผู้รัน 3 คน** (worker ของ NeuroJobs ที่วางเงินค้ำ active ไม่ได้ขอถอนเงินค้ำ มีงานที่ตรงกันอย่างน้อย `minAgreed` งาน
   งานที่ถูกปฏิเสธไม่มากกว่างานที่ตรงกัน และไม่ใช่ผู้พิสูจน์เอง) แต่ละคนรัน `prove` บนสเปกและโค้ดเดียวกัน
   commit `keccak256("zetaphy.proof.run", keccak256(abi.encode(outcome)), runner, salt, id)` ในช่วง commit แล้ว reveal ในช่วง reveal
   โดย outcome = (resultHash, proven, counterexamples, unknown)
3. **settle**: หลักฐานผ่านก็ต่อเมื่ออย่างน้อย 2 ใน 3 ที่นั่ง reveal outcome **เดียวกัน** โดย `proven == properties`
   ไม่มีตัวอย่างค้าน ไม่มีอะไร unknown (จึงไม่มีเครื่องมือไหน "ไม่ได้ติดตั้ง") และสเปกนี้ไม่เคยถูกหักล้างสำหรับโค้ดนี้
   ผู้รันที่ตรงกันแบ่งค่าธรรมเนียมกัน ถ้าไม่มีเสียงตรงกัน ค่าธรรมเนียมคืนผู้พิสูจน์ ผู้รันทุกคนถูกรายงานไปที่ WorkerReputation (ตรง, ไม่ตรง หรือขาด)
4. **การอ่าน**: `isProven(codeHash)`, `isProvenSpec(codeHash, specHash)`, `proof(id)`, `artifactsOf`, `toolsOf`, `recipeOf`
   ส่วน `levelOf(chainId, target)` คืนระดับของใบรับรองที่ยังใช้ได้ของ AuditCertificate (0 ถ้าไม่มี)
   และคืน **PROVEN (4)** เมื่อเป็นใบรับรอง Gold ที่ยังใช้ได้และ code hash ถูกพิสูจน์แล้ว การหมดอายุ การเพิกถอน และการเปลี่ยนโค้ด
   ตัดสินผ่านความใช้ได้ของ `certificate()` ของ AuditCertificate เอง

## 6. ตลาดหลักฐาน (S9)

- `postBounty(codeHash, specHash, properties, deadline, checker, specUri)` โดยจ่ายรางวัลมาพร้อม value
  deadline ต้องเหลือเวลาพอตรวจหลักฐานหนึ่งชิ้น (อย่างน้อยช่วง commit + reveal) และไม่เกินหนึ่งปี
- **รับรางวัลด้วยหลักฐาน**: ส่งหลักฐานโดยระบุ `bountyId` รางวัลหนึ่งรายการตรวจหลักฐานได้ทีละชิ้น (ไม่อย่างนั้นได้ `Busy`)
  ผู้พิสูจน์ของหลักฐานที่ผ่านได้รางวัล
- **รับรางวัลด้วยตัวอย่างค้าน**: commit `keccak256("zetaphy.proof.cex", bountyId, property, keccak(cex), claimant, salt)`
  แล้ว reveal จากบล็อกถัดไป สัญญา **checker** ของรางวัลจะเล่นซ้ำบนเชน: deploy โค้ดที่ตั้งรางวัลขึ้นใหม่ รันลำดับการเรียก
  ประเมินคุณสมบัติ แล้ว revert ทุกอย่างที่ตัวเองทำ registry บันทึกการจ่ายก่อน (effects) แล้วจึงถาม checker ถ้า checker ไม่ยืนยัน
  การเคลมทั้งหมดจะ revert ตัวอย่างค้านที่ยืนยันแล้ว**หักล้าง**สเปกนั้นสำหรับโค้ดนั้นถาวร หลักฐานของสเปกนั้นจะไม่นับอีก
  ทั้งที่เคยผ่านมาก่อนและที่จะส่งมาทีหลัง การลอก reveal ไม่มีประโยชน์ เพราะ commitment ระบุชื่อผู้เคลมไว้
- ถ้าไม่มีใครรับภายใน deadline (และไม่มีหลักฐานกำลังตรวจอยู่) ผู้ตั้งรางวัลถอนคืนได้
- การจ่ายทุกครั้งเป็นแบบดึง (pull): `withdraw(to)` จ่ายให้ผู้เรียกเอง หรือที่อยู่รับเงินที่ผู้เรียกตั้งไว้ (`setPayout`)

checker เป็นโค้ดของผู้ตั้งรางวัล เผยแพร่คู่กับสเปก ผู้ตั้งรางวัลที่ไม่สุจริตอาจใช้ checker ที่ไม่ยืนยันอะไรเลย
ผู้พิสูจน์ควรอ่านมันก่อนลงมือ (`BuggyVaultChecker` ในชุดทดสอบเป็นตัวอย่างรูปแบบ) และ checker ที่พยายาม re-enter ตลาดจะพบว่ารางวัลปิดไปแล้ว

governance คือ ZetaphyTimelock ตั้งได้แค่ช่วงเวลา (commit 1 ชม...30 วัน, reveal 1 ชม...7 วัน), `minFee` (≤ 1000 ZETA)
และ `minAgreed` (≤ 10000) และส่งต่อสิทธิ์ governance ได้ ไม่มี admin key ไม่มีปุ่มหยุด และไม่มีทางย้ายเงินของใคร

## 7. อะไรของจริง อะไรเป็นต้นแบบ

| | |
|---|---|
| ฮิวริสติก แบบจำลอง AST รูปแบบสเปก การอนุมัติและ hash ตัวสร้าง ตัวรันการพิสูจน์ การเล่นซ้ำตัวอย่างค้าน | **ของจริง** รันบนสัญญา 3 ตัวของ repository นี้และตัวอย่าง (หัวข้อ 4) |
| ขั้น LLM | **โค้ดจริงแต่ไม่ได้รันที่นี่**: สภาพแวดล้อมนี้ไม่มี API key ตัวกรองและรูปแบบคำขอถูกทดสอบด้วยคำตอบ HTTP จำลอง |
| ProofRegistry | **ทดสอบแล้ว**บน EVM ในหน่วยความจำ (`test/proofs.test.js` ใช้ outcome จากผลพิสูจน์ที่ commit ไว้); **ยังไม่ได้ deploy** |
| งานของผู้รัน ("รัน `prove` ซ้ำ, commit, reveal") | commitment อยู่ใน `src/proofs.js`; **ยังไม่มี daemon** ที่รับงานพิสูจน์แบบที่ `zetaphy audit run` ทำ |
| checker ตัวอย่างค้านบนเชน | เขียน**ด้วยมือ**ต่อรางวัล (ชุดทดสอบมีหนึ่งตัวสำหรับ BuggyVault) ยังไม่ได้สร้างจากสเปก |
| ขอบเขตการพิสูจน์ | การพิสูจน์ของ Halmos **จำกัดจำนวนขั้น**ที่ลำดับ `prover.depth` การเรียกจากสถานะหลังตั้งค่าของ harness มีแค่ CHC ที่ให้ invariant แบบไม่จำกัด และมักทำไม่จบกับสัญญาที่เรียกโค้ดที่ไม่รู้จัก |

## 8. ข้อจำกัด

- หลักฐานพูดถึง**สเปก** คุณสมบัติที่ผิดหรืออ่อนแม้พิสูจน์ได้ก็ไม่ได้บอกอะไรที่มีประโยชน์ อ่านสเปก harness และขอบเขตของแต่ละคุณสมบัติ
- harness เป็นส่วนหนึ่งของสิ่งที่พิสูจน์ mock (ISM ที่รับทุกอย่าง airlock จำลอง) คือสมมติฐาน ซึ่งเขียนไว้ในสเปกและถูก hash ไปด้วย
- Halmos จำลองบางอย่างแบบนามธรรม (เช่น `ecrecover`) และความลึกของลำดับเป็นขอบเขต ไม่ใช่การอุปนัย (induction)
- ฮิวริสติกอ่านรูปแบบ ไม่ได้อ่านเจตนา จึงพลาดคุณสมบัติที่ไม่มีรูปแบบไหนบอก และบางข้อที่เดาก็ผิด (หัวข้อ 2.1) จึงต้องมีคนอนุมัติ

## 9. ทำซ้ำ

```sh
bash audit/tools/install.sh ~/.audit-tools fast        # forge 1.2.3, halmos 0.3.3, solc 0.8.26 (+ z3 4.12) ตรวจ hash ทั้งหมด
export PATH=~/.audit-tools/bin:~/.audit-tools/venv/bin:$PATH LD_LIBRARY_PATH=<จาก install.sh>
node audit/spec/cli.js prove audit/spec/examples/BuggyVault.spec.json           # บั๊ก 2 ตัวถูกหักล้าง ที่เหลือพิสูจน์ได้
node audit/spec/cli.js prove audit/spec/examples/HyperlaneLockBoxV2.spec.json
node --test audit/test/spec.test.js
cd zetaphy-network && node --test test/proofs.test.js
```
