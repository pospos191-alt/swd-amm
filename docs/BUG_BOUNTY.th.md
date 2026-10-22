[English](BUG_BOUNTY.md) | **ภาษาไทย**

# โครงการล่าบั๊ก (Bug Bounty) ของ ZETAPHY

> **ตอนนี้ยังไม่มีเงินรางวัลจริง** ZETAPHY อยู่ใน testnet เหรียญไม่มีมูลค่า และยังไม่มีกองเงินรางวัล
> - **ช่วง testnet:** รางวัลเป็นการ **ให้เครดิต** เท่านั้น (ชื่อใน Hall of Fame ด้านล่าง, ขอบคุณในบันทึกการแก้ไขและรายงาน) ไม่มีเงิน ไม่มีโทเคน
> - **ก่อน mainnet:** ต้องโอนเงินรางวัลจริงเข้ากองแยก (กองทุนชุมชน ถือโดย multisig) ด้วยการโหวตของ governance **ก่อน** เปิดรับเงินจริง และประกาศยอดในไฟล์นี้
>   จนกว่าจะประกาศ ตัวเลขในตารางเป็นเพียง "เป้าหมาย" ไม่ใช่คำสัญญา
> - สะพาน lock/mint (`BridgeAirlock`) **ปิดอยู่** และจะเปิดหลังมีโครงการนี้แบบมีเงินจริงแล้วเท่านั้น (ดู `zetaphy-network/README.md` ขั้น 3)

English summary at the end.

## ขอบเขต (in scope)

| ส่วน | อยู่ที่ |
|---|---|
| patch ของเชน (Cosmos EVM: ML-DSA, `MsgEVMCall`, ล็อกควอนตัม, เผาค่าธรรมเนียม, เลขสุ่ม, `x/ratelimit`, preinstalls) | `zetaphy-chain/` |
| สะพาน: `BridgeGuard`, `BridgedToken`, `BridgeAirlock` (รวม marker), `NeuroLane`, `HyperlaneLane`, `HyperlaneLockBox`, `LockBox`, `zetaphy bridge watch` / `open` / `monitor` | `zetaphy-network/contracts/`, `zetaphy-network/src/` |
| สัญญา Neuro: `NeuroJobs`, `NeuroJobsChallenges`, `NeuroControl`, `ThreatRegistry`, `ThreatReports`, `NeuroIdentity`, `NeuroValidation`, `ComputeMarket`, `RewardVault`, `StableGateway`, `QuantumWallet`, `SimpleMultisig` | `zetaphy-network/contracts/` |
| การปกครองและราคา: `ZetaphyTimelock` (OpenZeppelin `TimelockController` 5.4.0 ที่ pin ไว้ใน `vendor/`, รวมการส่งต่อสิทธิ์ของ launch tool), `ZetaphyOracle`, `TwapRecorder`, `ZetaphyPythRelay`, ปุ่มฉุกเฉินของ guardian, `zetaphy timelock` / `oracle` | `zetaphy-network/contracts/`, `zetaphy-network/vendor/`, `zetaphy-network/src/`, `zetaphy-launch/` |
| DEX (factory, router, pair) | `zetaphy-dex/` |
| NFT (factory, marketplace) | `zetaphy-nft/` |
| กระเป๋าเว็บ (รวมบัญชี PQ) | `zetaphy-wallet/` |
| MetaMask Snap | `zetaphy-snap/` |

**นอกขอบเขต:** บริการของบุคคลที่สาม (Oracle Cloud, Vercel, GitHub, MetaMask, Hyperlane, Noble) เว้นแต่ปัญหาอยู่ที่วิธีที่เราใช้มัน ·
DoS ด้วยการยิงคำขอจำนวนมาก (spam/flood) · social engineering หรือ phishing ต่อทีมและผู้ใช้ · ช่องโหว่ที่ต้องได้ private key หรืออุปกรณ์ของเหยื่อก่อน ·
รายงานจากเครื่องมือสแกนอัตโนมัติที่ไม่มีวิธีทำซ้ำ · ปัญหาที่บันทึกไว้แล้วว่า "ยอมรับความเสี่ยง" ใน `SECURITY.md` หรือ README ของแต่ละแพ็กเกจ ·
การติดธงของ Neuro ที่ผิด (เป็นเรื่องอุทธรณ์ `zetaphy threat appeal` ไม่ใช่ช่องโหว่) เว้นแต่มีวิธีบังคับให้ติดหรือปลดธงเกินสิทธิ์

## ระดับความรุนแรงและรางวัล

ใช้แนวทาง Immunefi Vulnerability Severity Classification System v2.3 เป็นหลัก ตัดสินโดยผลกระทบจริงที่ทำซ้ำได้

