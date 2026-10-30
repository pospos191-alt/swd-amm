[English](immune-network.md) | **ภาษาไทย**

# ระบบภูมิคุ้มกันของ Web3: เห็นบนเชนเดียว รู้ทั่วทุกเชน

นี่คือต้นแบบบน testnet ยังไม่ได้ติดตั้งจริง ไม่มีเงินจริงอยู่ในระบบ และยังไม่ผ่านการตรวจโค้ดจากบริษัทภายนอก
ใช้แต่ RPC สาธารณะที่ฟรี และไม่มีการใช้กุญแจของเชนจริงใด ๆ เลย

เป้าหมายคือ ถ้ามีการโจมตีเกิดขึ้นที่ไหนก็ตาม ทุกเชนควรรู้เร็ว และเชนอื่น กระเป๋าเงิน หรือ dapp ควรป้องกันตัวเองได้อัตโนมัติ
ผู้รัน Neuro และเครือข่ายตรวจโค้ด (audit network) ของ ZETAPHY ตรวจโค้ดกันอยู่แล้ว เครือข่ายภูมิคุ้มกันนำสิ่งที่พวกเขาเห็น
มาทำเป็น **ธงที่ผู้รันซึ่งวางเงินค้ำเห็นตรงกัน** แล้วส่งต่อไป **ทุกเชน** ภายในราวหนึ่งนาที แนบ **วัคซีน** (ตัวตรวจจับที่สร้างจาก
การโจมตีนั้น) ไปกับธงทุกอัน เพื่อให้จับโค้ดที่ก๊อปไปใช้บนเชนอื่นได้ และเผยแพร่ทุกอย่างเป็น **ฟีดแบบไฟล์นิ่ง ฟรี และมีลายเซ็น**
ตัวระบบเองไม่หยุดหรือแช่แข็งอะไรเลย เชน กระเป๋า dapp และ circuit breaker เป็นผู้อ่านแล้วตัดสินใจเอง

| ส่วนประกอบ | อยู่ที่ |
|---|---|
| sentinel ต่อเชน (EVM, Solana, Osmosis/CosmWasm) RPC ที่จำกัดอัตรา และเคอร์เซอร์ที่ทำต่อได้ | `zetaphy-network/src/immune/sentinel.js`, `rpc.js`, `chains.js` |
| ตัวตรวจจับ (คำตัดสินแบบ pure ที่ผู้รันรันซ้ำได้) | `src/immune/detectors.js` |
| ชุดหลักฐาน (JSON แบบ canonical, sha256 = IPFS CIDv1) | `src/immune/evidence.js` |
| วัคซีน (ตรงทุกไบต์ / ลายนิ้วมือ / ความคล้าย / selector; checksum ของ CosmWasm และ Solana) | `src/immune/vaccines.js` (ใช้ `src/vaccine.js` และ `similarity.js` ของ Neuro) |
| ตัวช่วยการเห็นพ้องแบบ k-of-n | `src/immune/agree.js` |
| registry บน ZETAPHY: ติดธงได้จาก quorum ของ NeuroJobs เท่านั้น มีวันหมดอายุ อุทธรณ์ และยกธง | `contracts/ImmuneRegistry.sol` (`ImmuneRegistry`) |
| ตัวกระจาย: ส่งผ่าน Hyperlane เป็นชุด จำกัดแก๊ส และ memo IBC สำหรับ Osmosis | `contracts/ImmuneRegistry.sol` (`ImmuneBroadcaster`) |
| mirror บนเชน EVM อื่นทุกเชน | `contracts/ImmuneMirror.sol` |
| ฝั่งผู้ใช้: `IImmuneFeed`, `ImmuneCheck`, `ImmuneGuard` (`notFlagged(to)`), router ตัวอย่าง | `contracts/ImmuneGuard.sol` |
| วางแผนการกระจาย memo IBC (JS) และแบบจำลองเวลา | `src/immune/propagate.js` |
| ฟีดเปิด (JSON, NDJSON, RSS, Atom, snapshot ลายเซ็น ML-DSA-44) | `src/immune/feed.js`, `scripts/immune-feed.js`, `.github/workflows/immune-feed.yml` |
| SDK สำหรับป้องกัน (`checkAddress`, `advise`, `watchFlags`) | `src/immune/sdk.js` |
| เชนจำลองหลายเชน สถานการณ์โจมตี และ fixture ที่บันทึกไว้ | `src/immune/mockchain.js`, `scenarios.js`, `test/fixtures/immune/` |
| สคริปต์ | `scripts/immune-sentinel.js`, `immune-record.js`, `immune-feed.js`, `immune-sim.js` |
| Hub: แดชบอร์ดแท็บ Immunity และคำเตือนก่อนเซ็น (8 ภาษา ผ่าน CSP) | `zetaphy-hub/assist.js`, `assist-i18n.js`, `hub.js`, `build.mjs` |
| Explorer: ป้ายความเสี่ยงจากเครือข่ายภูมิคุ้มกัน (8 ภาษา) | `zetaphy-explorer/src/risk.js`, `src/config.js` (`immuneFeed`) |
| บันทึกการติดตั้ง (ว่างจนกว่าจะติดตั้ง) | `zetaphy-chain/hyperlane/immune-network.json` |
| เทสต์ | `zetaphy-network/test/immune.test.js`, `test/immune-e2e.test.js`; `zetaphy-hub/test/assist.test.mjs`, `assist.e2e.mjs`; `zetaphy-explorer/test/insight.test.js` |

