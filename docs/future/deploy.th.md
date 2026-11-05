# Deploy สัญญาของแผนที่ AI (ปุ่มเดียว)

แผนที่ AI ในฮับมี 35 รายการ รายการที่สัญญายังไม่ขึ้น testnet จะขึ้นป้ายว่า "หน้าพร้อม ยังไม่ได้ deploy สัญญา" มี workflow เดียวที่ deploy ให้ครบทุกตัว

**วิธีกด:** Actions › ai-deploy › Run workflow
- ใช้ environment `testnet-deploy` เจ้าของต้องกดอนุมัติ
- RPC สาธารณะต้องเปิดอยู่

ทำตามลำดับนี้:

1. deploy สัญญา AI ทุกตัวที่ยังขาด (`zetaphy-network/src/aideploy.js`) แต่ละตัว **มี ZetaphyTimelock เป็นเจ้าของ** กุญแจที่ใช้ deploy ไม่ได้ถือสิทธิ์อะไรไว้เลย
   - Model registry (1)
   - NeuroScore (3)
   - ModelEpochs (35)
   - SignalBoard (2, 7)
   - ตัวตรวจ passkey และคณะผู้ร่วมเซ็น (9, 14)
   - ทะเบียนเอเจนต์ (23)
   - ป้ายคน/เอเจนต์ และการรับรอง (25)
   - Intent executor (24)
   - Foresight (29), การพยากรณ์ความเสี่ยง (15), ตัวตรวจจับที่วิวัฒน์ได้ (26), Data DAO (16), สนามแดง-น้ำเงิน (27)
   - NeuroAttest (19), NeuroAnchor (30)
2. Useful work (10, 34) ถ้ายังไม่มี จะ deploy ไว้ในสถานะหยุดชั่วคราว
3. FederatedRounds (6) ถ้ายังไม่มี จะ deploy ไว้ในสถานะปิด
4. ตั้งให้หน้า Neuro ค้นหา peer อัตโนมัติผ่าน SignalBoard

หลัง deploy ให้รัน `node scripts/ai-deploy.js check` เพื่ออ่านเจ้าของของทุกสัญญากลับมาตรวจ ถ้ามีตัวไหนไม่ใช่ timelock จะขึ้นว่าล้มเหลว

ที่อยู่สัญญาจะถูกบันทึกลง `zetaphy-network/deployments/ai-77390.json` บน branch `ai/testnet` ให้เปิด PR แล้ว merge จากนั้นฮับจะเปลี่ยนป้ายของรายการเหล่านั้นเป็น "ใช้ได้แล้ว" เอง (`statusOf` ใน `zetaphy-hub/flow.js`)

ถ้ารันแล้วหยุดกลางทาง กดรันใหม่ได้เลย ตัวที่ deploy แล้วจะถูกข้าม

**สิ่งที่ปุ่มนี้ไม่ได้ทำ:**
- สัญญาที่หยุดชั่วคราว (useful work) หรือปิดอยู่ (federated) ต้องเปิดผ่านข้อเสนอของ timelock ภายหลัง
- กระจกของภูมิคุ้มกันหมู่ (28) บนเชนอื่น deploy ผ่าน workflow `neuro-oracle`

หมายเหตุ: timelock ของ testnet ตั้งค่าหน่วงเวลาไว้ที่ 0 (`getMinDelay() = 0`) ขั้นที่ 2 (useful work) จึงไม่ยอม deploy เพราะต้องการหน่วงอย่างน้อย 2 วัน ตั้งใจให้เป็นแบบนี้ ไม่ได้ลดการตรวจลง

## ปุ่ม frontier: ทุกอย่างที่เหลือซึ่งขึ้น testnet ได้ตอนนี้

**วิธีกด:** Actions › frontier-deploy › Run workflow
- ใช้ environment `testnet-deploy` เจ้าของต้องกดอนุมัติ RPC สาธารณะต้องเปิดอยู่
- ต้อง merge ผลของ ai-deploy ก่อน (ทะเบียนตัวตนแบบส่วนตัวใช้ LabelRegistry และ VouchRegistry)
- ใช้กุญแจเดียว ส่งทีละธุรกรรม และใช้กลุ่ม concurrency เดียวกับ ai-deploy จึงไม่รันพร้อมกัน
- ทุกสัญญาที่มีสิทธิ์ governance รับ **ZetaphyTimelock** ตั้งแต่ constructor ส่วนตัวอื่นไม่มีเจ้าของ กุญแจที่ใช้ deploy ไม่ถือสิทธิ์อะไร
- โค้ด: `zetaphy-network/src/frontierdeploy.js`, `scripts/frontier-deploy.js`

