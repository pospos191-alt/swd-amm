# ZETAPHY Saphan Gateway: เรียกสัญญาบนอีกเชนได้ในธุรกรรมเดียว (เครือข่ายทดสอบ)

**ใช้บนเครือข่ายทดสอบเท่านั้น ยังไม่ผ่านการตรวจสอบ (audit) และยังไม่ได้ติดตั้งจริง** เกตเวย์ (Gateway) วางอยู่บนเส้นทาง EVM
แต่ละเส้นของ Saphan (docs/SAPHAN-MULTICHAIN.md: Sepolia, Base Sepolia, Arbitrum Sepolia <-> ZETAPHY 77390 ผ่าน Hyperlane)
ทำให้ธุรกรรมเดียวทั้งย้าย ETH ของเส้นทาง **และ** เรียกสัญญาอีกฝั่งได้ และถ้าการเรียกล้มเหลว เงินจะคืนให้เองโดยอัตโนมัติ

ต้นฉบับที่ถือเป็นหลัก: `zetaphy-network/contracts/SaphanGateway.sol` (สัญญา) และ `zetaphy-network/src/saphangateway.js`
(รูปแบบคำสั่งเรียก แฮช ที่อยู่ฝาก และแผนของผู้รันคำสั่ง) ชุดทดสอบ: `zetaphy-network/test/saphangateway.test.js`

## ทำอะไรได้

เชนต้นทาง X แต่ละเชนมีสองสัญญา: `SaphanSourceGateway` บน X และ `ZetaphyGateway` บน ZETAPHY ทั้งคู่ไม่แก้อะไรในเส้นทางที่อยู่ข้างใต้
(lockbox, lane, airlock, guard, outbox) เกตเวย์เป็นแค่ผู้ใช้เส้นทางอีกรายหนึ่ง

| ทิศทาง | สิ่งที่คุณเรียก | สิ่งที่เกิดขึ้น |
|---|---|---|
| X -> ZETAPHY | `SaphanSourceGateway.depositAndCall(...)` บน X จ่ายจำนวนที่จะย้าย + `quoteDeposit(amount)` เป็น ETH | ETH ถูกล็อกใน lockbox ของเส้นทาง เมื่อผ่านการตรวจตามปกติของเส้นทางแล้ว token(X) (`sepETH`, `baseETH`, `arbETH`) จะถูกสร้างบน ZETAPHY จากนั้นผู้รันคำสั่ง (executor) รันคำสั่งเรียก: สัญญาปลายทางได้รับโทเคนและ `onSaphanCall(...)` |
| ZETAPHY -> X | `ZetaphyGateway.withdrawAndCall(...)` บน ZETAPHY หลัง approve token(X) แล้ว; `msg.value` = `quoteWithdraw(amount)` เป็น ZTPHY | token(X) ถูกเผาผ่าน outbox ของเส้นทาง หลังช่วงรอของ lockbox ETH จะถูกจ่ายบน X จากนั้นผู้รันคำสั่งรันคำสั่งเรียก: สัญญาปลายทางได้รับ ETH พร้อม `onSaphanCall(...)` |

**การคืนเงิน** ถ้าการเรียกล้มเหลว (สัญญาปลายทาง revert หรือใช้แก๊สเกิน `gasLimit`) จะไม่มีอะไรหาย:

- X -> ZETAPHY: โทเคนกลับไปหา `revertTo` บน X ผ่าน outbox ของเส้นทาง (เป็น ETH หลังช่วงรอของ lockbox) ถ้าตั้ง `callOnRevert`
  การคืนเงินจะเรียก `revertTo.onSaphanRevert(sender, nonce, revertMessage)` บน X ด้วย ถ้าการเรียกนั้นล้มเหลวอีก ETH จะถูกเก็บไว้ให้
  `revertTo` มารับเองด้วย `SaphanSourceGateway.claim()`