## สถาปัตยกรรม

```
 เชน A (เชนไหนก็ได้)            ZETAPHY                                        เชน B, C, … (เชนไหนก็ได้)
 ┌──────────────┐  รายงาน   ┌───────────────────────────────────────────┐  Hyperlane  ┌──────────────────────┐
 │ sentinel     │──────────▶│ งาน NeuroJobs ชนิด "immune" (มีค่าธรรมเนียม) │  (ISM ของเรา)│ ImmuneMirror         │
 │ (RPC ฟรี     │ ผลตรวจ +  │  สุ่ม 3 ที่นั่งจากผู้รัน n คนที่วางเงินค้ำ      │────────────▶│  isFlagged(chain,a)  │
 │  จำกัดอัตรา  │ หลักฐาน    │  แต่ละคนรันตัวตรวจจับซ้ำบนหลักฐาน            │             │  isCodeFlagged(h)    │
 │  มีเคอร์เซอร์) │ (IPFS CID)│  commit-reveal; เห็นตรงกัน >= k คน          │             │  อีเวนต์ ThreatFlag    │
 └──────────────┘           │ ImmuneRegistry.attest(job, finding)       │             └─────────┬────────────┘
        ▲                   │ ImmuneBroadcaster.broadcast(keys)         │  IBC (memo ICS-20)    ▼
        │ วัคซีน (จากฟีด)     │  ครั้งละ <= 24 คีย์ x <= 16 เส้นทาง          │──────────▶ mirror     router ที่ใส่
        │                   └───────────────────────┬───────────────────┘  CosmWasm บน Osmosis  ImmuneGuard,
        │                                           │ ทุก 30 นาที (GitHub Action)              กระเป๋า (SDK), breaker
        └──────────── feed.json / ndjson / rss / atom / snapshot.pq.json (branch immune-feed, jsDelivr) ◀─ SDK ใช้เมื่อไม่มี mirror
```

1. **ตรวจจับ** (`sentinel.js`) เชนละหนึ่ง sentinel ดึงข้อมูลจาก endpoint สาธารณะฟรีผ่าน token bucket (ค่าเริ่มต้น 4 คำขอต่อวินาที)
   สลับ endpoint เมื่อเจอ 429/5xx และจำเคอร์เซอร์ (`state.next`) ไว้ ถ้าเครื่องรีสตาร์ตหรือ RPC ล่มก็ไม่พลาดบล็อกไหน
   สิ่งที่มองหา (`detectors.js`):
   - `clone`: สัญญาใหม่ที่ตรงกับวัคซีนที่แชร์มา (โค้ดตรงทุกไบต์ ลายนิ้วมือของ Neuro ความคล้ายของลำดับ opcode หลังตัดส่วนที่
     โค้ดสุจริตทั่วไปมีออก หรือ selector เฉพาะของโค้ดโจมตีเกือบทั้งหมด)
   - `flashloan`: flash loan (Aave v2/v3, Balancer, Uniswap v3) + ราคาในพูลถูกดันไป ≥ 25% ในธุรกรรมเดียว + ผู้เรียกได้กำไรสุทธิ
     สัญญาที่ถูกเรียกคือโค้ดโจมตี ผู้ส่งคือผู้โจมตีบนทุกเชน EVM
   - `outflow`: โปรโตคอลที่เฝ้าดูเสียโทเคนใดโทเคนหนึ่ง ≥ 10% (หรือ 8 เท่าของปกติ) ในบล็อกเดียว และส่วนใหญ่ไปที่ที่อยู่เดียว
   - `drainer`: ผู้ใช้สิทธิ์ (spender) คนเดียวได้ approve แบบไม่จำกัดจากผู้ถือ ≥ 3 คน และกวาดเงินไปแล้ว ≥ 2 คนในช่วงเวลาหนึ่ง
     รวมถึงที่อยู่ที่รับเงินที่กวาดไป
   - `taint`: เงินที่ออกจากผู้โจมตีหรือ drainer ที่ติดธงแล้วไปยังบัญชีใหม่ (ระดับ 2 คือเตือนเท่านั้น ไม่บล็อก)
   - Solana `sol-drainer`: delegate หรือเจ้าของใหม่คนเดียวรับบัญชีโทเคน SPL ของเจ้าของ ≥ 3 คน
   - Osmosis `wasm-clone` (โค้ดที่ instantiate แล้ว checksum ตรงกับวัคซีน) และ `authz-drainer` (ผู้รับสิทธิ์คนเดียวได้
     สิทธิ์ส่งเงินจาก ≥ 3 บัญชี)
   ตัวตรวจจับทุกตัวแยกเป็นตัวเก็บข้อมูล กับ **คำตัดสินแบบ pure จากอินพุตที่ระบุชัด** อินพุตเหล่านั้นอยู่ในชุดหลักฐาน
   ใครก็รันคำตัดสินซ้ำได้โดยไม่ต้องมี RPC