สิ่งที่ deploy (ตามลำดับ เฉพาะตัวที่ยังไม่มี):
- ImmuneRegistry และ ImmuneBroadcaster (immune-network.md) เจ้าของคือ timelock
- CircuitBreaker (self-healing.md) เจ้าของคือ timelock
- QuantumRescue (เจ้าของคือ timelock, maturity 720 บล็อก) และ PQSettlement (ไม่มีเจ้าของ) (quantum-safe-settlement.md)
- ZetaphyOutbox (trustless-bridge.md) ไม่มีเจ้าของ
- PoseidonT3, ZkIdentityVerifier, ZkIdentityRegistry, PrivatePoll (zk-identity.md) **ตัวตรวจใช้ trusted setup แบบ DEV (คนเดียว) ใช้ได้เฉพาะ testnet**
- HackInsurance (เหมือน `zetaphy deploy-assist insurance`) เจ้าของคือ timelock ใช้เฉพาะ testnet
- AuditNetwork, AuditRunners, AuditJudges, AuditCertificate (เหมือน `zetaphy deploy-audit`) treasury คือ RewardVault
- ZetaphyCheques, ZetaphyOfflineOrders, ZetaphyOfflineCash (เหมือน `scripts/offline-deploy.js`) ไม่มีเจ้าของ
- PQMultisigIsm จะ deploy เฉพาะเมื่อใส่ key hash ของ validator ML-DSA-44 (`pq_validators`) ตอนนี้ยังไม่มี จึงข้ามไว้
- ชั้น SS ของ audit network (record `deployments/ss-77390.json`):
  - InvariantFirewall (invariant-firewall.md) เจ้าของคือ timelock ใช้ AuditCertificate จำกัดเงินออกของโปรโตคอลที่ไม่มีใบรับรอง 10% ต่อวัน เป็นชั้นสัญญาเท่านั้น การตรวจระดับ node ยังปิดอยู่จนกว่าจะอัปเกรด `zetaphy-firewall` และโหวต ([CHAIN-FIREWALL.th.md](../CHAIN-FIREWALL.th.md))
  - ExploitMarket (red-team.md) เจ้าของคือ timelock ใช้ runner ของ NeuroJobs เงินประกันส่ง 1, commit / reveal อย่างละ 1 ชั่วโมง runner ได้ 10% (เหมือน `zetaphy deploy-redteam`)
  - EconomicBounds (red-team.md) ไม่มีเจ้าของ ใช้ AuditNetwork, AuditCertificate และ runner ของ NeuroJobs
  - ProofRegistry (specs-and-proofs.md) เจ้าของคือ timelock commit / reveal อย่างละ 1 วัน ค่าธรรมเนียม 1 ไม่มี WorkerReputation (ยังไม่ deploy)
  - ImmuneVaccines (immune-score.md) เจ้าของคือ timelock ใช้ AuditNetwork, AuditCertificate, HackInsurance และ ThreatRegistry **เฉพาะเมื่อ ThreatRegistry มี review hold** (ดูด้านล่าง)
  - SecurityScore (immune-score.md) ไม่มีเจ้าของ อ่าน AuditCertificate, AuditNetwork, CircuitBreaker, NeuroScore, ImmuneVaccines, ThreatRegistry, ImmuneRegistry
- Saphan ฝั่ง ZETAPHY ของเส้นทาง Sepolia (record `deployments/saphan-77390.json`):
  - SaphanBundles, SaphanOfflineTransfers ไม่มีเจ้าของ ไม่ต้องตั้งค่า
  - SaphanLiquidityBounds เจ้าของคือ timelock สำหรับเส้นทางที่ vault อยู่บน ZETAPHY (เหรียญที่เกิดบน ZETAPHY ยังไม่มี)
  - SaphanPrivacyPool ใช้ PoseidonT3 และ ZkIdentityVerifier ข้างบน กับ token(sepolia) ครั้งละ 0.01 **trusted setup แบบ DEV ใช้ได้เฉพาะ testnet**
  - SaphanReads, SaphanIntents, SaphanSealedOrders **deploy เฉพาะเมื่อเปิด `deployer_setters`** (ดูด้านล่าง) Reads อ่าน Sepolia ผ่าน ISM ของเส้นทาง ไม่มีแหล่ง state root (ปิดการอ่านแบบมีหลักฐาน) Intents ใช้ NeuroScore, ThreatRegistry, Mailbox ของ ZETAPHY และ ISM ของเส้นทาง Sepolia

ชั้น SS และ Saphan ต่อสายกับที่อยู่ที่ส่วนก่อนหน้าบันทึกไว้: `audit-77390.json`, `frontier-77390.json`, `ai-77390.json` (NeuroScore), launch state (NeuroJobs, ThreatRegistry) และเส้นทาง Sepolia บน ZETAPHY (`zetaphy-chain/hyperlane/saphan-routes.json`: ISM และ token)

