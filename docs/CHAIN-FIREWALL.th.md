[English](CHAIN-FIREWALL.md) | **ภาษาไทย**

# ไฟร์วอลล์ invariant ในโหนด (ชั้นเชน)

ใช้กับ testnet เท่านั้น ไม่มีส่วนใดถือหรือจ่ายเงินจริง และยังไม่ผ่านการตรวจสอบโดยบริษัทภายนอก

[ไฟร์วอลล์ invariant](future/invariant-firewall.th.md) (SS1) ให้โปรโตคอลลงทะเบียนตัวตรวจ invariant
(`holds(address) view returns (bool)`) ไว้ใน `InvariantFirewall` ชั้นสัญญา (`Firewalled.enforce`) ป้องกันได้เฉพาะ
การเรียกที่เข้ามาทางฟังก์ชัน `firewalled` ของโปรโตคอลเท่านั้น **ชั้นโหนดในเอกสารนี้ตรวจ invariant หลังธุรกรรม EVM
ทุกธุรกรรม ไม่ว่าธุรกรรมนั้นจะเดินทางผ่านเส้นทางใด** และย้อนธุรกรรมกลับถ้ามันทำให้ invariant ข้อใดพัง
invariant จึงกลายเป็นกติกาของเชน แทนที่จะเป็น modifier ที่ต้องเลือกใช้เอง

| ส่วน | อยู่ที่ | สถานะ |
|---|---|---|
| โค้ดโหนด: hook, อ่าน registry, เรียกตัวตรวจ, check point, สวิตช์, upgrade | `evmd/zetaphy_firewall.go` ใน `zetaphy-chain/setup-node.sh` (`ZETAPHY_PQ_PATCH`) | ของจริง คอมไพล์แล้ว อยู่ในโหนด |
| ตรรกะล้วน: ถอดรหัสแบบเข้มงวด, ขอบเขต, งบ gas, กฎคำตอบ, กฎ "เพิ่งพัง" | `evmd/zetaphy_firewall_core.go` (แพตช์เดียวกัน) | ของจริง มี unit test |
| การต่อสาย: `pqHooks.PostTxProcessing`, `MsgEVMCall`, `BeginBlocker`, kind ของ `MsgSetFuture`, genesis, CLI, `zetaphyEarlyUpgrades` | `zetaphy_pqguard.go`, `zetaphy_pqcall.go`, `app.go`, `zetaphy_future.go`, `zetaphy_upgrade.go`, `zetaphy_seccli.go`, `zetaphy_upgradeguard.go` (แพตช์เดียวกัน) | ของจริง |
| Fork test (13): `InvariantFirewall` ตัวจริง + vault ที่ถอนเงินมีบั๊ก | `zetaphy-chain/fork-tests/evmd/zetaphy_firewall_test.go`, `zetaphy_firewall_core_test.go`, `testdata/firewall/` | ของจริง รันใน CI |
| คำสั่ง governance | `gov.sh invariant-firewall <0x… \| ->` | ของจริง |

ไฟล์นี้แทนที่ต้นแบบเดิมใน `zetaphy-chain/prototypes/invariant-firewall` (ไม่เคยถูกคอมไพล์) ต้นแบบเรียก `chainCheck()`
แล้วให้สัญญาเป็นผู้รันตัวตรวจ ตอนนี้โหนดอ่าน registry และเรียกตัวตรวจแต่ละตัวเอง ดังนั้นเพดาน gas ขอบเขต และกฎ
fail-closed ถูกบังคับโดยโค้ด consensus ไม่ใช่โดยสัญญาอย่างเดียว

## โหนดทำอะไร