2. **เห็นพ้อง** (`agree.js`, NeuroJobs) sentinel ขอเปิดงาน NeuroJobs ชนิด `immune` โดยมีเป้าหมายเป็น
   `immune:<chainId>:<CID ของหลักฐาน>:<findingHash>` NeuroJobs สุ่ม 3 ที่นั่งด้วยลอตเตอรีจาก block hash จากผู้รันทุกคน
   ที่วางเงินค้ำ (`NeuroControl`) ผู้รันแต่ละคนดึงหลักฐานด้วย content hash ตรวจ hash ตรวจว่าวัคซีนที่แนบมาไม่ถูกแก้
   รันตัวตรวจจับซ้ำ แล้ว commit `findingHash(finding)` ถ้าได้ผลเหมือนกัน หรือ `rejectHash(evidenceHash)` ถ้าไม่ได้
   `ImmuneRegistry.attest(jobId, finding)` ยอมรับเฉพาะงานชนิด `immune` ที่คำตัดสินเป็น `findingHash(finding)` และมีผู้รัน
   เปิดเผยตรงกันอย่างน้อย `minAgreed` คน (k = 2 หรือ 3 จาก 3 ที่นั่ง; n = ผู้รันที่วางเงินค้ำทุกคน)
3. **registry** (`ImmuneRegistry`) ผลตรวจหนึ่งอันตั้งได้สูงสุดสามคีย์ ใช้วิธีสร้างคีย์เดียวกับ `ThreatRegistry`: บัญชีบนเชนของมันเอง
   บัญชีแบบ EOA บน **ทุก** เชน EVM (chain id 0 เพราะกุญแจเดียวกันเซ็นได้ทุกเชน) และ code hash บนทุกเชน แต่ละคีย์มี `kind`,
   `severity` (1 ข้อมูล, 2 น่าสงสัย, 3 สูง, 4 วิกฤต), `since`, `expiresAt` (1-180 วัน), `evidenceHash`, `vaccine` และ `round`
   ที่เพิ่มทุกครั้งที่เปลี่ยน (mirror เก็บ round ล่าสุดเสมอ)
4. **กระจาย** (`ImmuneBroadcaster`, `propagate.js`) ใครก็เรียก `broadcast(keys)` ได้และเป็นคนจ่ายค่า Hyperlane: ส่งหนึ่งข้อความต่อ
   เส้นทาง เฉพาะคีย์ที่เส้นทางนั้นยังไม่มี (ดูจาก round) ครั้งละไม่เกิน 24 คีย์และ 16 เส้นทาง ข้อความคือ
   `abi.encode(4, chainId, items)` (ชนิด 4; NeuroOracle ใช้ 1-3 โดย 3 คือใบรับรองการตรวจโค้ด) ที่ปลายทาง Mailbox ตรวจ
   ISM แบบ multisig ของ validator **ของเรา** เหมือน NeuroOracle และเส้นทาง Saphan แล้วจึงเรียก `ImmuneMirror.handle`
   สำหรับ Osmosis: `pushIbc(keys)` ส่ง ICS-20 ที่มี memo ให้ ibc-hooks ไปเรียก mirror แบบ CosmWasm
   (`cosmwasm/neuro-oracle-osmo` อีกหนึ่ง instance ที่ hook sender เป็นของ broadcaster) สำหรับ Solana: **มีแค่เอกสาร** (ด้านล่าง)
