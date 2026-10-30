# รายงานตรวจสอบอัตโนมัติ ZETAPHY (สรุปภาษาไทย)

> ตรวจ commit `a54308231969d56318e5569c5a03d104f3618919` ระดับ เร็ว (fast, ทุก PR) เมื่อ 2026-10-30T11:57:24Z
> รายงานนี้สร้างโดยเครื่องมือฟรีโอเพนซอร์สและสคริปต์ของเราเอง **ไม่ใช่การ audit อิสระ และใช้แทนการ audit โดยผู้เชี่ยวชาญภายนอกไม่ได้** รายละเอียดเต็มอยู่ใน [REPORT.md](REPORT.md)

## สรุปจำนวนสิ่งที่พบ

| ระดับ | ทั้งหมด | ยังเปิดอยู่ | เปิดอยู่และเป็นของใหม่ |
|---|---:|---:|---:|
| วิกฤต (Critical) | 0 | 0 | 0 |
| สูง (High) | 205 | 72 | 0 |
| กลาง (Medium) | 370 | 370 | - |
| ต่ำ (Low) | 1381 | 1381 | - |
| ข้อมูล (Info) | 301 | 301 | - |

- **ด่านตรวจ PR:** ผ่าน — ไม่มีสิ่งที่พบระดับสูง/วิกฤตใหม่ที่ยังไม่ได้ตัดสิน
- **รอเจ้าของยืนยัน:** การตัดสินใน triage.yml 133 รายการ (ระดับสูง/วิกฤต 133) เป็นการตัดสินชั่วคราว ("owner to confirm") — ด่านตรวจ PR และ --json นับเหมือนตัดสินแล้ว แต่ในรายงานติดป้าย "รอเจ้าของยืนยัน" เจ้าของยืนยันโดยใส่ชื่อตัวเองใน decided_by หรือปฏิเสธโดยลบรายการ
- **ชุดทดสอบ invariant / property:** ผ่าน 96 · ไม่ผ่าน 0 · ยังไม่ได้รัน 0
- **คะแนน mutation testing:** ไม่ได้วัดในรอบนี้ (วัดในรอบ deep รายสัปดาห์)
- **สัญญาที่คอมไพล์:** 89 ตัว · artifacts ที่ commit ไว้ตรงกับซอร์ส 105 ตัว ไม่ตรง 0 ตัว

## รายการระดับสูง/วิกฤตที่ยังเปิดอยู่

(ตัดสินแล้ว 133 รายการ ในจำนวนนี้รอเจ้าของยืนยัน 133 รายการ — ดูเหตุผลใน REPORT.md / triage.yml)

- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:135` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:184` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:602` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:131` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentPolicyWallet.sol:415` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentPolicyWallet.sol:434` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:295` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:313` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:326` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BridgeAirlock.sol:447` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BridgeAirlock.sol:448` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BridgeAirlock.sol:477` — aderyn/contract-locks-ether: Contract locks Ether without a withdraw function — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BugBounty.sol:279` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BugBounty.sol:320` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ComputeMarket.sol:76` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ComputeMarket.sol:128` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DataDAO.sol:151` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DetectorPool.sol:117` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DetectorPool.sol:120` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DetectorPool.sol:228` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HackInsurance.sol:187` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HackInsurance.sol:211` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HackInsurance.sol:292` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HumanAgentLabels.sol:371` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HumanAgentLabels.sol:375` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HumanAgentLabels.sol:393` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HumanAgentLabels.sol:553` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HumanAgentLabels.sol:559` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HumanAgentLabels.sol:613` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HyperlaneLane.sol:121` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HyperlaneLane.sol:149` — aderyn/contract-locks-ether: Contract locks Ether without a withdraw function — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroAttest.sol:93` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroAttest.sol:95` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroAttest.sol:97` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:830` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:867` — aderyn/weak-randomness: Weak Randomness — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:1105` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:1106` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroOracle.sol:253` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroScore.sol:188` — aderyn/unsafe-casting: Unsafe Casting of integers — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroScore.sol:189` — aderyn/unsafe-casting: Unsafe Casting of integers — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RedBlueArena.sol:212` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RedBlueArena.sol:497` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RewardVault.sol:93` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RewardVault.sol:147` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RiskForecasts.sol:195` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RiskForecasts.sol:280` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatRegistry.sol:701` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:96` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:105` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:108` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:110` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:125` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:129` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:130` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/UsefulIssuance.sol:111` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/UsefulIssuance.sol:115` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/UsefulWork.sol:374` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/WorkerReputation.sol:126` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyFarm.sol:124` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyPass.sol:62` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyPass.sol:65` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyPolls.sol:54` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:179` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:180` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:183` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:263` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentPolicyWallet.sol:601` — slither/arbitrary-send-eth: arbitrary-send-eth — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:403` — slither/arbitrary-send-eth: arbitrary-send-eth — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:301` — slither/weak-prng: weak-prng — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ThreatReports.sol:141` — slither/arbitrary-send-eth: arbitrary-send-eth — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOfflineOrders.sol:237` — slither/arbitrary-send-eth: arbitrary-send-eth — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)

## วิธีอ่านและจัดการ

1. ดูรายการระดับสูง/วิกฤตก่อน อ่านโค้ดตรงบรรทัดที่ระบุ แล้วตัดสินว่าเป็นปัญหาจริงหรือไม่
2. ถ้าจริง: แก้โค้ดใน PR แยก แล้วเพิ่มใน `audit/triage.yml` เป็น `fixed` (เมื่อแก้แล้วเครื่องมือจะไม่พบอีก)
3. ถ้าไม่จริง: เพิ่มเป็น `false-positive` พร้อมเหตุผลที่ตรวจสอบได้ และชื่อผู้ตัดสิน (`decided_by`)
4. ถ้ายอมรับความเสี่ยง: `accepted-risk` พร้อมเหตุผล — ระบบไม่เคยใส่สถานะเหล่านี้เอง มีแต่คนเท่านั้นที่แก้ไฟล์นี้

## สิ่งที่รายงานนี้พิสูจน์ไม่ได้ (ณ 2026-10-30)

- ไม่พบปัญหา ≠ ปลอดภัย: เครื่องมือรู้จักแค่รูปแบบที่เคยเห็น พลาดบั๊กเชิงตรรกะธุรกิจได้ง่าย
- ไม่ได้จำลองการโจมตีเชิงเศรษฐศาสตร์ (flash loan, ปั่นราคา oracle, MEV, ยึด governance)
- SMTChecker พิสูจน์ได้เฉพาะที่รายงานว่าพิสูจน์แล้ว ภายในเวลาที่กำหนด
- fuzzing/invariant ทดสอบเฉพาะคุณสมบัติที่มีคนเขียนไว้ ชุดที่ยังไม่มีนับเป็น "ยังไม่ได้รัน" ไม่ใช่ "ผ่าน"
- ไม่ครอบคลุมการ deploy และการดูแลกุญแจ owner/admin, multisig, timelock ที่ใช้จริง
- **ก่อนใช้ mainnet กับเงินจริง ยังต้องมีการ audit อิสระโดยคน** (ดู SECURITY.md)