- ถ้าทางกลับปิดอยู่ (เส้นทางขาออกปิด หยุดชั่วคราว เกินเพดานรายวัน หรือถูกพักไว้) โทเคนจะรออยู่บน ZETAPHY ให้ `abortTo`
  มารับเองด้วย `ZetaphyGateway.claimAborted()`
- ZETAPHY -> X: ETH ถูกเก็บไว้ให้ `revertTo` บน X (`owed[revertTo]`) และรับได้ด้วย `SaphanSourceGateway.claim()`
  เป็นแบบให้เจ้าของมารับเอง ไม่ส่งออกไปเอง: Gateway จ่าย ETH ให้เฉพาะผู้ที่เรียกมันเท่านั้น

**ไม่ต้องมีเหรียญค่าแก๊สปลายทาง (gas abstraction)** ผู้เรียกกำหนด `maxFee` เอง ผู้รันคำสั่งได้ค่าตอบแทนเท่ากับ `maxFee` พอดี
หักจากจำนวนที่ย้าย: เป็น token(X) บน ZETAPHY หรือเป็น ETH บน X ผู้ใช้จึงไม่ต้องถือเหรียญค่าแก๊สของเชนปลายทางเลย
ผู้รันคำสั่งออกค่าแก๊สให้ก่อน แล้วได้คืนจากเงินที่ย้าย

```
 เชนต้นทาง X                                                         ZETAPHY (77390)
 ───────────                                                         ───────────────
 ผู้ใช้ ── depositAndCall(target, data, amount, maxFee, ...) ──┐
 SaphanSourceGateway: h = hash(คำสั่งเรียก)                     │
   lockbox.lock(to = depositAddress(h)) ── Hyperlane ─────────┼──▶ 2 เลน + ช่วงกักไว้ตรวจ + Neuro + เพดาน
                                                              │    BridgeGuard(X) สร้าง token(X) ให้ depositAddress(h)
                                                              │    executor ── ZetaphyGateway.execute(call)
                                                              │      CREATE2(salt = h) ดึงเงินออกจากที่อยู่ (ครั้งเดียว)
                                                              │      maxFee ─▶ executor
                                                              │      ที่เหลือ ─▶ target แล้ว target.onSaphanCall(...)
                                                              │      ล้มเหลว? ─▶ outbox ─▶ revertTo บน X หรือ aborted[abortTo]
                                                              │
 lockbox จ่ายให้ depositAddress(h') หลังช่วงรอ ◀── Hyperlane ── outbox เผา ◀── ZetaphyGateway.withdrawAndCall(...) ◀── ผู้ใช้
 executor ── SaphanSourceGateway.execute(outCall)
   CREATE2(salt = h') ดึงเงินออกจากที่อยู่ (ครั้งเดียว)
   maxFee ─▶ executor; ที่เหลือ + target.onSaphanCall{value}(77390, sender, data)
   ล้มเหลว? ─▶ owed[revertTo] บน X (claim())
```

## การออกแบบ: ทำไมที่อยู่ฝากที่คำนวณจากคำสั่งเรียกจึงปลอดภัย

เกตเวย์ไม่ส่งข้อความของตัวเองเลย คำสั่งเรียกแต่ละครั้งเป็น struct (`InCall` สำหรับ X -> ZETAPHY, `OutCall` สำหรับ ZETAPHY -> X)
ที่มีทุกช่องของคำสั่ง: เชน เกตเวย์ทั้งสองฝั่ง nonce ผู้ส่ง สัญญาปลายทาง จำนวน ค่าตอบแทน gas limit ที่อยู่คืนเงินและที่อยู่ abort และข้อมูล
แฮช `h` ของมัน (`keccak256(abi.encode(tag, call))`) ใช้เป็น salt ของ CREATE2 สำหรับสัญญาเล็ก ๆ ชื่อ `SaphanDepositAddress`
ที่เป็นของเกตเวย์ฝั่งปลายทาง แล้วเส้นทางก็ย้ายเหรียญ **ไปที่ที่อยู่นั้น** เหมือนการโอนไปที่อยู่ใดก็ได้ตามปกติ