5. **ป้องกัน** router, vault และ bridge สืบทอด `ImmuneGuard` แล้วใส่ `notFlagged(to)`; กระเป๋าและ dapp เรียก SDK;
   circuit breaker ติดตาม `ThreatFlag` หรือถาม `isFlagged` เป็นระยะ; Hub เตือนก่อนเซ็น และ explorer แสดงป้าย
6. **ฉีดวัคซีน** (`vaccines.js`) เมื่อสิ่งที่ติดธงเป็น **สัญญา** โจมตีหรือ drainer sentinel จะสร้างวัคซีนจากโค้ดของมัน ค่า id
   (sha256) คือ `vaccine` ของผลตรวจ ซึ่งผู้รันเห็นพ้องไปพร้อมกัน เก็บไว้กับธงในทุก mirror (`vaccineOf(key)`) ส่วนตัววัคซีนเดินทาง
   ไปกับฟีด sentinel ทุกตัวโหลดแล้วสแกนสัญญาที่เพิ่ง deploy ใหม่ทันที โค้ดที่ถูกแก้แล้ว deploy ใหม่บนเชนอื่นจะถูกจับ แล้วผ่าน
   การเห็นพ้องแบบเดียวกัน

## อินเทอร์เฟซที่ mirror ให้ (สำหรับกระเป๋า router และ circuit breaker)

ทุกฟีด ทั้ง registry บน ZETAPHY และ mirror บนเชนอื่น ตอบ `IImmuneFeed` (`contracts/ImmuneGuard.sol`):

```solidity
event ThreatFlag(uint256 indexed chainId, address indexed subject, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
event CodeThreatFlag(bytes32 indexed codeHash, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
function isFlagged(uint256 chainId, address subject) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
function isCodeFlagged(bytes32 codeHash) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
function live() external view returns (bool);
```

`isFlagged(chainId, a)` ดูทั้งคีย์ของเชนนั้นและคีย์ "ทุกเชน EVM" แล้วคืนอันที่หนักกว่า `flagged = false` เป็นคำตอบของ mirror
ที่หยุดชั่วคราวและธงที่หมดอายุด้วย ส่วน `live()` เป็น false ขณะ mirror หยุดอยู่หรือยังไม่เคยได้รับข้อมูล ผู้ใช้จึงเลือกได้ว่าจะ
ปล่อยผ่าน (fail open) หรือปฏิเสธ (fail closed)

**circuit breaker** (ตัวแบบเลือกใช้ใน `src/selfheal/` มีทีมอื่นสร้างแยก ของผู้ให้บริการไหนก็ใช้แบบเดียวกัน) ใช้ได้สองแบบ
และตัดสินใจเอง:

```solidity
// บนเชน: ก่อนให้เงินออก หรือใน keeper
(bool f, uint8 sev, , bytes32 ev) = IImmuneFeed(mirror).isFlagged(block.chainid, counterparty);
if (f && sev >= 4) breaker.trip(ev); // กฎของ breaker เอง เจ้าของของมันเอง และการปลดของมันเอง
```

```js
// นอกเชน: ติดตามอีเวนต์ (sdk.js watchFlags) แล้วสั่งหยุดหรือแจ้งเตือน
const { events, next } = await watchFlags(send, mirror, { fromBlock });
for (const e of events) if (e.flagged && e.severity >= 4 && watched.has(e.subject)) await breaker.trip(e.evidenceHash);
```

เครือข่ายภูมิคุ้มกันไม่เคยเรียก breaker และ breaker ไม่เคยเขียนฟีด

## SDK สำหรับป้องกัน

```js
import { createImmune } from 'zetaphy-network/src/immune/sdk.js';
const immune = createImmune({
  mirrors: { 84532: { rpc: 'https://sepolia.base.org', address: '0x…ImmuneMirror' } },
  feedUrl: 'https://cdn.jsdelivr.net/gh/pospos191-alt/swd-amm@immune-feed/',
  trustedKeys: ['0x…keyHash ของผู้เซ็นฟีด'],
});
await immune.checkAddress(84532, '0x…');  // { flagged, severity, since, evidenceHash, source: 'mirror' | 'feed' | 'none', … }
await immune.advise(56, '0x…');           // { action: 'block' | 'warn' | 'ok' | 'unknown', … }
```