```
ธุรกรรม EVM (หรือ MsgEVMCall) สำเร็จ ──► pqHooks.PostTxProcessing / evmCall: firewallPostTx(ctx)
   │  ปิดอยู่ (ยังไม่มีความสูงจาก upgrade หรือยังไม่ได้ตั้งสัญญา)? → ไม่ทำอะไร
   ▼
 STATICCALL InvariantFirewall.chainProtocols()                 200,000 gas, ไม่เกิน 8 โปรโตคอล
 ทีละโปรโตคอล p ตามลำดับใน registry:
   STATICCALL invariantsOf(p)                                   200,000 gas, ไม่เกิน 8 ข้อ, เพดาน 5,000..500,000
   เพดานรวมยังพอในงบ 2,000,000 ที่เหลือ?  ไม่พอ → ถือว่า p พัง
   ทีละตัวตรวจ: STATICCALL checker.holds(p) ด้วย gas เท่ากับเพดานพอดี
                 จาก module address "zetaphy-firewall"
                 คำตอบอะไรก็ตามที่ไม่ใช่ 32 ไบต์ที่แปลว่า true → p พัง (หยุดที่ข้อแรกที่พัง)
   ▼
 p พังตอนนี้ และ ไม่ได้พังที่ check point ล่าสุด? → error ErrInvariantFirewall (codespace zetaphy, 40):
                                                    x/vm ทิ้งทั้งธุรกรรม (state และ log)
 ไม่เช่นนั้น → state นี้เป็น check point ใหม่
```

- **Fail-closed ต่อตัวตรวจ** ตอบ `false`, revert, gas หมดภายในเพดาน, คืน 64 ไบต์, คืน `2` หรือไม่คืนอะไรเลย
  ทุกกรณีถือว่าละเมิด กฎเดียวกับ `InvariantFirewall._holds`
- **มีขอบเขต** ไม่เกิน 8 โปรโตคอล โปรโตคอลละไม่เกิน 8 invariant เพดานข้อละ 5,000..500,000 gas และเพดานรวมของการตรวจ
  หนึ่งครั้งไม่เกิน 2,000,000 gas (`CHAIN_GAS_BUDGET`) โปรโตคอลที่ข้อมูลใน registry ผิดขอบเขตถือว่าพัง กรณีแย่ที่สุด
  ต่อธุรกรรม: อ่าน 9 ครั้ง ครั้งละ 200,000 gas บวกการตรวจ 2,000,000 gas
- **Deterministic (ผลเหมือนกันทุก validator)** ทุกการเรียกใช้ gas คงที่ ไม่ใช้นาฬิกาเครื่อง (เวลาและความสูงบล็อกมาจาก
  header) ไม่วนลูปบน map (ทุกลูปวนบน slice ตามลำดับใน registry) ทำบนสำเนา state ที่ไม่ถูกเขียนกลับ ใช้ gas meter
  ไม่จำกัดและไม่คิด KV gas (นับเฉพาะ EVM gas ข้างบน) ไม่มี tracer `TestFirewallDeterministic` รันการตรวจเดียวกันบน
  สำเนาของ state เดียวกัน แล้วเทียบผล ข้อความ error และ hash ของ store
- **Check point** โหนดบันทึกว่าโปรโตคอลใดพังอยู่ตอนต้นบล็อก (`BeginBlocker` หลัง bridge breaker) และหลังทุกธุรกรรม
  ที่ผ่าน (store key `0x32`) ธุรกรรมจะถูกย้อนเฉพาะเมื่อมันเป็นผู้ทำให้โปรโตคอลพัง โปรโตคอลที่พังด้วยเหตุอื่น (เวลาผ่านไป
  ข้อความที่ไม่ใช่ EVM หรือตัวตรวจเปลี่ยนคำตอบเอง) จะไม่ไปบล็อกทุกธุรกรรมของเชน ทุก check point ส่ง event
  `zetaphy_firewall_broken` (protocol, reason) ให้โปรโตคอลนั้น
- **Registry fail-open** ถ้าอ่าน `chainProtocols()` ไม่ได้เลย (ไม่มีสัญญา, revert, gas หมด, คำตอบผิดรูป) โหนดส่ง
  `zetaphy_firewall_error` และปล่อยธุรกรรมผ่าน registry ที่เสียต้องไม่ทำให้เชนหยุด ส่วนระดับโปรโตคอลและตัวตรวจยัง
  fail-closed ทั้งหมด