- **เลนรับรองตัวคำสั่งเรียก** เลนของเส้นทาง (บน ZETAPHY: validator ของ Hyperlane สำหรับ X และ runner ของ NeuroLane;
  บน X: validator ของเราสำหรับต้นทาง ZETAPHY) รับรองผู้รับของการโอน ซึ่งคือที่อยู่ฝาก จึงรับรอง `h` และทุกช่องของคำสั่งไปด้วย
  ไม่ต้องเชื่อข้อความ ผู้เซ็น หรือ relayer เพิ่ม
- **สลับไม่ได้** ผู้รันคำสั่งแค่ *ยื่น* คำสั่งเรียกเข้ามา ถ้าแก้ช่องใด (target, amount, sender, data, fee) แฮชและที่อยู่จะเปลี่ยน
  และที่อยู่ใหม่ไม่มีเงิน: `NotFunded`
- **เล่นซ้ำไม่ได้** การรันคำสั่งคือการติดตั้งที่อยู่ฝากด้วย CREATE2 รันคำสั่งเดิมซ้ำจะล้มเหลว (`BadCall`) และที่อยู่จะไม่ถูกติดตั้ง
  ก่อนเงินมาถึง จึงไม่มีใคร "เผา" คำสั่งทิ้งล่วงหน้าได้
- **บีบแก๊สไม่ได้** ก่อนสัญญาปลายทางทำงาน เกตเวย์ตรวจว่ามีแก๊สพอสำหรับ `gasLimit` และงานที่ตามมา (`LowGas`)
  ผู้รันคำสั่งจึงจงใจทำให้การเรียกล้มเพื่อบังคับคืนเงินไม่ได้
- **ได้ทั้งหมดหรือไม่ได้อะไรเลย** การโอนให้สัญญาปลายทางและการเรียกทำในการเรียกตัวเอง (self-call) ถ้าล้มเหลวจะย้อนทั้งสองอย่างก่อนคืนเงิน
- **ไม่มีผู้ดูแลรายใหม่** ผู้ติดตั้งทำได้อย่างเดียวคือกำหนดเกตเวย์อีกฝั่งครั้งเดียว (`setRemote`) เกตเวย์สร้างเหรียญ หยุดระบบ
  หรือย้ายสิ่งที่เส้นทางไม่ยอมไม่ได้ เพดาน ช่วงกักไว้ตรวจ การ veto การพักของ ThreatRegistry และการหยุดชั่วคราวของเส้นทาง
  ใช้กับการโอนผ่านเกตเวย์ทุกครั้งเหมือนการโอนอื่น
- **ค่าตอบแทนผู้รันคำสั่งตายตัว** เท่ากับ `maxFee` ที่ผู้เรียกเลือกพอดี ไม่มีทางมากกว่า และจ่ายแม้การเรียกจะล้มเหลว (ผู้รันทำงานแล้ว)
  การคืนเงินกลับไป X ต้องจ่ายค่า Mailbox ของ outbox ด้วย ซึ่งผู้รันคำสั่งจ่ายเป็น ZTPHY ถ้าไม่จ่าย `execute` จะ revert (`Fee`)
  ผู้รันคำสั่งจึงดันผู้ใช้ไปสู่ abort ด้วยการไม่จ่ายไม่ได้

สิ่งที่เกตเวย์ *ไม่ได้* เพิ่ม: ความเร็ว ขา X -> ZETAPHY ใช้เวลาเท่ากับการโอนธรรมดาบนเส้นทางนั้น (สองเลน ช่วงกักไว้ตรวจ)
ขา ZETAPHY -> X ต้องรอช่วงหน่วงการปล่อยของ lockbox (1 ชั่วโมงในตาราง) และเพดานรายวัน