mirror ของเชนนั้นตอบก่อน (คำตอบเดียวกับที่สัญญาได้) ฟีดตอบเมื่อไม่มี mirror หรือ mirror ล่ม หยุดอยู่ ว่าง หรือเป็นเชนที่ไม่ใช่ EVM
(รองรับบัญชี Solana แบบ base58 และ Cosmos แบบ bech32) ถ้าตั้ง `trustedKeys` ไว้ ฟีดที่ snapshot ลายเซ็น ML-DSA-44
ไม่ผ่านกับกุญแจที่ปักไว้ หรือ hash ไม่ตรงกับฟีด จะถูกปฏิเสธ `source: 'none'` หมายถึงอ่านอะไรไม่ได้เลย ผู้เรียกต้องตัดสินใจเอง

**Solidity**: สืบทอด `ImmuneGuard(feed, minSeverity, failClosed)` แล้วใส่ `notFlagged(to)` ที่ทางออกของเงิน `ImmuneCheck`
อ่านโดยจำกัดแก๊ส (60k ต่อครั้ง) และไม่ revert เมื่อฟีดเสีย ค่าที่แนะนำคือ `minSeverity = 3` (สูง) และ fail-open สัญญาที่ถือเงิน
มากอาจเลือก fail-closed ที่ทางออก `ImmuneGuardedRouter` คือตัวอย่างการใช้งาน

## โมเดลความไว้ใจ

**ใครติดธง** ไม่มีใครทำได้คนเดียว ธงจะมีได้ต่อเมื่องาน NeuroJobs ชนิด `immune` ได้ quorum แล้วเท่านั้น: 3 ที่นั่งที่ลอตเตอรีของ
NeuroJobs สุ่มจากผู้รันทุกคนที่วางเงินค้ำ (รวมกฎที่นั่ง defender และการกักตัว) และมีอย่างน้อย `minAgreed` คน (ค่าเริ่มต้น 2 หรือ 3
สำหรับการติดตั้งที่เข้มกว่า) เปิดเผย `findingHash` เดียวกัน ผู้รันแต่ละคนรันตัวตรวจจับซ้ำบนหลักฐานที่อ้างด้วย content hash
จึงไม่ต้องเชื่อ sentinel ผู้ขอ หรือผู้รันคนอื่น governance ติดธงไม่ได้ (ไม่มีฟังก์ชันนี้) ทำได้แค่ **คุ้มครอง** คีย์ (เช่นสัญญาของ
bridge เอง) ซึ่งจะยกธงบนคีย์นั้นด้วย คีย์ที่ `ThreatRegistry` คุ้มครองก็ถูกคุ้มครองที่นี่ด้วย

**ติดธงผิดต้องเสียเงินค้ำ** ธงเป็นแบบ *ชั่วคราว* ระหว่างที่ช่วงท้าทายของงานยังเปิดอยู่ (`provisional(key)` และฟีดก็บอกไว้)
ใครก็ท้าทายใน NeuroJobs ได้ด้วยคำตัดสินแบบปฏิเสธ และวางเงินอย่างน้อย 2 เท่าของค่าธรรมเนียม ผู้รันชุดใหม่ (ไม่ใช่ที่นั่งรอบแรก
และไม่ใช่ผู้ท้าทาย) รันหลักฐานซ้ำ ถ้าพลิกคำตัดสิน ผู้รันรอบแรกทุกคนที่เปิดเผยคำตัดสินผิดจะเสีย **50% ของเงินค้ำ**
(`CHALLENGE_SLASH_BPS`) ครึ่งหนึ่งให้ผู้ท้าทาย อีกครึ่งให้ที่นั่งที่ซื่อตรงในรอบนั้น และโดนนับความผิดหนึ่งครั้ง (ผิดสองครั้งในห้าที่นั่ง
ถูกกักตัว) จากนั้น `ImmuneRegistry.lift(key)` ยกธง และการ broadcast ครั้งถัดไปยกธงในทุก mirror ผู้ท้าทายที่ผิดจะเสียเงินที่วาง
ในการจำลอง ที่นั่งสองที่ฮั้วกันติดธงที่อยู่บริสุทธิ์ ที่นั่งที่สามซึ่งซื่อตรงปฏิเสธ มีผู้ท้าทายพลิกคำตัดสิน เงินค้ำของผู้ฮั้วทั้งสองลดจาก
100 เหลือ 50 ZETAPHY และธงหายไปจากเชน B ภายใน 26 วินาทีจำลองหลังเริ่มท้าทาย