- **"ทุกธุรกรรมที่แตะโปรโตคอลที่ลงทะเบียน"** โหนดตรวจโปรโตคอลในชั้นเชนหลังธุรกรรม EVM ที่สำเร็จ **ทุก** ธุรกรรม ไม่ใช่
  เฉพาะธุรกรรมที่เรียกโปรโตคอลนั้น เพราะธุรกรรมดูดเงินออกจากโปรโตคอลได้โดยไม่ต้องเรียกมัน (เช่น spender ที่ได้รับ
  approve ดึงโทเคนด้วย `transferFrom`) จึงตัดสิน "แตะ" จากปลายทางของการเรียกไม่ได้ งบ gas ข้างบนจำกัดต้นทุนไว้

### ใครเป็นคนกำหนดว่าตรวจอะไร

เฉพาะโปรโตคอลที่อยู่ในรายการชั้นเชนของ `InvariantFirewall` governance ของโปรโตคอลขอ (`requestChain`)
`ZetaphyTimelock` อนุมัติ (`approveChain`) ภายใน `MAX_CHAIN` และ `CHAIN_GAS_BUDGET` และถอดออกได้ทันที (`dropChain`)
โหนดอ่านรายการนั้น ไม่มีรายการของตัวเอง invariant ของโปรโตคอลเพิ่มหรือลบได้โดย governance ของโปรโตคอลเท่านั้น
(การลบต้องรอ 2 วัน) เหมือนชั้นสัญญาทุกอย่าง

## วิธีเปิด (ค่าเริ่มต้นคือปิด)

สองขั้น ทั้งสองขั้นผ่าน governance การเปลี่ยนไบนารีอย่างเดียวไม่เปลี่ยนอะไร

1. **เส้นทางโค้ด: software upgrade ชื่อ `zetaphy-firewall`** handler ตั้ง store key `0x33` เป็นความสูง upgrade + 1
   ต่ำกว่าความสูงนั้น ไบนารีใหม่รันบล็อกเหมือนไบนารีเก่าทุกประการ (hook คืนค่าทันที และ kind `invariant-firewall`
   ถูกปฏิเสธ) การ replay บล็อกเก่าจึงได้ state เดียวกัน upgrade นี้ไม่เพิ่ม store และอยู่ใน `zetaphyEarlyUpgrades`:
   ติดตั้ง release ก่อนโหวตผ่านได้ และเชนไม่หยุด (บทเรียนจาก 2026-10-29) ต้องมี v5 (`zetaphy-v5`) ซึ่ง testnet มีแล้ว
   เชนใหม่ใส่ `0x33` = 1 ใน `app_state.zetaphypq` แทนได้
2. **สัญญา: `gov.sh invariant-firewall <InvariantFirewall 0x…>`** (`MsgSetFuture` kind `invariant-firewall`,
   `{"address":"0x…"}`, store key `0x31`) governance เท่านั้น และที่อยู่นั้นต้องมีโค้ด check point แรกถูกบันทึกทันที
   `gov.sh invariant-firewall -` (`{"address":""}`) ปิดอีกครั้งและล้าง check point genesis ตั้ง `0x31` (20 ไบต์) ได้เช่นกัน

`firewallOn` = v5 ทำงาน และความสูง ≥ `0x33` และตั้ง `0x31` แล้ว การ export genesis เก็บ `0x31` และ `0x33` (เป็น 1)
และทิ้ง check point `0x32`

## การทดสอบ

`zetaphy-chain/fork-tests/evmd/zetaphy_firewall_test.go` deploy `InvariantFirewall` ตัวจริง (solc 0.8.26,
optimizer 200, cancun: `testdata/firewall/InvariantFirewall.bin`) และ `ChainVault` ซึ่งเป็น vault ที่ `withdrawBuggy`
มีบั๊ก และ **ไม่ได้** ใช้ `Firewalled` พร้อม invariant ความพอจ่าย (solvency) และตัวตรวจที่ตั้งพฤติกรรมได้