## เทียบกับ Gateway ของ ZetaChain

หน้าตาการเรียกตั้งใจให้ใกล้กับ Gateway ของ ZetaChain (ณ ปี 2026) (`depositAndCall`, `withdrawAndCall`, `revertAddress`,
`callOnRevert`, `abortAddress`, `revertMessage`) นักพัฒนาที่คุ้นกับ ZetaChain จะใช้ได้ทันที แต่แบบความเชื่อใจต่างกัน:

| | ZetaChain Gateway | Saphan Gateway |
|---|---|---|
| ใครรับรองคำสั่งข้ามเชน | observer-signer ของ ZetaChain (TSS: กุญแจเดียวที่แบ่งส่วนถือโดย validator ที่เป็น observer-signer) | การตรวจเดิมของเส้นทาง: สองเลนที่เป็นอิสระต่อกัน ช่วงกักไว้ตรวจ การ veto ของ Neuro ThreatRegistry เพดานรายวัน (ขาเข้า); validator ของเรา + ช่วงหน่วงการปล่อย + การ veto ของ guardian (ขาออก) |
| ความเชื่อใจที่เพิ่มขึ้น | กุญแจ TSS และ observer คือตัวสะพานเอง | ไม่มี: คำสั่งเรียกผูกกับที่อยู่ฝากที่เส้นทางรับรองอยู่แล้ว |
| ใครรันคำสั่ง | ตัวโปรโตคอล (observer) | ใครก็ได้ (executor แบบไม่ต้องขออนุญาต) ได้ค่าตอบแทน `maxFee` จากเงินที่ย้าย |
| สินทรัพย์ | หลายแบบ: เหรียญค่าแก๊สและ ERC-20 ของหลายเชน (ZRC-20) | เส้นทางละหนึ่ง: ETH ของเส้นทางในรูป token(X) |
| Abort | ที่อยู่ abort ได้รับโทเคน (และ `onAbort` ถ้าเป็นสัญญา) | โทเคนรอให้ `abortTo` มารับ (`claimAborted`) ไม่มีการเรียก |

## เรียกจากสัญญา

มีสอง interface สำหรับผู้รับ (ใน `SaphanGateway.sol`) **สัญญาปลายทางต้องตรวจว่า `msg.sender` คือเกตเวย์**
เพราะใครก็เรียก `onSaphanCall` ตรง ๆ ได้ มีแต่การเรียกจากเกตเวย์เท่านั้นที่มาพร้อม `sender` ที่ถูกรับรองและเหรียญจริง

บน ZETAPHY (ถูกเรียกจาก X):

```solidity
interface ISaphanCallee {
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256 amount, bytes calldata data) external;
}

contract MyApp is ISaphanCallee {
    address public immutable gateway; // ZetaphyGateway ของเส้นทาง (เชนต้นทางละหนึ่งตัว)
    constructor(address g) { gateway = g; }

    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256 amount, bytes calldata data) external {
        require(msg.sender == gateway, "not the Gateway");
        // `amount` ของ `token` (token(X)) อยู่ในสัญญานี้แล้ว; `sender` คือผู้เรียก depositAndCall บนเชน `srcChainId`
    }
}
```

บนเชนต้นทาง X (ถูกเรียกจาก ZETAPHY และตอนคืนเงินแบบ `callOnRevert`):

```solidity
interface ISaphanReceiver {
    function onSaphanCall(uint256 srcChainId, address sender, bytes calldata data) external payable;      // srcChainId = 77390
    function onSaphanRevert(address sender, uint256 nonce, bytes calldata message) external payable;     // การคืนเงิน; msg.value = ETH ที่คืน
}
```