**การเซ็นเซอร์และการอุทธรณ์** ไม่มีใครห้ามคนอื่นขอเปิดงานได้ ค่าธรรมเนียมเป็นด่านเดียว และลอตเตอรีเป็นผู้เลือกว่าใครได้นั่ง กลุ่มที่
จะเลือกที่นั่งเองได้ต้องถือเงินค้ำส่วนใหญ่ของระบบ ธงที่ยืนอยู่ยังอุทธรณ์ทีหลังได้ด้วยงานชนิด `immune-clear` (คำตัดสิน
`clearHash(key, round)`) เช่นเมื่อโปรโตคอลได้เงินคืนแล้วหรือสัญญาเปลี่ยนเจ้าของ ใช้กฎ quorum เดียวกัน ธงทุกอันยังหมดเองที่
`expiresAt` (1-180 วัน: drainer 180, โค้ดโจมตี 90, ที่อยู่ที่เชื่อมโยง 30) ทุก view ถือว่าธงที่หมดอายุไม่ติดธงแล้ว และ `lift(key)`
(ใครก็เรียกได้) เพิ่ม round เพื่อให้ mirror ที่ไม่หมดอายุเอง (ตัว CosmWasm) รู้ด้วย ระดับ 2 (taint) เป็นแค่คำเตือน
`ImmuneGuard` ปฏิเสธที่ระดับ 3 ขึ้นไปโดยค่าเริ่มต้น

**การส่ง** mirror เชื่อที่อยู่ของ broadcaster บน ZETAPHY และ ISM ของ validator ของเรา round เก่าหรือข้อความซ้ำไม่เปลี่ยนอะไร
guardian หยุด mirror ชั่วคราวได้ (governance เป็นผู้ปลด) ระหว่างหยุดจะตอบว่า "ไม่ติดธง" และ `live() = false` ฟีดเป็นสำเนา
เพื่อความสะดวกที่เซ็นด้วย ML-DSA-44 แหล่งความจริงคือ registry และ mirror

**สิ่งที่ระบบไม่ทำ** ไม่แช่แข็งเงิน ไม่หยุดสัญญา และไม่ย้อนธุรกรรมที่ไหนเลย ระบบแค่บอกผลตรวจที่ทำซ้ำได้เกี่ยวกับที่อยู่หรือ
code hash จะทำอะไรต่อเป็นเรื่องของแต่ละเชน โปรโตคอล และกระเป๋า ถ้อยคำทุกที่เป็นกลาง (การเจาะระบบ drainer รูปแบบโค้ดอันตราย
ที่รู้จัก) ไม่กล่าวหาตัวบุคคล

## เวลาที่ใช้ (จำลอง)

ในสภาพแวดล้อมที่สร้างงานนี้ RPC สาธารณะถูกบล็อก (proxy ตอบ 403 ทุก endpoint ที่ลอง: publicnode, base.org, Solana devnet,
Osmosis LCD) ตัวเลขทั้งหมดด้านล่างจึงเป็น **วินาทีจำลอง** ไม่ใช่การวัดจริง

end to end บน EVM ในหน่วยความจำที่รันสัญญาจริง (`test/immune-e2e.test.js`, `node scripts/immune-sim.js`) ใช้นาฬิกาเดียว
แต่ละขั้นคิดเวลาตามที่ใช้บนเชนจริง (บล็อก ZETAPHY 5 วินาที validator เซ็น 1 วินาที relayer 3 วินาที และบล็อกของเชนปลายทาง):

| ขั้น | วินาที |
|---|---|
| บล็อกที่โจมตีบน Sepolia → sentinel รายงาน (poll ทุก 6 วินาที + คำขอ) | 5.5 |
| การเห็นพ้องใน NeuroJobs **สอง** ผลตรวจ (สัญญาโจมตี + ผู้โจมตี) ทำทีละอัน | 32 |
| `attest` × 2 | 10 |
| broadcast → mirror บน Base Sepolia / Arbitrum Sepolia | +11 / +10 |
| **โจมตี → เชน B / C ตอบว่าติดธง** | **58.5 / 57.5** |
| deploy โค้ดก๊อปบน C → ถูกจับ (วัคซีน) → ติดธงใน mirror ของ C | 32.6 |
| ธงผิดถูก broadcast → ถูกท้าทาย พลิก และยกธงบน B | 26 |

