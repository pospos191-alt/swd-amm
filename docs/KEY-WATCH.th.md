[English](KEY-WATCH.md) | **ภาษาไทย**

# Key watch: รู้ตัวเร็วเมื่อคีย์ถูกขโมย ขณะที่ยังมีเวลา veto

การกระทำระดับผู้ดูแลทุกอย่างบน ZETAPHY ต้องรอใน timelock (48 ชม.) และการปล่อยเงินของบริดจ์ทุกครั้งต้องรอช่วงเวลาที่ guardian veto ได้
แต่สิ่งนี้จะปกป้องเราได้ก็ต่อเมื่อมีคน **สังเกตเห็น** ทันเวลา Key watch คือตัวเฝ้าดูแบบอ่านอย่างเดียว ฟรี ที่เปลี่ยนสัญญาณแรกของคีย์ที่ถูกขโมย
ให้เป็น GitHub issue เพื่อให้ GitHub ส่งอีเมล/แจ้งเตือนในแอปถึงเจ้าของภายในราว 15 นาที

- Workflow: [`.github/workflows/key-watch.yml`](../.github/workflows/key-watch.yml) ทุก 15 นาที (สั่งเองได้: Actions → key-watch → Run workflow)
- สคริปต์: [`zetaphy-network/scripts/key-watch.js`](../zetaphy-network/scripts/key-watch.js)
- รายการที่เฝ้าดู: [`zetaphy-network/key-watch.json`](../zetaphy-network/key-watch.json)
- เทสต์: `cd zetaphy-network && node --test test/keywatch.test.js`

ฟรี: ใช้ RPC สาธารณะเท่านั้น ไม่มี secret ไม่มีบริการเสียเงิน โทเคนเดียวคือ `GITHUB_TOKEN` ในตัวของ workflow ที่มีสิทธิ์
`issues: write` เท่านั้น ใช้กับ testnet เท่านั้น

## เฝ้าดูอะไรบ้าง

เชน: **ZETAPHY testnet** (77390, `https://rpc.sawasdeecoin.com`), **Sepolia**, **Base Sepolia**, **Arbitrum Sepolia**
RPC และ explorer มาจาก [`zetaphy-chain/hyperlane/saphan-chains.json`](../zetaphy-chain/hyperlane/saphan-chains.json)
(มีหลาย RPC ต่อเชน: ถ้าตัวหนึ่งล่มจะลองตัวถัดไป)