| ระดับ | ตัวอย่าง | เป้าหมายรางวัลหลัง mainnet (เทียบ USD) | ช่วง testnet |
|---|---|---|---|
| วิกฤต (Critical) | ผลิตเหรียญบนสะพานโดยไม่มีการล็อกจริง · ขโมยหรือแช่แข็งเงินผู้ใช้ถาวร · ปลอมลายเซ็น ML-DSA / ยึดบัญชีที่ล็อกควอนตัม · ทำให้เชนแยกหรือหยุดถาวร | 10% ของเงินที่เสี่ยง สูงสุด 50,000 (ขั้นต่ำ 10,000) | เครดิต + Hall of Fame |
| สูง (High) | ข้ามเพดานต่อวันหรือ pause ของ `BridgeGuard` · คนรันร่างส่วนน้อยยึดผลตรวจ Neuro · แช่แข็งเงินชั่วคราว · ข้ามสิทธิ์ governance | 5,000 – 10,000 | เครดิต |
| กลาง (Medium) | ทำให้สัญญาใช้งานไม่ได้ (griefing) โดยไม่เสียเงิน · ขโมยค่าธรรมเนียม/รางวัลเล็กน้อย · ข้ามการตรวจ ThreatRegistry ของ DEX/NFT | 1,000 – 5,000 | เครดิต |
| ต่ำ (Low) | ฟังก์ชันไม่ทำตามที่บอกโดยไม่เสียเงิน · กระเป๋า/Snap แสดงข้อมูลผิดที่ทำให้ผู้ใช้เข้าใจผิดได้ | 100 – 1,000 | เครดิต |

- จ่ายจาก **กองทุนชุมชน** เมื่อ governance โหวตอนุมัติ (proposal ต่อรายงาน) ทีมเสนอระดับและยอด ชุมชนโหวต
- จ่ายเป็น USDC หรือ ZETAPHY ตามที่โหวต ไม่เกินยอดที่ประกาศว่ามีในกอง
- รายงานซ้ำ: รางวัลให้คนแรกที่ส่งรายงานครบถ้วน
- ปัญหาเดียวที่ต้นเหตุเดียวกันนับเป็นรายงานเดียว
- ผู้ที่ทำงานให้โครงการ (ได้ค่าจ้าง) หรือเป็นผู้ตรวจ audit ที่จ้างอยู่ ไม่รับเงินรางวัล (ได้เครดิต)
- ต้องทำตามกฎหมายของประเทศผู้รายงาน (รวมถึงภาษีและการคว่ำบาตร) ทีมอาจขอยืนยันตัวตน (KYC) ก่อนจ่ายเงินจริง

## กติกา

1. ทดสอบบน **devnet ของคุณเอง** (`zetaphy-network/scripts/devnet.sh`, `npm run test:devnet*`) หรือ testnet สาธารณะเท่านั้น ห้ามแตะ mainnet ของเชนอื่นหรือเงินของคนอื่น
2. บน testnet สาธารณะ: ใช้บัญชีของคุณเอง ห้ามขโมย/แช่แข็งเหรียญทดลองของผู้อื่นเกินที่จำเป็นเพื่อพิสูจน์ ห้ามทำให้เชนหยุด (แจ้งเราก่อน เราช่วยตั้งเชนทดสอบให้)
3. ห้ามเปิดเผยต่อสาธารณะก่อนแก้เสร็จ (ดูกำหนดเวลาด้านล่าง)
4. ห้าม DoS, spam, social engineering, เข้าถึงข้อมูลส่วนบุคคล
5. แนบวิธีทำซ้ำ: commit ที่ทดสอบ, ขั้นตอน, สคริปต์หรือเทสต์ (ดีที่สุดคือเทสต์ `node --test` ที่ล้มก่อนแก้) และผลกระทบที่คาดไว้
6. หนึ่งรายงานต่อหนึ่งปัญหา

### Safe harbor

ถ้าคุณทำตามกติกาข้างบนโดยสุจริต:
- เราถือว่าการวิจัยของคุณได้รับอนุญาต จะไม่ดำเนินคดีหรือร้องเรียนต่อเจ้าหน้าที่ และจะไม่ขอให้ผู้ให้บริการระงับบัญชีของคุณ
- ถ้าบุคคลที่สามดำเนินการกับคุณเพราะการวิจัยที่ทำตามกติกานี้ เราจะแจ้งให้เขารู้ว่าเราอนุญาต
- ถ้าไม่แน่ใจว่าการทดสอบใดอยู่ในกติกาหรือไม่ ถามเราก่อน (ช่องทางส่วนตัวด้านล่าง)

safe harbor นี้ใช้กับการกระทำของ **ผู้ดูแลโครงการ** เท่านั้น ไม่ผูกมัดบุคคลที่สาม และไม่ใช่คำแนะนำทางกฎหมาย (ดู `docs/LEGAL.md`)

## รายงานแบบส่วนตัว

**อย่าเปิด issue สาธารณะสำหรับช่องโหว่**