- **Review hold:** ปุ่มจะถาม ThreatRegistry ว่ามี `underReview` ไหม ThreatRegistry ตอน launch เก่ากว่า review hold (PR #115) ตอนนี้บน testnet ImmuneVaccines จึงถูกสร้างโดยไม่ผูกกับมัน (บันทึกการตรงกันและแจ้งเจ้าของ แต่ไม่กักอะไร) และ SecurityScore ถูกข้าม เพราะถ้าใช้ registry นั้นทุกคะแนนจะเป็น degraded (ไม่เกิน 500) ถ้าไม่ใช้ก็จะไม่เห็น flag ถ้า registry มี review hold จะ deploy ทั้งคู่ แล้ว timelock ต้องเรียก `ThreatRegistry.setVaccines(ImmuneVaccines)`
- **`deployer_setters`:** SaphanReads (`setResponder`) และ SaphanIntents (`setRelay` หนึ่งครั้งต่อเชน) ให้ผู้ deploy ตั้งสัญญาบนเชนต้นทางที่ตอบมันได้หนึ่งครั้ง สัญญาไม่มีทางผ่าน governance ผู้ deploy จึงถือสิทธิ์นี้จนกว่าจะใช้ ปุ่มจะ deploy สามตัวนี้เฉพาะเมื่อเปิด `deployer_setters` และ record จะเขียนสิทธิ์นั้นไว้ใน `deployerRoles` ค่าเริ่มต้นปิด กุญแจที่ใช้ deploy จึงไม่ถือสิทธิ์อะไร

สิ่งที่ **ไม่** deploy และเหตุผล (บันทึกไว้ใน record ช่อง `skipped` ด้วย):
- **TrainingPool, TrainingMarket, UsefulWork, UsefulIssuance, BugBounty, WorkerReputation**: ต้องการ timelock ที่หน่วงอย่างน้อย 2 วัน แต่ของ testnet เป็น 0
- **ProvenVerdicts**: ต้องใช้กุญแจสุดท้ายจากพิธี zkML สาธารณะ ซึ่งยังไม่เสร็จ
- **StarkLightClient / StarkVerifier, ZetaphyBridgeInbox, ImmuneMirror, ZetaphyLockbox**: อยู่บนเชนอื่น (หรือหนึ่งตัวต่อเส้นทาง) ต้องใช้ checkpoint, mailbox หรือเหรียญจริงของเชนนั้น
- **BtcLightClient**: ต้องใช้ header ของ Bitcoin จริงเป็นจุดเริ่ม และตัวส่ง header
- **PrivateAirdrop**: หนึ่งตัวต่อหนึ่ง airdrop ผู้สนับสนุนเป็นคนเติมเงิน **ImmuneGuardedRouter**: เป็นตัวอย่างการใช้งาน
- **Encrypted mempool**: เป็นโมดูลของเชน ไม่ใช่สัญญา
- **NeuroJobs, StableGateway, RewardVault, BridgeAirlock** และสัญญาตอน launch: deploy ไปแล้ว ถ้า deploy ใหม่ต้องต่อสายทุกอย่างที่ชี้มาใหม่หมด
- **ScoredCollateral**: เป็นตัวอย่าง โปรโตคอลปล่อยกู้จะ deploy ของตัวเองพร้อม tier ของตัวเอง
- **invariant firewall ระดับ node**: เป็นโมดูลของเชน เปิดด้วยการอัปเกรด `zetaphy-firewall` และโหวต
- **SaphanAccountFactory**: ที่อยู่เดียวกันทุกเชนต้องใช้กุญแจใหม่ที่ deploy เป็นธุรกรรมแรกบนทุกเชน
- **SaphanRecoveryClaims**: หนึ่งตัวต่อหนึ่งเหตุการณ์ timelock deploy หลังทำ snapshot
- **SaphanBtcWithdrawals**: ต้องมี BtcLightClient ก่อน **SaphanAggLane**: ต้องมีคณะกรรมการ ML-DSA-44 ซึ่งยังไม่มี
- **สัญญาบนเชนต้นทาง** (SaphanReadResponder, SaphanZetaphyReads, SaphanFillRelay, SaphanSourceGateway, account factory และ liquidity bounds ของเชนต้นทาง, SaphanReleaseVerifier): "source chain: saphan-route"

หลัง deploy จะรัน `node scripts/frontier-deploy.js check` อ่านทุกที่อยู่กลับมาตรวจ ถ้ามี governance ตัวไหนไม่ใช่ timelock จะล้มเหลว ผลจะอยู่บน branch `frontier/testnet` (`deployments/frontier-77390.json` พร้อมรายการที่ข้าม, `audit-77390.json`, `offline-77390.json`, `ss-77390.json`, `saphan-77390.json`, `qsafe-77390.json` และ `zetaphy-chain/hyperlane/immune-network.json`) ให้เปิด PR แล้ว merge ฮับจะอ่านเอง

ถ้ารันแล้วหยุดกลางทาง กดรันใหม่ได้เลย ตัวที่บันทึกแล้วจะถูกข้าม ตัวที่ขึ้นเชนหลังจากหยุดจะถูกรับเข้า record และ audit network ที่ deploy ไปครึ่งเดียวจะถูกทำต่อจนครบที่ที่อยู่เดิม