ทั้งสองฟังก์ชันต้อง `require(msg.sender == <SaphanSourceGateway บน X>)` สัญญาที่รับคำสั่งจากหลายเส้นทางต้องตรวจเกตเวย์ของแต่ละเส้น
(และตรวจ `srcChainId`, `sender` ถ้าเชื่อเฉพาะผู้เรียกบางราย ทั้งสองช่องเป็นส่วนของคำสั่งที่ถูกรับรอง) สัญญาปลายทางได้แก๊สไม่เกิน
`gasLimit` ถ้า revert เหรียญจะถูกคืนตามที่อธิบายข้างบน

การเรียก (ethers; ABI อยู่ใน `zetaphy-network/src/saphangateway.js`):

```js
// X -> ZETAPHY เรียกบน X
const fee = await sourceGateway.quoteDeposit(amount);
await sourceGateway.depositAndCall(target, data, amount, maxFee, gasLimit, revertTo, callOnRevert, abortTo, revertMessage,
  { value: amount + fee }); // revertTo / abortTo = 0x0: ใช้ผู้เรียกเอง

// ZETAPHY -> X เรียกบน ZETAPHY
await tokenX.approve(zetaphyGateway, amount);
await zetaphyGateway.withdrawAndCall(target, data, amount, maxFee, gasLimit, revertTo,
  { value: await zetaphyGateway.quoteWithdraw(amount) }); // ต้องระบุ revertTo
```

| พารามิเตอร์ | ความหมาย |
|---|---|
| `target`, `data` | สัญญาบนอีกเชน และสิ่งที่จะบอกมัน |
| `amount` | ETH ที่ล็อกบน X หรือ token(X) ที่เผาบน ZETAPHY |
| `maxFee` | ค่าตอบแทนผู้รันคำสั่ง หักจาก `amount` (ไม่เกิน `amount`) |
| `gasLimit` | แก๊สที่สัญญาปลายทางได้ |
| `revertTo` | บน X: ผู้รับเงินคืนเมื่อการเรียกล้มเหลว |
| `callOnRevert`, `revertMessage` | เฉพาะ X -> ZETAPHY: การคืนเงินจะเรียก `revertTo.onSaphanRevert(sender, nonce, revertMessage)` |
| `abortTo` | เฉพาะ X -> ZETAPHY: ผู้มีสิทธิ์รับโทเคนบน ZETAPHY เมื่อทางกลับปิด |

`msg.value` ที่จ่ายเกินจะคืนให้ผู้เรียก เหรียญที่คนอื่นโอนเข้าที่อยู่ฝากจะไปถึงสัญญาปลายทางพร้อมเหรียญของคำสั่งนั้น
`ZetaphyGateway.depositAddress(call)` / `SaphanSourceGateway.depositAddress(outCall)` และฟังก์ชัน JS `hashIn`, `hashOut`,
`depositAddressOf` คำนวณที่อยู่ฝากนอกเชนได้

## ติดตั้งและรันผู้รันคำสั่ง (executor)

ต้องมีเส้นทางที่ติดตั้งแล้ว: `routes.<chain>` ใน `zetaphy-chain/hyperlane/saphan-routes.json` (docs/SAPHAN-MULTICHAIN.md)

1. Actions -> **saphan-route**, `chain = <ชื่อ>`, `mode = gateway` (รันด้วยมือ; environment `testnet-deploy`, กุญแจ
   `ZETAPHY_DEPLOYER_KEY` ผู้ติดตั้งต้องมีค่าแก๊สทั้งสองเชน) จะติดตั้ง `ZetaphyGateway` บน ZETAPHY แล้ว `SaphanSourceGateway`
   บน X ที่ชี้กลับมา แล้ว `setRemote` หนึ่งครั้ง จากนั้น push `saphan-routes.json`
   `routes.<chain>.gateway = {zetaphy, source, zetaphyFrom, sourceFrom, workflowRun}` ไปที่ branch `saphan/<chain>-gateway`
   เปิด pull request แล้ว merge หน้า Saphan ของ hub จะแสดงที่อยู่ทั้งสอง ถ้าเชนนั้นมีเกตเวย์อยู่แล้ว workflow จะปฏิเสธ
