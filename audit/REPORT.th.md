# รายงานตรวจสอบอัตโนมัติ ZETAPHY (สรุปภาษาไทย)

> ตรวจ commit `d07b9807b605287bc2d74b143bbd65fe58edf958` ระดับ เร็ว (fast, ทุก PR) เมื่อ 2026-10-30T09:01:35Z
> รายงานนี้สร้างโดยเครื่องมือฟรีโอเพนซอร์สและสคริปต์ของเราเอง **ไม่ใช่การ audit อิสระ และใช้แทนการ audit โดยผู้เชี่ยวชาญภายนอกไม่ได้** รายละเอียดเต็มอยู่ใน [REPORT.md](REPORT.md)

## สรุปจำนวนสิ่งที่พบ

| ระดับ | ทั้งหมด | ยังเปิดอยู่ | เปิดอยู่และเป็นของใหม่ |
|---|---:|---:|---:|
| วิกฤต (Critical) | 0 | 0 | 0 |
| สูง (High) | 196 | 73 | 0 |
| กลาง (Medium) | 331 | 331 | - |
| ต่ำ (Low) | 1272 | 1272 | - |
| ข้อมูล (Info) | 289 | 289 | - |

- **ด่านตรวจ PR:** ผ่าน — ไม่มีสิ่งที่พบระดับสูง/วิกฤตใหม่ที่ยังไม่ได้ตัดสิน
- **ชุดทดสอบ invariant / property:** ผ่าน 0 · ไม่ผ่าน 0 · ยังไม่ได้รัน 3
- **คะแนน mutation testing:** 58.3%
- **สัญญาที่คอมไพล์:** 85 ตัว · artifacts ที่ commit ไว้ตรงกับซอร์ส 101 ตัว ไม่ตรง 0 ตัว

## รายการระดับสูง/วิกฤตที่ยังเปิดอยู่

(ตัดสินแล้ว 123 รายการ — ดูเหตุผลใน REPORT.md / triage.yml)

- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol:135` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:184` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol:602` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol:131` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentPolicyWallet.sol:406` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentPolicyWallet.sol:425` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:280` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:298` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:311` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BridgeAirlock.sol:408` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BridgeAirlock.sol:409` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BridgeAirlock.sol:438` — aderyn/contract-locks-ether: Contract locks Ether without a withdraw function — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BugBounty.sol:222` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BugBounty.sol:260` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/BugBounty.sol:297` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ComputeMarket.sol:76` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ComputeMarket.sol:128` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DataDAO.sol:151` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DetectorPool.sol:117` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DetectorPool.sol:120` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/DetectorPool.sol:228` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HackInsurance.sol:172` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HackInsurance.sol:191` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/HackInsurance.sol:270` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
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
- `zetaphy-network/contracts/NeuroJobs.sol:819` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:856` — aderyn/weak-randomness: Weak Randomness — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:1094` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:1095` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroOracle.sol:215` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroScore.sol:188` — aderyn/unsafe-casting: Unsafe Casting of integers — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroScore.sol:189` — aderyn/unsafe-casting: Unsafe Casting of integers — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RedBlueArena.sol:212` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RedBlueArena.sol:497` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RewardVault.sol:79` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/RewardVault.sol:127` — aderyn/eth-send-unchecked-address: ETH transferred without address checks — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
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
- `zetaphy-network/contracts/ZetaphyEarlyFarm.sol:115` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyPass.sol:62` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyPass.sol:65` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyEarlyPolls.sol:54` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:179` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:180` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:183` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/ZetaphyOracle.sol:263` — aderyn/reentrancy-state-change: Reentrancy: State change after external call — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentPolicyWallet.sol:550` — slither/arbitrary-send-eth: arbitrary-send-eth — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/AgentRegistry.sol:388` — slither/arbitrary-send-eth: arbitrary-send-eth — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
- `zetaphy-network/contracts/NeuroJobs.sol:295` — slither/weak-prng: weak-prng — สถานะ: เปิดอยู่ (รู้แล้ว รอตัดสิน)
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