| Test | สิ่งที่แสดง |
|---|---|
| `TestFirewallDrainReverted` | ปิดอยู่: บั๊กดูดเงิน vault ได้ เปิดแล้ว: ธุรกรรมดูดเงินล้มเหลวด้วย `ErrInvariantFirewall` ระบุ vault และตัวตรวจ `solvent` และไม่มีเงินออกจาก vault การถอนปกติและการเรียกอื่นผ่าน เส้นทางธุรกรรม Ethereum (`PostTxProcessing`) ย้อน state เดียวกัน ธุรกรรมที่ล้มเหลวเองไม่ถูกตรวจ ปิดแล้ว: บั๊กใช้ได้อีก |
| `TestFirewallFailClosed` | false, revert, gas หมด, 64 ไบต์, `2`, ไม่คืนอะไร และ "จะผ่านถ้าได้ gas มากกว่าเพดาน": ทุกกรณีคือการละเมิด โปรโตคอลที่พังนอก EVM ก่อนบล็อกไม่บล็อกธุรกรรมอื่น (และถูกรายงาน) หายแล้วถูกธุรกรรมทำพังอีก: ถูกย้อน timelock ถอดออกแล้ว: ไม่ถูกตรวจอีก |
| `TestFirewallRegistryFailsOpen` | registry ที่เผา gas หมด: `zetaphy_firewall_error` และธุรกรรมผ่าน |
| `TestFirewallDeterministic` | state เดียวกัน → รายการ ผลตัดสิน เหตุผล และข้อความ error เหมือนกัน การตรวจไม่เขียนอะไร (hash ของ store EVM และ zetaphypq ไม่เปลี่ยน) |
| `TestFirewallSwitch` | governance เท่านั้น สัญญาเท่านั้น ปฏิเสธฟิลด์ JSON ที่ไม่รู้จัก ก่อน upgrade kind ถูกปฏิเสธและที่อยู่ใน store ถูกเพิกเฉย upgrade ตั้ง H+1 การ export/ตรวจ genesis และ CLI |
| `TestFirewallUpgradeEarlyBinary` | release ที่มี handler รันก่อนความสูงที่โหวตได้โดยเชนไม่หยุด handler รันที่ความสูงนั้น และยังปิดอยู่จนกว่า governance จะระบุสัญญา |
| `TestFirewallSelectors`, `TestFirewallRegistryDecode` | selector และตัวถอดรหัสของโหนดเทียบกับคำตอบของสัญญาจริง ตัวตรวจที่ไม่มีโค้ดคือการละเมิด |
| `zetaphy_firewall_core_test.go` (5) | การถอดรหัสแบบเข้มงวด (ขนาด, offset, ซ้ำ, ที่อยู่ศูนย์, > 8 รายการ, เพดาน 4,999 / 500,001 / 2³²) กฎคำตอบ งบ 2,000,000 กฎ "เพิ่งพัง" และชุดที่เก็บใน store |

รัน (เหมือน CI ใน job "zetaphy-chain (patched node + PQ devnet)" และ job arm64):

```bash
bash zetaphy-chain/setup-node.sh --patch-source "$SRC" && cp -r zetaphy-chain/fork-tests/. "$SRC/"
cd "$SRC/evmd" && go test -tags=test -run 'EVMCall|PQ|QDay|Threat|Security|Wasm|Future|Immune|Breaker|Guard|Anomaly|AI|Upgrade|ModelAt|Firewall' .
```

## คู่มืออัปเกรด: โหนด testnet `zetaphy-node-0`

testnet รัน validator ตัวเดียวบน GCP VM `zetaphy-node-0` (Ubuntu 24.04, systemd service `zetaphyd` และ
`zetaphy-rpc-guard`, มี Caddy อยู่ด้านหน้า, ผู้ใช้โหนด `zetaphy`, ข้อมูลใน `/home/zetaphy/.zetaphy`, ไบนารี
`/usr/local/bin/zetaphyd`) คุณต้องรันคำสั่งเหล่านี้เอง ไม่มีคำสั่งใดในนี้ถูกรันกับโหนดจริง