| ใคร | ที่ไหน | อะไรทำให้เกิดการแจ้งเตือน |
|---|---|---|
| Deployer `0x6af57fC3…2A245` | ทุกเชน | ธุรกรรมใหม่ใด ๆ (nonce เพิ่ม), ยอดคงเหลือลดลง |
| Hyperlane validator ของ ZETAPHY `0x80b654fd…5019Bc` | ทุกเชน | ธุรกรรมใหม่ใด ๆ, ยอดคงเหลือลดลง |
| เจ้าของ guardian multisig `0xeBc7EAcf…99d1b`, `0x6138233a…3b5ec` | ทุกเชน | ธุรกรรมใหม่ใด ๆ, ยอดคงเหลือลดลง |
| ZetaphyTimelock `0x731db924…90340` | ZETAPHY | `CallScheduled`, `CallExecuted`, `Cancelled`, `MinDelayChange`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` |
| Guardian multisig `0x5bcC8290…17Eb5` | ZETAPHY | `Proposed`, `Confirmed`, `Executed` |
| BridgeGuard, BridgeAirlock, HyperlaneLane, NeuroLane | ZETAPHY | `Paused`/`Unpaused`, `Vetoed`, `Tripped`/`Untripped`, `GovernanceSet`, `GuardianSet`, `VetoerSet`, `MarkerSet`, `LaneSet`, `IsmSet`, `ThresholdSet`, `RouteSet`, การเปลี่ยนเพดาน/ดีเลย์, ยอดลดลง |
| NeuroControl, ThreatRegistry, RewardVault, StableGateway, NeuroIdentity, ZetaphyOracle, PythRelay, factory ของ DEX / DLMM, ตลาด NFT | ZETAPHY | อีเวนต์ governance / guardian / pause ชุดเดียวกัน, `FeedPaused`, `CircuitBreakerTripped`, `OwnershipTransferred`, `Upgraded` |
| HyperlaneLockBox v1 `0xc0081832…b23c6` (เส้นทางปิดอยู่) | Sepolia | `Paused`/`Unpaused`, `ReleaseVetoed`, `VetoLifted`, `IsmSet`, `GuardianSet`, `DailyLimitSet`, …, ยอดลดลง |
| เส้นทาง Saphan v2 (lockbox, multisig และ timelock ของมัน; vault และ synthetic ของโทเคน) | แต่ละเชน | เพิ่ม **อัตโนมัติ** จาก [`saphan-routes.json`](../zetaphy-chain/hyperlane/saphan-routes.json) เมื่อ workflow saphan-route deploy แล้ว ก่อนหน้านั้นไม่มีอะไรให้เฝ้าดู |

ชื่ออีเวนต์ตรงกับใน `zetaphy-network/contracts/*.sol` และ OpenZeppelin 5.4 (TimelockController, AccessControl, Ownable,
Pausable) ทราฟฟิกปกติ (การโอนผ่านบริดจ์, `Transfer`, `Poked`, …) ไม่แจ้งเตือน

ระดับความรุนแรง: **CRITICAL** = คีย์ที่เฝ้าดูเซ็นธุรกรรม, มีการ schedule call ใน timelock, role / owner / governance / guardian / lane / ISM
เปลี่ยน, veto ถูกยกเลิก **HIGH** = pause/unpause, veto, call ที่ execute/cancel, การเปลี่ยนเพดาน, ยอดลดลง, ข้อเสนอของ multisig
**WARNING** = ตัวเฝ้าดูตามหลังมากจนต้องข้ามบล็อก

**Validator (ไม่บังคับ)** ถ้าตั้ง `"rest"` (Cosmos REST ของโหนด เช่น `https://rpc.sawasdeecoin.com/rest`) และ `"validators"`
(`zetaphyvaloper1…`) ใต้ `chains.zetaphy` จะแจ้งเตือนเมื่อ validator ถูก jail หรือสถานะ bonded เปลี่ยน และทุกครั้งที่มี gov proposal ใหม่
ซึ่งสำคัญ: บน ZETAPHY ผู้เสนอของ timelock คือ **gov module** และ log ของ `MsgEVMCall` ใน gov proposal มองไม่เห็นผ่าน `eth_getLogs`
proposal ใหม่จึงเป็นสัญญาณแรกสุด

**ZETAPHY หยุดพักถึง 1 พ.ย. 2026** `quietUntil` ทำให้ตัวเฝ้าดูเงียบเรื่องเชนนี้จนถึงวันนั้น หลังจากนั้น เชนที่ติดต่อไม่ได้จะแจ้งไม่เกินวันละครั้ง (ดูด้านล่าง)

## การแจ้งเตือนมาถึงคุณอย่างไร

- การแจ้งเตือนทั้งหมดของแต่ละรอบไปอยู่ใน **issue ที่เปิดอยู่หนึ่งอันซึ่งมี label `security-alert`**: เป็นคอมเมนต์ หรือเปิด issue ใหม่ถ้ายังไม่มี
  GitHub จะแจ้งเจ้าของ (อีเมล / แอป; ตรวจ *Settings → Notifications* และให้แน่ใจว่า watch repository นี้อยู่)
- ทุกการแจ้งเตือนมีเครื่องหมายซ่อน (`<!-- key-watch:… -->`) จึงไม่โพสต์เหตุการณ์เดิมซ้ำ แม้ state ที่บันทึกไว้จะหายไป ปิด issue เมื่อจัดการแล้ว
  การแจ้งเตือนถัดไปจะเปิด issue ใหม่
- ทุกการแจ้งเตือนมีลิงก์ explorer (address, tx, block), ผู้ส่งธุรกรรม, อาร์กิวเมนต์ที่ถอดแล้ว และสำหรับ `CallScheduled` คือ
  **เวลาที่ call นั้น execute ได้**: นั่นคือเส้นตายของคุณ
- เชนที่ไม่มี RPC ตอบนานกว่าหนึ่งชั่วโมง จะได้ **คอมเมนต์ไม่เกินวันละครั้ง** ใน issue แยกที่มี label `key-watch-health` ("key-watch can't reach X")
- รอบแรก (หรือหลัง cache ถูกลบ): บันทึกค่าฐาน ไม่แจ้งเตือน ถ้าต้องการย้อนดู: *Run workflow* ใส่ `lookback` = จำนวนบล็อกที่จะสแกนย้อน

state (บล็อกล่าสุด, nonce, ยอดคงเหลือ, สิ่งที่แจ้งไปแล้ว) อยู่ใน Actions cache (`key-watch-state-*`) และบันทึกเฉพาะเมื่อรอบนั้นสำเร็จ:
ถ้าโพสต์การแจ้งเตือนไม่สำเร็จ รอบถัดไปจะพบการแจ้งเตือนเดิมอีกครั้ง

> หมายเหตุ: ถ้า repository นี้เป็นสาธารณะ issue เหล่านี้ก็เป็นสาธารณะ ข้อมูลในนั้นเป็นข้อมูลบนเชนที่เปิดเผยอยู่แล้ว ของ address ที่ commit ไว้ที่นี่แล้ว

## การเพิ่มหรือเปลี่ยนสิ่งที่เฝ้าดู

แก้ [`zetaphy-network/key-watch.json`](../zetaphy-network/key-watch.json) ผ่าน pull request:

```json
{ "address": "0x…", "label": "มันคืออะไร", "kind": "eoa" }
```

- `everyChain`: คีย์ที่เฝ้าดูบนทุกเชน (deployer, validator, เจ้าของ multisig)
- `chains.<name>.watch`: เฉพาะเชนเดียว `kind`: `eoa` (nonce + ยอด), `timelock`, `multisig`, `bridge`, `contract` (อีเวนต์ + ยอด)
- **ธุรกรรมที่วางแผนไว้** จากคีย์ที่เฝ้าดู (deploy, การ confirm ใน multisig): ตั้ง `"expectNonceUpTo": N` ในรายการนั้นก่อน (nonce ที่คีย์จะไปถึง)
  หรือ `"allowOutgoing": true` สำหรับคีย์ที่ส่งธุรกรรมเป็นประจำ (จะแจ้งเฉพาะยอดลดลง) ทางที่ดีกว่า: ปล่อยให้แจ้งเตือน แล้วตอบรับใน issue
- เชนใหม่: เพิ่มใน `saphan-chains.json` (RPC, explorer) และเพิ่มรายการใต้ `chains` ที่นี่
- ค่าเกณฑ์ใน `defaults`: `balanceDropPct` (10), `balanceDropMin` (0.05 เหรียญ native), `confirmations`, `logChunk`, `maxBlocksPerRun`,
  `rpcDownNoticeHours` (24), `rpcDownGraceMinutes` (60)
- ทดสอบในเครื่อง (อ่านอย่างเดียว พิมพ์ออกมาแทนการโพสต์): `cd zetaphy-network && node scripts/key-watch.js --dry-run`

## เมื่อมีการแจ้งเตือน

ก่อนอื่น: **เป็นคุณทำเองหรือไม่?** การ deploy ที่วางแผนไว้, การ confirm multisig ที่คุณทำ, call ใน timelock ที่ทีมเสนอ: ตอบใน issue แล้วปิด
ถ้าไม่ใช่ ให้ถือว่าคีย์ถูกขโมยและทำตามลำดับนี้ ห้ามวางคีย์หรือ seed phrase ที่ไหนทั้งสิ้น (แชท, issue, commit)

1. **หยุดเงินก่อน (guardian ไม่ต้องรอ)** การกระทำของ guardian มีแต่ลดความเสี่ยง จึงไม่ต้องรอ:
   - pause บริดจ์: `zetaphy bridge pause` (BridgeGuard; airlock และ lane ตามไปด้วย), lockbox / token vault: `pause()` จาก guardian multisig ของมัน
   - veto การปล่อยที่รอคิว: `BridgeAirlock.veto(id, reason)`, `HyperlaneLockBoxV2.veto(id)`, `SaphanTokens.veto(id)` —
     id อยู่ในการแจ้งเตือน (`ReleaseQueued` / `Queued`) หรือบน explorer
   - pause NeuroControl (`zetaphy neuro send pause`), price feed (`zetaphy oracle pause <asset>`)
   บน ZETAPHY guardian คือ multisig `0x5bcC8290…`: เจ้าของคนหนึ่งเสนอ อีกคน confirm
2. **ยกเลิก call ที่ schedule ไว้ก่อนเวลาที่มันพร้อม** `zetaphy timelock status <id>` แสดงรายละเอียด
   `zetaphy timelock cancel <id>` พิมพ์ call สำหรับผู้ที่ถือ `CANCELLER_ROLE`: บน ZETAPHY คือ gov module (gov proposal: เริ่ม **ทันที**
   เพราะการโหวตใช้เวลา), บนเชนต้นทางคือ SimpleMultisig ของเชนนั้น ถ้ายกเลิกไม่ทันเวลา การ pause ในข้อ 1 ยังคงอยู่: มีแต่ governance ที่ unpause ได้
3. **เปลี่ยนคีย์**
   - Deployer / คีย์ที่เป็น repository secret (`ZETAPHY_DEPLOYER_KEY`, `ZETAPHY_VALIDATOR_KEY`, คีย์ของ monitor): สร้างคีย์ใหม่แบบออฟไลน์
     แทนที่ repository secret ย้ายสิ่งที่เหลือออกจาก address เดิม คีย์นี้ไม่ควรถือ role ใด ๆ (ตอน launch ส่งทุกอย่างให้ timelock แล้ว)
     ตรวจด้วย `zetaphy timelock status`
   - Hyperlane validator: คีย์ใหม่ → เพิ่มใน `zetaphyValidators` ใน `saphan-chains.json` แล้ว governance ตั้ง ISM ใหม่บนทุก lockbox / lane
     (คีย์เก่าเซ็นการปล่อยปลอมได้จนกว่าจะเปลี่ยน: ให้เส้นทาง pause ไว้)
   - เจ้าของ multisig: เจ้าของคนอื่น pause; เปลี่ยนเจ้าของด้วย multisig ใหม่ + governance (เจ้าของ SimpleMultisig เปลี่ยนไม่ได้)
     การเปลี่ยน `GuardianSet` / role ใน timelock จะต้องรอดีเลย์
4. **บันทึกไว้**: เกิดอะไรขึ้น คีย์ไหน pause อะไรไป แล้ว unpause ผ่าน governance เมื่อปลอดภัย

## ข้อจำกัด

- ตรวจทุก 15 นาที (GitHub อาจหน่วงรอบที่ตั้งเวลาไว้หลายนาที): ขโมยที่เร็วอาจย้ายยอดจาก hot key ก่อนคุณอ่านอีเมล
  สิ่งที่ปกป้องคือดีเลย์: timelock 48 ชม., ดีเลย์การปล่อยของบริดจ์ ตัวเฝ้าดูแค่ทำให้คุณรู้ทันเวลา
- การตั้งเวลาทำงานบน default branch เท่านั้น จะเริ่มเมื่อ merge workflow นี้เข้าไปแล้ว
- RPC สาธารณะจำกัด `eth_getLogs` จึงสแกนเป็นช่วง (`logChunk`) ช่วงที่ล้มเหลวจะลองใหม่รอบถัดไป
- ถ้าตามหลังมากกว่า `maxLagBlocks` (เช่น หลังล่มนาน): จะกระโดดไปข้างหน้าและโพสต์ WARNING พร้อมช่วงบล็อกที่ข้ามไป