แบบจำลองแบบกำหนด seed ครอบคลุมทุกเชน (`propagate.js simulate` 300 รอบ seed 11 โจมตีบน Sepolia มีความแปรปรวนของการ poll การรันซ้ำ
ของผู้รัน การเซ็น การ relay และ IBC): **มัธยฐาน 53.5 วินาที p90 61.1 วินาที** แยกเป็นตรวจจับ 11.1 วินาที เห็นพ้อง 25 วินาที
registry 5 วินาที Osmosis (IBC) ช้ากว่าเส้นทาง Hyperlane ไม่กี่วินาที

**แก๊ส** `broadcast` มีขอบเขตตั้งแต่ออกแบบ (≤ 24 คีย์ × ≤ 16 เส้นทาง) วัดกับ Mailbox ที่แค่ปล่อยอีเวนต์ได้: 67k (1 คีย์ 1
เส้นทาง) 824k (24 × 1) 1.09M (8 × 4) 13.85M (24 × 16) `broadcastGas()` เป็นขอบบนที่เทสต์ตรวจแล้ว ส่วน `planBatches()` ลดขนาด
ชุดให้แต่ละครั้งไม่เกิน 12M รวมค่าใช้จ่ายของ Mailbox จริงต่อการส่ง (สมมติ ~150k) ใน e2e ใช้ Mailbox ทดสอบที่เก็บข้อความไว้ด้วย
(1.54M สำหรับ 4 คีย์ × 2 เส้นทาง)

## อะไรจริง อะไรจำลอง

| | สถานะ |
|---|---|
| สัญญา (registry, broadcaster, mirror, guard, router) | คอมไพล์และทดสอบในหน่วยความจำร่วมกับ NeuroJobs, NeuroControl และ Mailbox + ISM แบบ multisig ของ Hyperlane; **ยังไม่ได้ติดตั้ง** |
| sentinel บน RPC สาธารณะฟรี | โค้ดพร้อม (`scripts/immune-sentinel.js --chains …`); **ยังไม่ได้ทดสอบกับของจริงที่นี่** (endpoint สาธารณะถูกบล็อกทั้งหมด: 403) |
| ตัวตรวจจับ | ทดสอบบนเชนจำลองหลายเชน (EVM, Solana, Osmosis) และ fixture ที่บันทึกไว้ (`test/fixtures/immune/sepolia-attacks.json` บันทึกจากสถานการณ์จำลอง; `scripts/immune-record.js --live <chain>` บันทึกจากของจริงได้) |
| การกระจายผ่าน Hyperlane | จำลองด้วย Mailbox + ISM ทดสอบ (checkpoint ที่เซ็นโดย validator ทดสอบ) |
| Osmosis (IBC) | memo ถูกสร้างบนเชนและตรงกับรูปแบบของ mirror CosmWasm (ทดสอบแล้ว) แต่ยังไม่ได้ส่งผ่าน IBC จริง |
| Solana | sentinel และตัวตรวจจับทดสอบบนเชนจำลอง; **ยังไม่มี mirror บน Sealevel** ผู้ใช้ Solana ใช้ฟีดผ่าน SDK |
| ฟีด | สร้างและเซ็นด้วย ML-DSA ในเทสต์; Action เขียนไว้แล้วแต่ยังไม่เคยรัน (ต้องอยู่บน branch หลัก) |
| Hub / explorer | แดชบอร์ด คำเตือนก่อนเซ็น และป้าย ทดสอบกับข้อมูลปลอมและใน browser e2e ของ hub (สถานะยังไม่ติดตั้ง) |

### เส้นทาง Solana (มีแค่เอกสาร ยังไม่ได้สร้าง)

Mailbox ของ Hyperlane บน Sealevel ส่ง body เดียวกัน (`abi.encode(4, chainId, items)`) ไปยังโปรแกรม Solana ที่ตรวจ ISM
multisig ชุดเดียวกัน และเก็บ `key → (round, flagged, severity, since, expiresAt, evidenceHash)` ใน PDA หนึ่งอันต่อคีย์
(`seeds = ["immune", key]`) โดย round ใหม่สุดชนะ โปรแกรมหรือกระเป๋าบน Solana อ่าน PDA ของ `accountKey(1399811149, pubkey)`
(และ `codeKey` ของ hash ข้อมูลโปรแกรม) ระหว่างที่ยังไม่มี กระเป๋าและ dapp บน Solana ใช้ฟีดที่มีลายเซ็นผ่าน SDK
(`checkAddress(1399811149, '<base58>')`)

