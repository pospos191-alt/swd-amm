[English](audit-as-a-service.md) | **ภาษาไทย**

# Audit-as-a-Service: สั่งตรวจโค้ดได้จากทุกเชน แล้วตรวจใบรับรองได้ตรงที่โค้ดรันอยู่

ใช้บน testnet เท่านั้น ค่าตรวจจ่ายด้วย ZETAPHY ทดลองซึ่งไม่มีมูลค่า ระบบนี้ยังไม่เคยผ่านการตรวจจากบริษัทภายนอก
และใบรับรอง **ไม่ใช่** คำรับประกันว่าโค้ดปลอดภัย

โปรเจกต์บน Ethereum, BNB Smart Chain, Base, Arbitrum, Optimism, Polygon, Avalanche (รวม testnet ของแต่ละเชน),
Osmosis (CosmWasm) หรือ Solana สั่งตรวจโค้ดกับเครือข่ายตรวจสอบแบบเปิดของ ZETAPHY ได้
([audit-network.th.md](audit-network.th.md)) แล้วได้ใบรับรองที่ใครก็ตรวจได้ ทั้งบนเชนของโปรเจกต์เอง (เรียกสัญญา)
บนเว็บไซต์ใดก็ได้ (ป้าย + หน้าตรวจสด) และในกระเป๋าหรือ explorer (ตรวจแบบเดียวกัน หรืออ่านทะเบียนสาธารณะ)
ทั้งหมดนี้ไม่ต้องมีเซิร์ฟเวอร์และไม่ต้องใช้ API key ใช้แค่โหนดสาธารณะฟรีของแต่ละเชน Sourcify GitHub Action และหน้าเว็บแบบ static

| ส่วนประกอบ | อยู่ที่ |
|---|---|
| รายชื่อเชน วิธีวัดแฮชโค้ด proxy กติกาสถานะ ป้าย รูปแบบทะเบียน (หน้าเว็บ CLI และ Action ใช้ร่วมกัน) | `zetaphy-hub/aas-core.js` |
| รับงาน: ที่อยู่สัญญา หรือ repo + commit → เป้าหมายใน AuditNetwork | `zetaphy-network/src/aas/intake.js`, `repo.js`, `net.js` |
| การสั่งตรวจ แพ็กเกจ วิธีจ่ายเงิน | `zetaphy-network/src/aas/order.js` |
| ทะเบียนสาธารณะ + ป้าย | `zetaphy-network/src/aas/registry.js`, `.github/workflows/audit-registry.yml` |
| คำสั่ง `zetaphy aas …` | `zetaphy-network/src/aascli.js` |
| ให้สัญญาอื่นตรวจบนเชน | `zetaphy-network/contracts/AuditVerified.sol` (library ที่อ่านสำเนา NeuroOracle) |
| ตรวจอัตโนมัติฟรีให้ทุก repo | `.github/actions/zetaphy-audit/action.yml`, `.github/workflows/audit-reusable.yml` |
| หน้าตรวจใบรับรอง / สมุดรายชื่อการตรวจสอบ (8 ภาษา) | `zetaphy-hub/audit.html` + `aas-verify.js`, `audits.html` + `aas-directory.js`, `aas-i18n.js` |
| เทสต์ | `zetaphy-network/test/aas.test.js`; `zetaphy-hub/test/aas.test.mjs`, `aas.e2e.mjs` |

## 1. รับงาน: ตรวจโค้ดชุดไหนกันแน่

```
zetaphy aas intake base 0xสัญญาของคุณ
zetaphy aas intake arbitrum 0x… --repo acme/vault --commit <40 hex> --pipeline-out out/
zetaphy aas intake osmosis osmo1… --repo acme/osmo-vault --commit <40 hex> --checksums artifacts/checksums.txt --wasm vault.wasm
zetaphy aas intake solana <program id> [--repo … --commit …]
```

ใบรับรองผูกกับ **แฮชของโค้ด** ขั้นแรกจึงต้องอ่านโค้ดที่เชนรันอยู่จริงตอนนี้