สัญลักษณ์: **[อ่าน]** ไม่เปลี่ยนอะไร **[เปลี่ยนไฟล์]** เขียนไฟล์บน VM **[เปลี่ยนเชน]** ส่งธุรกรรม
แทนค่า `<ZONE>`, `<H>`, `<ID>`, `<FW>` และ `<COMMIT>` (commit บน `main` ที่มีการเปลี่ยนแปลงนี้)

### 0. ก่อนเริ่ม

- การเปลี่ยนแปลงนี้ merge เข้า `main` แล้ว และสำเนา `setup-node.sh` ที่เผยแพร่ตรงกับ `cloud-init.sh` (รัน
  `zetaphy-chain/pack-cloud-init.sh` แล้วเผยแพร่ `public/` ไปที่ `pospos191-alt/zetaphy-chain` เหมือนทุกครั้งที่แก้
  `setup-node.sh`)
- deploy `InvariantFirewall` แล้ว (สัญญา SS1; constructor `InvariantFirewall(AuditCertificate, ZetaphyTimelock,
  uncertifiedBps)`) ที่อยู่คือ `<FW>` การเปิดชั้นโหนดไม่มีประโยชน์จนกว่าจะมีโปรโตคอลอย่างน้อยหนึ่งตัวได้รับอนุมัติในชั้นเชน

### 1. เชื่อมต่อและดูสถานะ **[อ่าน]**

```bash
gcloud compute ssh zetaphy-node-0 --zone <ZONE>                        # จากเครื่องคุณหรือ Cloud Shell
systemctl status zetaphyd zetaphy-rpc-guard caddy --no-pager | head -30  # [อ่าน]
/usr/local/bin/zetaphyd version                                         # [อ่าน]
curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height   # [อ่าน] ความสูงปัจจุบัน
/usr/local/bin/zetaphyd q upgrade plan --node tcp://127.0.0.1:26657     # [อ่าน] ต้องเป็น "no upgrade scheduled"
df -h / && free -m                                                      # [อ่าน] การ build ต้องใช้ดิสก์ราว 6 GB
```

### 2. สำรอง **[เปลี่ยนไฟล์]**

```bash
# [เปลี่ยนไฟล์] เก็บไบนารีที่รันอยู่ไว้สำหรับ rollback
sudo cp -a /usr/local/bin/zetaphyd /usr/local/bin/zetaphyd.pre-firewall
# [เปลี่ยนคลาวด์] snapshot ดิสก์ (จากเครื่องคุณ / Cloud Shell; เสียค่าพื้นที่เล็กน้อย)
gcloud compute disks snapshot zetaphy-node-0 --zone <ZONE> --snapshot-names zetaphy-pre-firewall-$(date +%Y%m%d)
```

### 3. Build ไบนารีใหม่บน VM **[เปลี่ยนไฟล์]**

ขั้นตอนเดียวกับ `setup-node.sh` ขั้นที่ 4 (commit Cosmos EVM ที่ pin ไว้ แล้วแพตช์ ZETAPHY แล้ว `make install`)
ในโฟลเดอร์แยก ในนามผู้ใช้โหนด ไม่แตะโหนดที่รันอยู่

```bash
sudo -u zetaphy -H bash -c '
set -euo pipefail
GO=$(command -v go || echo /usr/local/go/bin/go)
export PATH=$(dirname "$GO"):$PATH GOTOOLCHAIN=go1.25.9
[ "$(free -m | awk "/Mem:/{print \$2}")" -lt 3000 ] && export GOFLAGS=-p=1 GOGC=50   # VM เล็ก: คอมไพล์ทีละตัว
src=$HOME/src/evm-firewall
rm -rf "$src"                                                                         # [เปลี่ยนไฟล์] (เฉพาะโฟลเดอร์นี้)
git clone -q --depth 1 --branch v0.7.3 https://github.com/cosmos/evm.git "$src"
[ "$(git -C "$src" rev-parse HEAD)" = c3ae9067a7eadcdea55a5192226916deb44c71c4 ]
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/zetaphy/<COMMIT>/zetaphy-chain/setup-node.sh -o $HOME/setup-node-firewall.sh
grep -q "ZetaphyFirewallUpgradeName = \"zetaphy-firewall\"" $HOME/setup-node-firewall.sh
cd "$src" && bash $HOME/setup-node-firewall.sh --patch-source "$src"
make install                                                                          # -> $HOME/go/bin/evmd
$HOME/go/bin/evmd version
'
```