2. ไม่ต้องเปิดอะไรเพิ่ม: เกตเวย์ทำงานเมื่อเส้นทางของมันเปิด เส้นทางติดตั้งแบบ **ปิด** และเปิดผ่าน timelock ของการกำกับดูแล
   (48 ชั่วโมงบนเชนต้นทาง; docs/SAPHAN-MULTICHAIN.md)
3. Actions -> **saphan-route**, `mode = execute`: รันผู้รันคำสั่งหนึ่งรอบ อ่าน `DepositAndCall` (บน X) และ `OutCallSent`
   (บน ZETAPHY) ของ 5000 บล็อกล่าสุด รันทุกคำสั่งที่เงินมาถึงแล้วหรือถึงเวลาแล้ว (ถ้ายังไม่มีใครทำ จะขอให้ airlock ปล่อยการล็อก
   หรือ claim การปล่อยที่ถึงเวลาบน X ให้ด้วย) และบอกว่าคำสั่งที่เหลือรออะไร ผลอยู่ใน summary ของการรัน ค่าตอบแทนเข้าบัญชีผู้ติดตั้ง

ทำแบบเดียวกันจาก shell (ในโฟลเดอร์ `zetaphy-network`; `KEYFILE` = ไฟล์ที่เก็บกุญแจ; `ZETAPHY_RPC` / `ORIGIN_RPC`
ใช้แทน RPC ในตาราง):

```
KEYFILE=<file> node scripts/saphan.js gateway-deploy  --chain sepolia
KEYFILE=<file> node scripts/saphan.js gateway-execute --chain sepolia [--blocks 5000] [--dry yes]
```

`--dry yes` วางแผนอย่างเดียว (ไม่ต้องใช้กุญแจ) `--blocks` ขยายช่วงย้อนหลังสำหรับคำสั่งที่เก่ากว่า

## ข้อจำกัดและสิ่งที่ยังไม่ได้ทำ

- ใช้บนเครือข่ายทดสอบเท่านั้น ยังไม่ผ่านการตรวจสอบ ใช้เหรียญทดสอบเท่านั้น และยังไม่ได้ติดตั้งจริง
- ย้ายได้เฉพาะ ETH ของเส้นทาง (token(X) บน ZETAPHY) เกตเวย์ไม่รองรับ ERC-20 อื่น และโทเคนที่เกิดบน ZETAPHY (docs/SAPHAN-TOKENS.md)
- ผู้รันคำสั่งยังรันด้วยมือ (`mode = execute`) ยังไม่มีตารางเวลาหรือ executor สาธารณะ ใครจะรันเองก็ได้ ค่าตอบแทนคือ `maxFee`
  ผู้รันคำสั่งของเรารันทุกคำสั่งที่พร้อม ไม่ว่าค่าตอบแทนเท่าไร (แม้เป็น 0)
- ผู้รันคำสั่งของเราไม่ส่ง ZTPHY สำหรับค่า Mailbox ตอนคืนเงินไป X ซึ่งไม่เป็นปัญหาตราบที่ค่านี้บน ZETAPHY เป็น 0 ถ้ามีการตั้งค่า
  การคืนเงินแบบนั้นจะรอ (`Fee`) จนกว่าจะมีผู้รันคำสั่งที่จ่ายให้
- คำสั่งที่เก่ากว่าช่วงย้อนหลังของผู้รันคำสั่ง (`--blocks`) จะหาไม่เจอ ถ้าไม่ขยายช่วง
- ค่าตอบแทนผู้รันคำสั่งจ่ายแม้การเรียกจะล้มเหลว การคืนเงินผ่านเพดานและช่วงหน่วงของเส้นทางเหมือนการโอนทั่วไป
  และจะรอหรือ abort เมื่อเส้นทางปิด