| ชนิดเชน | แฮชโค้ด | ผูกกับซอร์สโค้ดอย่างไร | อะไรเปลี่ยนโค้ดได้ |
|---|---|---|---|
| EVM | `keccak256(runtime code)` คือค่าเดียวกับ `EXTCODEHASH` (อ่านด้วย `eth_getCode` และถาม `eth_chainId` ทุกโหนดก่อน ถ้าเป็นเชนอื่นจะไม่ใช้) | Sourcify v2 ที่ได้ `exact_match` / `match` หรือ repo สาธารณะบน GitHub ที่ commit เต็ม 40 ตัว ซึ่ง pipeline คอมไพล์แล้วได้ bytecode ตรงกันทุกไบต์ (หรือต่างกันแค่แฮช metadata) | proxy (ดูด้านล่าง), `SELFDESTRUCT` แล้ว deploy ใหม่ |
| CosmWasm (Osmosis, osmo-test-5) | checksum ของโค้ด (sha256 ของไฟล์ wasm) ที่เชนเก็บไว้ให้ code id ของสัญญา | repo + commit ที่ build ด้วย `cosmwasm/optimizer` แล้ว `checksums.txt` ได้ค่าเดียวกัน | ถ้าสัญญามี `admin` จะ migrate ไป code id อื่นได้ |
| Solana (mainnet, devnet) | แฮชโปรแกรมแบบ `solana-verify`: sha256 ของ ELF ใน program-data account ตัดศูนย์ท้ายออก (เช็ก genesis hash ของคลัสเตอร์ด้วย) | ถ้า API verified-builds ของ OtterSec ยืนยันแฮชนี้ไว้แล้วก็ใช้ได้เลย ไม่อย่างนั้นใช้ repo + commit ให้ runner build ใหม่ด้วย `solana-verify build` | ผู้ถือ upgrade authority เปลี่ยนโปรแกรมได้ |

**Proxy** ระบบตรวจจับ EIP-1967 (ช่อง implementation และ beacon) clone แบบ EIP-1167 และช่องแบบ ZeppelinOS รุ่นเก่า
proxy หนึ่งตัวจะถูกสั่งตรวจเป็น **สองรายการ** คือตัว proxy และ implementation ที่ชี้อยู่ตอนนั้น เพราะเวลาอัปเกรด
โค้ดของตัว proxy เองไม่เปลี่ยน ทุกช่องทางตรวจ (หน้าเว็บ CLI และ `AuditVerified.requireCertifiedProxy`) จึงเทียบ
implementation ด้วยเสมอ ถ้าอัปเกรดไปใช้โค้ดที่ไม่มีใบรับรองจะขึ้นว่า **โค้ดเปลี่ยนแล้ว (CODE CHANGED)**

**ไม่มีซอร์ส ไม่รับงาน** โค้ดที่ไม่ได้ verify บน Sourcify และไม่มี repo + commit ที่สร้างโค้ดเดียวกันออกมาได้ จะสั่งตรวจไม่ได้
เพราะผู้ตรวจจะได้อ่านซอร์สที่ไม่ใช่โค้ดที่ deploy จริง

เป้าหมายที่ไม่ใช่ EVM ใช้รูปแบบ `Target {chainId, target, codeHash, sourceHash}` เดียวกับ AuditNetwork ได้
โดย `chainId` เป็นเลขสงวนที่สูงกว่า 9·10¹⁸ (Osmosis `9000000000000000001`, osmo-test-5 `…002`, Solana `…101`,
devnet `…102`) ส่วน `target` เป็นตัวแทนขนาด 20 ไบต์ คือ 20 ไบต์ท้ายของ
`keccak256(abi.encode("zetaphy.aas.target", caip2, native))` ที่อยู่จริงของเชนนั้นเก็บไว้ใน URI ของคำขอ:
`zaas1|<เชน>|<ที่อยู่จริง>|<บทบาท>|<ลิงก์>`

## 2. แพ็กเกจและราคา (เหรียญทดลอง)