บน e2-micro ใช้เวลาตั้งแต่หนึ่งชั่วโมงขึ้นไป (ใช้ swap) อีกทางหนึ่ง เมื่อ workflow `release-zetaphyd` build release ของ
`setup-node.sh` นั้นเสร็จแล้ว `sudo zetaphy-validator update` จะติดตั้งให้ (ตรวจ SHA-256) แทนขั้นที่ 3 และ 4

### 4. ติดตั้ง **[เปลี่ยนไฟล์]** (รีสตาร์ตโหนด เชนเดินต่อ)

`zetaphy-firewall` รันก่อนเวลาได้ จึงติดตั้งไบนารีใหม่ก่อนโหวตได้ ต่ำกว่าความสูง upgrade มันสร้างบล็อกเหมือนไบนารีเก่าทุกประการ

```bash
sudo install -m 755 /home/zetaphy/go/bin/evmd /usr/local/bin/zetaphyd                # [เปลี่ยนไฟล์]
sudo systemctl restart zetaphyd zetaphy-rpc-guard                                     # รีสตาร์ตโหนด
sleep 20; curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height   # [อ่าน] ต้องเพิ่มขึ้นเรื่อยๆ
journalctl -u zetaphyd -n 50 --no-pager | grep -iE "panic|error|CONSENSUS FAILURE" || echo ok   # [อ่าน]
```

### 5. โหวต upgrade **[เปลี่ยนเชน]**

การโหวตใช้ 600 วินาที และบล็อกออกทุก ~5 วินาที `H` จึงต้องอยู่ข้างหน้าอย่างน้อย ~150 บล็อก ใช้ 300 จะปลอดภัย

```bash
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/zetaphy/main/zetaphy-chain/gov.sh -o /tmp/gov.sh   # [เปลี่ยนไฟล์] เฉพาะ /tmp
H=$(( $(curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height) + 300 )); echo "H=$H"
sudo -u zetaphy -H bash -c "cd ~ && bash /tmp/gov.sh propose-upgrade zetaphy-firewall $H 'Node-level invariant firewall (off until voted)'"   # [เปลี่ยนเชน]
sudo -u zetaphy -H bash -c 'cd ~ && bash /tmp/gov.sh vote <ID> yes'                    # [เปลี่ยนเชน]
# หลังบล็อก H:
/usr/local/bin/zetaphyd q upgrade applied zetaphy-firewall --node tcp://127.0.0.1:26657   # [อ่าน] แสดง H
```

`gov.sh propose-upgrade` จะปฏิเสธชื่อนี้จนกว่า release บน `main` จะมีชื่อนี้และ build เสร็จ ถ้าคุณ build เอง (ขั้นที่ 3)
ก่อนที่ release จะมี ให้ใส่ `FORCE=1` ข้างหน้า

### 6. เปิดไฟร์วอลล์ **[เปลี่ยนเชน]**

```bash
sudo -u zetaphy -H bash -c 'cd ~ && bash /tmp/gov.sh invariant-firewall <FW>'          # [เปลี่ยนเชน] ข้อเสนอ
sudo -u zetaphy -H bash -c 'cd ~ && bash /tmp/gov.sh vote <ID> yes'                    # [เปลี่ยนเชน]
# หลังโหวตจบ: check point รายงานว่ามีอะไรพังอยู่ (ควรไม่มี) และ error ของ registry ถ้ามี  [อ่าน]
h=$(curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height)
curl -s "localhost:26657/block_results?height=$h" | jq '[.result.finalize_block_events[]? | select(.type|startswith("zetaphy_firewall"))]'
```

