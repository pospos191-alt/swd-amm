[English](README.md) | **ภาษาไทย**

# ZETAPHY EVOLVE — เชนใหม่ แบบที่ 2 (Rollup) ตามเอกสาร Shared Security, งบ 0 บาท

ทำตามข้อแนะนำของเอกสาร "ZETAPHY: ทางเลือกความปลอดภัยร่วม" (27 ต.ค. 2026):
ในแบบที่ 2 ทางที่เข้ากับเราที่สุดคือ **Evolve บน Celestia** — ยังเป็นเชนเรา
ฟรีช่วง testnet และต้องมีเครื่อง sequencer เพียง 1 เครื่อง (เครื่องฟรี Oracle ได้)

**เป็นเชนใหม่แยกต่างหาก ไม่ใช่การย้าย ZETAPHY** — เชน ZETAPHY เดิม (77390)
ไม่ถูกแตะ และต่างจากตัวทดลอง OP Stack ([`zetaphy-rollup/`](../zetaphy-rollup/README.th.md))
ตรงที่เชนนี้**มีเหรียญแก๊สของตัวเอง**ตั้งแต่ genesis ไม่ใช่ ETH ที่ bridge มา

| ค่า | ตั้งไว้ |
|---|---|
| สถาปัตยกรรม | Evolve (ev-node) sequencer เดี่ยว + ev-reth (Reth) เป็นชั้น EVM |
| ชั้นเก็บข้อมูล (DA) | **Celestia Mocha** (testnet, ปัจจุบันคือ mocha-5) ผ่าน light node บนเครื่องเดียวกัน |
| Chain ID (EVM / MetaMask) | `77392` (ZETAPHY = 77390, ตัวทดลอง OP Stack = 77391) |
| เหรียญ | ZEVO 1,000,000,000 เหรียญที่บัญชี owner ใน genesis (+1,000,000 ให้กระเป๋าคุณถ้าใส่ `OWNER_EVM_ADDRESS`) |
| เวลาต่อบล็อก | 1 วินาทีเมื่อมีธุรกรรม; โหมด lazy จะออกบล็อกทุก 60 วินาทีเมื่อเงียบ (ประหยัด TIA) |
| เวอร์ชันที่ตรึง | ev-node `v1.3.0` (ตรวจ commit), ev-reth image `v0.7.0` (amd64+arm64), celestia-node `v0.34.4` (ตรวจ SHA-256) |

## ทำไมงบ 0 บาท

| รายการ | ที่นี่ |
|---|---|
| เครื่อง sequencer 1 เครื่อง | Oracle Cloud Always Free (A1.Flex) = 0 บาท |
| ค่าเก็บข้อมูลบน Celestia | **TIA จาก faucet ฟรี** (Discord 10 TIA/สัปดาห์ หรือเว็บ faucet) |
| validator | ไม่ต้องมี — ความปลอดภัยของข้อมูลมาจาก Celestia, full node ตรวจซ้ำได้จาก DA |
| https + ชื่อโดเมน | Caddy + Let's Encrypt + sslip.io ฟรี |

## วิธีที่ง่ายที่สุด: ปุ่มเดียว (หลัง merge เข้า main)

1. กดปุ่ม **Deploy to Oracle Cloud** ใน [`deploy/oracle/`](../deploy/oracle/README.md) แล้วล็อกอิน Oracle
2. เลือก Machine size `VM.Standard.A1.Flex` และ **What to install** = `evolve` → Next → ติ๊ก Run apply → Create
   (stack เปิดพอร์ต 80/443 และจัดเครื่อง 2 CPU / 12 GB ให้เอง ยังอยู่ใน Always Free)
3. หน้าเครื่อง `zetaphy-node` → **Run command** → `sudo zetaphy-evolve status`
   จะได้ที่อยู่ `celestia1…` ไปขอ TIA ฟรี แล้วรอ ~20–40 นาที สั่งคำสั่งเดิมอีกครั้งจะเห็นความสูงบล็อกและ RPC

## ตั้งเครื่องบน Oracle Cloud แบบวางสคริปต์เอง (ใช้ได้ทันที ไม่ต้องรอ merge)

1. สร้างเครื่องแบบเดียวกับ [เชน ZETAPHY](../zetaphy-chain/README.th.md):
   Ubuntu 24.04, **A1.Flex 2–4 OCPU / 12–24 GB** (ev-reth + light node + sequencer
   สบาย ๆ บนเครื่องนี้; เครื่อง 1 GB ไม่พอสำหรับ Reth)
2. **Paste cloud-init script**: วางไฟล์ [`setup-evolve.sh`](./setup-evolve.sh) ทั้งไฟล์
   (~18 KB ต่ำกว่าเพดาน 32,000 ไบต์ของ Oracle)
   - (ไม่บังคับ) แก้ `OWNER_EVM_ADDRESS=""` เป็นที่อยู่ MetaMask ของคุณ
     เพื่อรับ 1,000,000 ZEVO ตอนเปิดเชน
3. เปิดพอร์ต **80** และ **443** ใน Security List (เชนนี้ไม่ต้องเปิดพอร์ตอื่น)
4. ดูความคืบหน้า: `sudo tail -f /var/log/zevolve-setup.log`

### ขั้นที่ต้องลงมือเอง 1 ครั้ง: เติม TIA ทดลอง (ฟรี)

ที่ขั้น `5/9` สคริปต์พิมพ์ **ที่อยู่ Celestia** ของเครื่อง (ขึ้นต้น `celestia1…`)
แล้วรอ ให้ขอ TIA ฟรีส่งไปที่อยู่นั้น:

- **https://mocha.celenium.io/faucet**
- **https://faucet.noders.services/celestia** — 0.1 TIA ทุก 12 ชั่วโมง (พอเริ่มเชนได้เลย)
- Discord ของ Celestia ห้อง **#mocha-faucet**: พิมพ์ `$request <ที่อยู่>` — 10 TIA/สัปดาห์

ได้ 0.1 TIA สคริปต์ก็ไปต่อเอง (เพดานปรับได้ด้วย `FUND_MIN_TIA` หน่วย utia)
TIA ใช้จ่ายค่า blob ทีละนิดทุกครั้งที่ส่งข้อมูลขึ้น Mocha — โหมด lazy ตั้งไว้ให้
เชนเงียบกินน้อย เติมซ้ำได้เรื่อย ๆ จาก faucet เดิม

### ตรวจว่าเชนทำงาน

เพิ่มเครือข่ายใน MetaMask: RPC `https://<IP มีขีด>.sslip.io`, Chain ID `77392`,
สัญลักษณ์ `ZEVO` — หรือ:
```bash
curl -s -X POST https://<ชื่อเครื่อง>.sslip.io -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```
เมื่อส่งธุรกรรม บล็อกออกภายใน ~1 วินาที; ช่วงเงียบเลขบล็อกขยับทุก ~60 วินาที

## เครื่องอื่นเข้าร่วมเป็น replica (อ่านอย่างเดียว ไม่ใช้ TIA)

```bash
curl -fsS "https://<ชื่อเครื่องแรก>.sslip.io/zevolve/setup-evolve.sh" -o /root/setup-evolve.sh
sudo JOIN=<ชื่อเครื่องแรก>.sslip.io bash /root/setup-evolve.sh
```
replica รัน light node ของตัวเอง ดึง genesis สองไฟล์จากเครื่องแรก แล้ว**สร้างเชนซ้ำ
จากข้อมูลบน Celestia ล้วน ๆ** (การอ่าน DA ไม่เสีย TIA) — นี่คือกลไกความปลอดภัยของแบบนี้:
ใครก็ตรวจว่า sequencer ไม่โกงได้ด้วยการรันซ้ำ ตามที่เอกสารอธิบาย

## สิ่งที่ตรงกับเอกสาร และสิ่งที่เป็นขั้นถัดไป

ตามหัวข้อ "Evolve: ฟีเจอร์ที่อยู่หรือหาย" ของเอกสาร:

- ชุดนี้คือโครงสร้างของ "ข้อ 3: ทดลอง Evolve" — เชนใหม่บน Evolve + Celestia จริง
  แต่ใช้ **ev-reth (EVM)** เป็นชั้น execution จึงยังไม่มีโมดูล Cosmos
  (บัญชี ML-DSA, Q-day, CosmWasm, IBC) บนเชนนี้
- เส้นทางเต็มของเอกสาร — รัน **Cosmos EVM ของ ZETAPHY บน ev-abci** — ยังเป็นงาน
  8–14 สัปดาห์-คน: ev-abci (`v1.0.0-beta.5`) อยู่บน Cosmos SDK v0.50 ต้องพอร์ตไป
  v0.54 และยังไม่มีใครรัน cosmos/evm บนมันมาก่อน สัญญา EVM (DEX, NFT, NeuroJobs)
  วางบนเชนนี้ได้เลยระหว่างรอ
- จุดอ่อนที่เอกสารชี้ยังอยู่ครบ: sequencer เดี่ยว (ดับ = เชนหยุดรับธุรกรรม
  แต่ข้อมูลอยู่ครบบน Celestia), หัวบล็อกเซ็นด้วยกุญแจแบบเดิม (ไม่ใช่ PQ),
  ยังไม่มี fraud/validity proof

## ความปลอดภัย (testnet เท่านั้น)

- เหรียญบนเชนนี้ไม่มีมูลค่า ห้ามโฆษณาหรือขาย
- กุญแจ owner (ถือ ZEVO ทั้งหมด) อยู่ที่ `/home/zevolve/.zevolve-keys/owner.key`;
  กุญแจ sequencer อยู่ใน home ของ ev-node; กุญแจ Celestia อยู่ใน store ของ light node
  (mnemonic ถูกพิมพ์ลง log ตอน init — เครื่องนี้เป็น testnet ใช้แล้วทิ้งได้)
  **ไม่มีกุญแจใด ๆ ใน repo นี้**
- ไบนารีทุกตัวตรึงเวอร์ชัน: ev-node build จากซอร์สที่ตรวจ commit, celestia-node
  ตรวจ SHA-256, ev-reth ใช้ docker image ตาม tag
- เปิดสาธารณะแค่ 80/443 (Caddy → RPC ภายใน) พอร์ต engine/8551 และ DA/26658
  ฟังเฉพาะในเครื่อง

## สถานะของสคริปต์นี้

เขียนตามซอร์สจริงของ ev-node v1.3.0 (ชื่อ flag ทุกตัวตรวจกับ `pkg/config/config.go`
ที่ tag นั้น) และ celestia-node v0.34.4 ("mocha" = mocha-5) ส่วนที่ทดสอบแล้ว:
ไวยากรณ์ทั้งไฟล์, ตัวสร้างกุญแจคอมไพล์และทำงานจริง, genesis ที่สร้างเป็น JSON
ถูกต้องและจำนวนเหรียญตรง **ยังไม่เคยรันครบวงจรบนเครื่องจริง** (ต้องมีเครื่อง
Oracle + faucet TIA) — รันซ้ำได้ปลอดภัย ขั้นที่เสร็จแล้วจะถูกข้าม