| แพ็กเกจ | สิ่งที่ทำ | ระยะแข่งขัน | ผู้ตรวจขั้นต่ำ | ใบรับรอง | ราคา |
|---|---|---|---|---|---|
| **fast** (อัตโนมัติอย่างเดียว) | GitHub Action หรือ `zetaphy audit run`: Slither, Aderyn, Semgrep, forge invariants, OSV (pipeline เต็มมี SMTChecker, mutation และ Neuro ด้วย) | — | — | **ไม่มี** (ได้แค่ป้าย "ZETAPHY scan") | ฟรี ใช้นาที CI ของคุณเอง |
| **basic** (AuditNetwork tier 0) | runner ที่วางเงินค้ำ 3 ราย (ต้องตรงกัน 2 ใน 3) + การแข่งขันเปิด + กรรมการที่วางเงินค้ำ | ≥ 7 วัน | ≥ 3 | ทองแดง / เงิน / ทอง ถ้าผ่านทุกข้อ | เงินฝาก = เงินรางวัล + ค่าธรรมเนียม 10 % |
| **standard** (tier 1) | เหมือนกัน | ≥ 14 วัน | ≥ 5 | เหมือนกัน | สูตรเดียวกัน |
| **deep** (tier 2) | เหมือนกัน | ≥ 21 วัน | ≥ 7 | เหมือนกัน | สูตรเดียวกัน |

(ขั้นต่ำจริงอ่านจาก `getParams()` สด: `minContest + 7 วัน × tier` และ `minAuditorsFloor + 2 × tier` ตัวเลขในตารางเป็นค่าเริ่มต้นบน testnet)
เงินฝากจ่ายเป็น ZETAPHY ทดลอง เงินรางวัล (อย่างน้อย `minPool` ค่าเริ่มต้น 10 ZETAPHY) จ่ายให้ช่องโหว่ที่เป็นจริงและรายงานที่ส่งครบ
ค่าธรรมเนียม 10 % แบ่งให้ runner ครึ่งหนึ่ง กรรมการครึ่งหนึ่ง proxy หนึ่งตัวคือสองคำสั่ง

```
zetaphy aas order base 0xProxyของคุณ --tier standard --pool 100           # ลองดูก่อน: พิมพ์ธุรกรรมให้ดู
zetaphy aas order base 0xProxyของคุณ --tier standard --pool 100 --send    # เซ็นและส่งบน ZETAPHY
```

### จ่ายจากเชนอื่น

AuditNetwork รับ ZETAPHY ทดลองแบบ native บนเชน ZETAPHY (77390) ดูขั้นตอนได้ด้วย `zetaphy aas pay --from <เชน>`
เส้นทาง Hyperlane ของ ZETAPHY จาก Sepolia, Base Sepolia และ Arbitrum Sepolia ขน **โทเคน** (lockbox ฝั่งโน้น
bridged token ฝั่ง ZETAPHY) ไม่ใช่ ZETAPHY แบบ native การ "สั่งจาก Sepolia ในธุรกรรมเดียว" จึงต้องมี remote order router
คือสัญญาบน ZETAPHY ที่รับโทเคนกับคำสั่งผ่าน Hyperlane แปลงเป็น ZETAPHY แล้วเรียก `AuditNetwork.request` แทนผู้ส่ง
ตอนนี้ออกแบบไว้ในเอกสารนี้ แต่ **ยังไม่ได้ deploy** วิธีที่ใช้ได้วันนี้คือหา ZETAPHY ทดลองบนเชน ZETAPHY (หน้า Earn ใน hub)
แล้วส่งคำขอจากกระเป๋า ZETAPHY ใบไหนก็ได้ ผู้สั่งไม่จำเป็นต้องเป็นคน deploy สัญญาที่ตรวจ

## 3. ใบรับรองหมายถึงอะไร และมีข้อจำกัดอะไร

หมายถึง: โค้ดชุดนี้ (ระบุด้วยแฮช) ผ่านกระบวนการของ ZETAPHY ครบแล้ว คือเครื่องมืออัตโนมัติที่ runner ซึ่งวางเงินค้ำเห็นตรงกัน
การแข่งขันเปิดของผู้ตรวจที่วางเงินค้ำ และกรรมการที่วางเงินค้ำ โดยไม่มีช่องโหว่ระดับวิกฤตหรือสูงที่เป็นจริงค้างอยู่
และได้ระดับ (ทองแดง / เงิน / ทอง) ตามจำนวนผู้ตรวจ ความยาวการแข่งขัน และคะแนน mutation