ธุรกรรมที่ไฟร์วอลล์ปฏิเสธจะแสดงว่าล้มเหลว พร้อม `invariant firewall` และชื่อโปรโตคอลกับตัวตรวจใน error
(`raw_log` / `eth_getTransactionReceipt` status 0)

### Rollback (ถอยกลับ)

- **ปิด (เมื่อไรก็ได้ ไม่ต้องเปลี่ยนไบนารี)** **[เปลี่ยนเชน]**: `gov.sh invariant-firewall -` แล้ว `gov.sh vote <ID> yes`
  นี่คือทางถอยกลับปกติ
- **ก่อนความสูง upgrade H** (ติดตั้งไบนารีแล้ว แต่ upgrade ยังไม่ทำงาน) **[เปลี่ยนไฟล์]**: ไบนารีเก่ายังใช้ได้
  ```bash
  sudo install -m 755 /usr/local/bin/zetaphyd.pre-firewall /usr/local/bin/zetaphyd && sudo systemctl restart zetaphyd zetaphy-rpc-guard
  ```
  ถ้าข้อเสนอ upgrade ผ่านไปแล้ว ไบนารีเก่าจะหยุดที่ H ด้วย `UPGRADE "zetaphy-firewall" NEEDED` ให้ยกเลิกแผนก่อนด้วยข้อเสนอ
  governance `MsgCancelUpgrade` หรือใส่ไบนารีใหม่กลับก่อนถึง H
- **หลัง H**: ไบนารีเก่ารันเชนไม่ได้อีกแล้ว (ไม่มี handler ของ upgrade ที่ทำไปแล้ว) ให้ใช้ไบนารีใหม่ต่อและปิดไฟร์วอลล์
  ตามข้างบน เฉพาะกรณีที่ไบนารีใหม่เองมีปัญหา (crash, app-hash error) ให้หยุด `zetaphyd` กู้ snapshot ดิสก์จากขั้นที่ 2
  และไบนารีเก่า บล็อกที่สร้างหลัง snapshot จะหายไป (testnet ที่มี validator ตัวเดียว)
- เก็บกวาดเมื่อเสร็จ **[เปลี่ยนไฟล์]**: `sudo -u zetaphy rm -rf /home/zetaphy/src/evm-firewall /home/zetaphy/setup-node-firewall.sh`

## ข้อจำกัด

- **ไม่ใช่ทุกเส้นทางเป็นธุรกรรม EVM** ข้อความ CosmWasm, bank และ IBC ไม่ถูกตรวจ ถ้าข้อความเหล่านี้ทำให้โปรโตคอลพัง
  ธุรกรรม EVM ถัดไปในบล็อกเดียวกันจะถูกย้อน (เพราะที่ check point โปรโตคอลยังดีอยู่) จนถึง check point ของบล็อกถัดไป
  จำกัดอยู่ที่หนึ่งบล็อก แต่เป็นช่องให้ก่อกวนได้ถ้ามีเส้นทางแบบนั้นอยู่จริง
- **`eth_estimateGas` / `eth_call` ไม่รัน hook** กระเป๋าจึงมองไม่เห็นล่วงหน้าว่าไฟร์วอลล์จะย้อนธุรกรรม ธุรกรรมจะล้มเหลวบนเชน
  และเสียค่า gas
- **ต้นทุน** hook `PostTxProcessing` ไม่คิด gas ใน cosmos/evm ขณะเปิดไฟร์วอลล์ ทุกธุรกรรม EVM ทำให้โหนดต้องทำงาน EVM
  แบบอ่านอย่างเดียวได้ถึง ~3.8M gas นี่คือเหตุผลที่ timelock ต้องอนุมัติทีละโปรโตคอล
- **ตัวตรวจที่อ่อนหรือผิด** ป้องกันอะไรไม่ได้ ตัวตรวจที่เปลี่ยนคำตอบเองจะบล็อกเฉพาะธุรกรรมในบล็อกที่มันเปลี่ยน (check point
  ของบล็อกถัดไปรับไว้) ดู threat model ใน [future/invariant-firewall.th.md](future/invariant-firewall.th.md)
- **ยังไม่ผ่านการตรวจสอบ (audit)**