## คนอื่นเข้าร่วมอย่างไร

- **รัน sentinel** (ใครก็ได้): `node scripts/immune-sentinel.js --chains sepolia,basesepolia --feed <url ของฟีด>` รายงานจะอยู่ใน
  `.immune/reports/<cid>.json` พร้อมเป้าหมายของงาน ปักหลักฐานไว้บนโหนด IPFS ใดก็ได้ แล้วขอเปิดงาน (ค่าธรรมเนียม ≥ `minFee`)
  เพิ่มเชนใหม่ใน `src/immune/chains.js` พร้อม endpoint ฟรีของมัน
- **เป็นผู้รัน**: วางเงินค้ำใน NeuroJobs (`register()`) ให้ governance อนุมัติชนิดงาน `immune` และ `immune-clear` ใน NeuroControl
  แล้วลงคะแนนด้วย `runnerVote(report, { vaccines })`
- **เพิ่มตัวตรวจจับ**: ฟังก์ชันคำตัดสินแบบ pure ใน `detectors.js` พร้อมตัวเก็บข้อมูล และลงทะเบียนใน `VERDICTS` ให้ผู้รันรันซ้ำได้
  ตั้งเกณฑ์แบบระมัดระวังไว้ เพราะธงผิดทำให้ผู้รันที่เห็นด้วยเสียเงิน
- **เพิ่ม mirror ของเชน**: deploy `ImmuneMirror(mailbox, 77390, 77390, broadcaster, ism, governance, guardian)` แล้วให้ governance
  เรียก `ImmuneBroadcaster.setReceiver(domain, mirror)` และบันทึกใน `zetaphy-chain/hyperlane/immune-network.json`
  (hub และฟีดจะอ่านเอง)
- **ป้องกันโปรโตคอล**: สืบทอด `ImmuneGuard` กับ mirror บนเชนของคุณ หรือเรียก SDK และให้ circuit breaker ติดตาม `ThreatFlag`
- **อ่านฟีด**: `feed.json` / `feed.ndjson` / `rss.xml` / `atom.xml` บน branch `immune-feed` ตรวจ `snapshot.pq.json` ด้วย
  `verifySnapshot(feed, snapshot, { trustedKeys })` หรือตัวตรวจ PQ ใน hub

## ข้อจำกัด

- ยังไม่ได้ติดตั้ง เวลาทั้งหมดเป็นค่าจำลอง และไม่มี endpoint สาธารณะไหนเข้าถึงได้จากที่นี่
- ตัวตรวจจับเป็น heuristic ที่ตั้งเกณฑ์ไว้อย่างระมัดระวัง: จะพลาดการโจมตีที่ไม่ได้ดันราคาพูลภายในธุรกรรมเดียว drainer ที่ใช้ลายเซ็น
  `permit` โดยไม่มีอีเวนต์ `Approval` ก่อน และการดูดเงินช้า ๆ ที่ต่ำกว่าเกณฑ์ outflow ความคล้ายอาจถูกหลบได้ด้วยการอำพรางโค้ดหนัก ๆ
  แต่การตรงทุกไบต์และลายนิ้วมือหลบไม่ได้
- การเห็นพ้องใช้เวลาราว 4-5 บล็อกของ ZETAPHY ต่อผลตรวจ ผลตรวจหลายอันของการโจมตีครั้งเดียวเป็นงานแยกกัน (ในทางปฏิบัติรัน
  พร้อมกัน ในการจำลองรันทีละอัน)
- mirror เชื่อ ISM ของชุด validator ของเรา (เหมือนเส้นทาง NeuroOracle ที่มีอยู่) ถ้าเสียงข้างมากของชุดนี้ถูกยึด อาจเขียนสถานะผิดลง
  mirror ได้จนกว่า governance จะเปลี่ยน ISM ผู้ที่ต้องการมากกว่านั้นอ่าน registry บน ZETAPHY โดยตรง หรือบังคับให้ต้องมีลายเซ็นฟีดด้วย
- ตัวตรวจ flash loan อ่านราคาจากอีเวนต์ `Sync` แบบ Uniswap v2 AMM แบบอื่นต้องมีอีเวนต์ราคาของมันเอง
- `pushIbc` อาศัย precompile ICS-20 ของ ZETAPHY และช่อง IBC ไป Osmosis ซึ่งยังไม่ได้ทดสอบในเทสต์