**ไม่ได้** หมายความว่าโค้ดปลอดภัย ทีมซื่อสัตย์ หรือได้ตรวจการตั้งค่าตอน deploy กุญแจ สิทธิ์ admin oracle
โมเดลเศรษฐศาสตร์ หรือส่วนที่อยู่นอกเชนแล้ว ใบรับรองหมดอายุ (ค่าเริ่มต้น 180 วัน) และถูกเพิกถอนทันทีถ้าภายหลัง
มีช่องโหว่ระดับวิกฤตหรือสูงที่ตัดสินว่าเป็นจริง ข้อจำกัดอื่นๆ:
- **โค้ดที่อัปเกรดได้** (admin ของ proxy, admin ของ CosmWasm, upgrade authority ของ Solana) เปลี่ยนได้ทุกเมื่อ
  ใบรับรองจะขึ้นว่าโค้ดเปลี่ยนแล้ว แต่ระบบห้ามการเปลี่ยนนั้นไม่ได้
- ผู้ตรวจต้องอ่านโค้ดสดเสมอ กระเป๋าที่อ่านแค่ทะเบียนจะเห็นสถานะ ณ เวลาที่สร้างทะเบียนครั้งล่าสุด
- เชนอื่นนอกจาก ZETAPHY จะรู้ว่ามีการเพิกถอนก็ต่อเมื่อมีคนส่งต่อไปยังสำเนา NeuroOracle บนเชนนั้น
  (`NeuroOracleSender.pushCertificate` ใครก็ส่งได้ โดยจ่ายค่า Hyperlane เอง) ส่วนหน้าเว็บของ hub อ่านจาก ZETAPHY ตรงๆ ทุกครั้ง
- CosmWasm และ Solana ยังไม่มีสัญญาสำเนาในงานรอบนี้ โปรเจกต์บนเชนเหล่านี้ตรวจผ่านหน้าเว็บหรือ CLI
- สัญญาที่มี immutable ให้ผูกผ่าน Sourcify (ซึ่งรองรับ immutable) ทาง repo + commit จับคู่ได้เฉพาะโค้ดที่ตรงกันทุกไบต์
  หรือต่างแค่แฮช metadata

## 4. การตรวจใบรับรอง

สถานะทั้งสี่ (ตรรกะเดียวกันใน `aas-core.js certificateStatus` เรียงตามลำดับความสำคัญ):

| สถานะ | เมื่อไร |
|---|---|
| **ถูกเพิกถอน (REVOKED)** | ใบรับรองนี้ หรือโค้ดเดียวกันในคำขออื่น ถูกเพิกถอนเพราะช่องโหว่วิกฤต/สูงที่เป็นจริง |
| **หมดอายุ (EXPIRED)** | เลย `expiresAt` แล้ว |
| **โค้ดเปลี่ยนแล้ว (CODE CHANGED)** | แฮชโค้ดที่รันอยู่ไม่ตรงกับที่รับรอง หรือถ้าเป็น proxy คือ implementation ปัจจุบันไม่มีใบรับรอง หมดอายุ ถูกเพิกถอน หรือโค้ดเปลี่ยน |
| **ใช้ได้ (VALID)** | ไม่เข้าข้อใดข้างบน และอ่านโค้ดสดได้และตรงกัน |
| (ไม่มีใบรับรอง / ตอนนี้ตรวจไม่ได้) | ไม่เคยได้ใบรับรอง หรือโหนดสาธารณะของเชนไม่ตอบ |

**บนเชนของโปรเจกต์เอง (EVM)** ถ้ามีสำเนา NeuroOracle deploy อยู่ `isCertified(block.chainid, target)` จะคืน true
เฉพาะตอนที่ใบรับรองที่ส่งมายังไม่หมดอายุ ไม่ถูกเพิกถอน และ `EXTCODEHASH` ของเป้าหมายบนเชนนั้นยังตรงกับที่รับรอง
สัญญาอื่นเรียกผ่าน library `AuditVerified`:

```solidity
import "./AuditVerified.sol";
contract Router {
    using AuditVerified for IAVOracle;
    IAVOracle immutable oracle; // สำเนา NeuroOracle บนเชนนี้
    function list(address pool) external { oracle.requireCertified(pool); /* … */ }
    function listGold(address pool) external { oracle.requireLevel(pool, 3); /* … */ }
    function listProxy(address p, address impl) external { oracle.requireCertifiedProxy(p, address(0), impl); /* … */ }
}
```

`isVerified` ปิดไว้ก่อนเมื่อไม่แน่ใจ (ไม่มีสำเนา หรือสำเนา revert ก็ได้ false) ส่วน `requireCertifiedProxy` ต้องใช้กับ proxy
(หรือ beacon) ที่ตอบ `implementation()` ได้ เพราะสัญญาอ่านช่อง EIP-1967 ของสัญญาอื่นไม่ได้

**บนเว็บไซต์** `https://app.sawasdeecoin.com/audit.html#<chain id หรือชื่อเชน>:<ที่อยู่>` (เช่น `#8453:0x…`,
`#solana:<program id>`, `#osmosis:osmo1…`) อ่านใบรับรองจาก ZETAPHY และอ่านโค้ดจากเชนของโปรเจกต์ในเบราว์เซอร์ของผู้เข้าชม
พร้อมโค้ดป้ายสำหรับแปะ:

```html
<a href="https://app.sawasdeecoin.com/audit.html#8453:0xสัญญาของคุณ"><img src="https://cdn.jsdelivr.net/gh/pospos191-alt/swd-amm@audit-registry/badges/base-0xสัญญาของคุณ.svg" alt="ZETAPHY audit certificate" height="20"></a>
```

รูปป้ายเป็นไฟล์ static (สร้างใหม่ทุก 6 ชั่วโมง) ส่วนลิงก์คือการตรวจสด ป้ายเป็น SVG ล้วน ไม่มีสคริปต์และไม่อ้างไฟล์ภายนอก
ใช้เป็น `<img>` ที่ไหนก็ปลอดภัย

**ในกระเป๋าและ explorer** อ่าน `AuditCertificate.certificate(chainId, target)` บน ZETAPHY คู่กับแฮชโค้ดสด (แบบที่หน้าเว็บทำ)
หรือ `isCertified` ของสำเนาบนเชนนั้น หรืออ่านทะเบียนสาธารณะ
`https://raw.githubusercontent.com/pospos191-alt/swd-amm/audit-registry/audit-registry.json` (เป็นแค่ดัชนี
ก่อนแสดงว่า "ใช้ได้" ควรตรวจสดอีกครั้ง) explorer ของ ZETAPHY เองแสดงป้ายให้ที่อยู่ที่ได้ใบรับรองอยู่แล้ว

**จากเทอร์มินัล** `zetaphy aas verify base 0x…` พิมพ์สถานะและแฮชทั้งสองค่า exit code เป็น 0 เฉพาะตอนใช้ได้

## 5. ทะเบียนสาธารณะและสมุดรายชื่อการตรวจสอบ

`.github/workflows/audit-registry.yml` รันทุก 6 ชั่วโมง อ่าน event `CertificateIssued` และ `RequestUri` จาก RPC สาธารณะของ ZETAPHY
เขียน `audit-registry.json` (ใบรับรองทุกใบ ระดับ วันหมดอายุ ลิงก์รายงาน จำนวนช่องโหว่ และความเชื่อม proxy ↔ implementation)
กับป้ายหนึ่งรูปต่อหนึ่งใบรับรอง แล้ว force-push เป็น commit เดียวไปที่ branch กำพร้า `audit-registry`
ไม่มีเซิร์ฟเวอร์ ไม่มี secret token ของ workflow push ได้เฉพาะ branch นั้น
**สมุดรายชื่อการตรวจสอบ** ใน hub (`audits.html` 8 ภาษา) แสดงทะเบียนนี้ (ถ้าโหลดไม่ได้จะใช้สำเนาที่มากับ hub)
กรองตามเชน สถานะ และข้อความได้ และทุกแถวลิงก์ไปหน้าตรวจสด

## 6. GitHub Action ฟรี (ใช้กับ repo ไหนก็ได้)