1. **GitHub Private vulnerability reporting (ทางหลัก):** หน้า repo → แท็บ **Security** → **Report a vulnerability**
   - เจ้าของ repo ต้องเปิดก่อน: **Settings → Code security** (หรือ **Security**) → **Private vulnerability reporting** → **Enable**
   - รายงานเห็นเฉพาะผู้ดูแล repo; คุยต่อและออก advisory / CVE ได้ในที่เดียว
2. **อีเมล (สำรอง):** `security@<โดเมนของโครงการ>` — *ยังไม่มี เจ้าของโครงการต้องสร้างและใส่แทนข้อความนี้ (เช่นเดียวกับข้อ 11 ใน `docs/LAUNCH.md`)*
   ถ้าส่งไฟล์สำคัญ ขอ PGP key ก่อน

ใส่ในรายงาน: ส่วนที่ได้รับผลกระทบ, commit, ระดับที่คุณประเมิน, วิธีทำซ้ำ, ผลกระทบ, ข้อเสนอการแก้ (ถ้ามี), ชื่อที่ต้องการให้ใส่ใน Hall of Fame (หรือไม่ระบุชื่อ)

## กำหนดเวลา

| เมื่อ | อะไร |
|---|---|
| ภายใน 3 วันทำการ | ตอบรับว่าได้รับรายงาน |
| ภายใน 10 วันทำการ | ยืนยันว่าทำซ้ำได้ และประเมินระดับเบื้องต้น |
| ระหว่างแก้ | ถ้าเป็นสะพานหรือเงินผู้ใช้: guardian กด pause (`zetaphy bridge pause`) / ปิด route ก่อน แล้วค่อยแก้ |
| แก้เสร็จ | วิกฤต/สูง: เป้าหมาย 30 วัน · กลาง/ต่ำ: 90 วัน |
| เปิดเผย | หลังแก้และ deploy แล้ว หรือ 90 วันหลังรายงาน (อย่างใดถึงก่อน) ตกลงวันกับผู้รายงาน ออก GitHub Security Advisory ให้เครดิตผู้รายงาน |

ถ้าเราไม่ตอบตามเวลา ผู้รายงานมีสิทธิ์เปิดเผยหลัง 90 วัน โดยแจ้งเราก่อน 7 วัน

## Hall of Fame

(ยังไม่มี)

---

## English summary

**There is no real money in this program yet.** ZETAPHY is a testnet; its coins have no value. Until mainnet, rewards are
**recognition only** (Hall of Fame, credit in advisories). Real reward amounts must be **funded into a separate community-fund
pool held by a multisig, by a governance vote, before mainnet** and announced here; until then the amounts below are targets,
not promises. The lock/mint bridge stays closed until this program is funded.

- **Scope:** the chain patch (`zetaphy-chain/`), the bridge (`BridgeGuard`, `BridgeAirlock`, `NeuroLane`, `HyperlaneLane`,
  `HyperlaneLockBox`, `LockBox`, the airlock's markers and the CLI around them, including the bridge monitor), the Neuro contracts (`zetaphy-network/contracts/`),
  the governance timelock and its handover (`ZetaphyTimelock`, the pinned OpenZeppelin files in `zetaphy-network/vendor/`, `zetaphy-launch/`), the guardians'
  emergency switches, the price oracle (`ZetaphyOracle`, `TwapRecorder`, `ZetaphyPythRelay`, `StableGateway`'s pricing),
  the DEX (`zetaphy-dex/`), NFT (`zetaphy-nft/`), the web wallet (`zetaphy-wallet/`) and the MetaMask Snap (`zetaphy-snap/`).
  Out of scope: third-party services, volumetric DoS, social engineering, issues needing the victim's key or device,
  unreproduced scanner output, risks already accepted in `SECURITY.md`, and disputes about a Neuro flag (use the appeal).
- **Severity / target rewards after mainnet (USD equivalent):** Critical 10% of funds at risk, 10,000–50,000 · High
  5,000–10,000 · Medium 1,000–5,000 · Low 100–1,000 (Immunefi severity system v2.3). Paid from the community fund
  after a governance vote; first complete report wins; one root cause, one report.
- **Rules:** test on your own devnet or the public testnet only, with your own accounts; no DoS, spam, social engineering
  or privacy violations; no public disclosure before the fix; include a reproduction (ideally a failing `node --test`).
- **Safe harbor:** good-faith research under these rules is authorized; we will not pursue or support legal action
  against you for it. This binds the project maintainers only, and is not legal advice.
- **Report privately:** GitHub → this repository → **Security → Report a vulnerability** (the owner enables it under
  **Settings → Code security → Private vulnerability reporting**). Fallback e-mail: `security@<project domain>`
  (placeholder: the owner still has to create it). Never open a public issue for a vulnerability.
- **Timeline:** acknowledge within 3 business days, triage within 10, fix target 30 days (critical/high) or 90 days
  (medium/low), coordinated disclosure after the fix or 90 days, whichever comes first, with a GitHub Security Advisory.