```yaml
# .github/workflows/zetaphy-audit.yml ใน repository ของคุณ
on: [pull_request]
permissions: {}
jobs:
  audit:
    runs-on: ubuntu-24.04
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
        with: { persist-credentials: false }
      - id: zetaphy
        uses: pospos191-alt/swd-amm/.github/actions/zetaphy-audit@<commit sha เต็ม>
        with:
          path: contracts      # ค่าเริ่มต้นคือรากของ repo
          tier: fast           # หรือ deep (ใช้หลายชั่วโมง)
          fail-on: high        # critical | high | none
```

หรือใช้ reusable workflow:

```yaml
jobs:
  zetaphy-audit:
    uses: pospos191-alt/swd-amm/.github/workflows/audit-reusable.yml@<commit sha เต็ม>
    permissions: { contents: read, security-events: write }
    with: { path: contracts }
```

Action จะติดตั้งเครื่องมือเวอร์ชันที่ตรึงไว้ (`audit/tools/install.sh`: ทุกไบนารีเช็ก SHA-256 เครื่องมือ Python มาจากไฟล์ที่ล็อกแฮช)
รัน `audit/run.sh --target` กับโค้ดของคุณ แล้วเขียน `REPORT.md` (+ ฉบับไทย), `findings.json`, `summary.json`
(`report.js --json`), `audit.sarif` (อัปโหลดเข้า code scanning ถ้า repo รองรับ) และ `zetaphy-scan.svg`
ถ้ามีช่องโหว่เปิดอยู่ถึงระดับ `fail-on` ขั้นตอนจะล้ม output ที่ได้: `status`, `critical`, `high`, `gate` และ path ของไฟล์ต่างๆ
**ไม่ต้องใช้** secret ของ ZETAPHY หรือของคุณเลย การตัดสิน triage ใส่ใน `audit/triage.yml` ของ repo คุณเอง (รูปแบบเดียวกับของเรา)
ให้ตรึงด้วย commit sha เต็มเสมอ อย่าใช้ชื่อ branch และอย่าลืมว่าการตรวจอัตโนมัติเจอได้เท่าที่เครื่องมือเจอ ไม่ใช่ใบรับรอง

## 7. ทดสอบอะไรไปแล้ว และทดสอบอย่างไร

- รับงานของแต่ละชนิดเชน กับ fixture ที่ทำรูปแบบเดียวกับ API สาธารณะ (เทสต์ไม่ใช้เน็ต): เชน EVM ทุกตัวในรายการรวม testnet
  (เช็ก chain id, Sourcify v2), EIP-1967 + admin, beacon, EIP-1167, repo + commit (ตรงทุกไบต์ / ต่างแค่ metadata / ไม่ตรง),
  Osmosis (LCD รุ่นใหม่และรุ่นเก่า), Solana (อ่าน program-data, เช็ก genesis, OtterSec ยืนยันแล้ว / ข้อมูลเก่า)
- บนสัญญาจริงใน EVM จำลอง: รับงาน proxy → `AuditNetwork.request` สองรายการจาก calldata ของ `planOrder` → ออกใบรับรอง →
  สำเนา NeuroOracle → `AuditVerified` (`requireCertified`, `requireLevel`, `requireCertifiedProxy`) การสลับ implementation
  ขึ้นว่าโค้ดเปลี่ยนแล้วในตรรกะหน้าเว็บ และ revert ด้วย `ImplementationChanged` การเปลี่ยนโค้ดในที่เดิมทำให้สำเนาตอบ false
  และสร้างทะเบียนจาก event ที่เกิดขึ้นจริง
- ไฟล์ของ Action: เป็น composite ทุก `uses:` ตรึงด้วย commit ไม่มี `secrets.` และไม่มี `${{ }}` ในสคริปต์
- หน้าตรวจและสมุดรายชื่อใน Chromium ภายใต้ CSP จริงของเว็บ โดยจำลอง RPC ทั้งหมด: ใช้ได้ (+ สำเนา), โค้ดเปลี่ยน
  (deploy ใหม่, สลับ proxy), ถูกเพิกถอน, หมดอายุ, ไม่มีใบรับรอง, โปรแกรม Solana, ภาษาไทย, จอมือถือ
