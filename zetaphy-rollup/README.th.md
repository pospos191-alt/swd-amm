[English](README.md) | **ภาษาไทย**

# ZETAPHY Rollup — เชนใหม่ แบบที่ 2 (Rollup) งบ 0 บาท

**เชนใหม่แยกต่างหาก ไม่ใช่การย้าย ZETAPHY**: เชน ZETAPHY เดิม (Cosmos EVM,
chain id 77390) ยังรันอยู่ที่เดิมทุกอย่าง ไม่ถูกแตะ ไม่ถูกย้าย
อันนี้คือเชนที่สองของโครงการ ทำเป็น **L2 Rollup (OP Stack)** ที่ฝากความปลอดภัย
และข้อมูลไว้กับ **Ethereum Sepolia** (เชนทดลองของ Ethereum)

| ค่า | ตั้งไว้ |
|---|---|
| ซอฟต์แวร์ | OP Stack build จากซอร์สที่ตรึง commit: op-geth `v1.101702.3`, op-node `v1.20.0`, op-batcher `v1.18.0`, op-proposer `v1.16.7`, op-deployer `v0.8.1` |
| Chain ID (EVM / MetaMask) | `77391` (เชน ZETAPHY เดิมคือ 77390) |
| L1 | Sepolia (`11155111`) ผ่าน RPC สาธารณะฟรีของ publicnode |
| เหรียญค่าแก๊ส | **ETH ทดลองของ Sepolia** ที่ bridge เข้ามา (rollup มาตรฐานใช้ ETH เป็นแก๊ส ไม่ใช่เหรียญของตัวเอง) |
| เวลาต่อบล็อก | ~2 วินาที (ค่ามาตรฐาน OP Stack) |
| สัญญาบน L1 | deploy แบบ `standard-overrides`: ชี้ไปที่ implementation ของ Optimism ที่อยู่บน Sepolia แล้ว จึง deploy แค่ proxy ชุดเล็ก ประหยัดแก๊สมาก |

## ทำไมงบ 0 บาท

| รายการ | ปกติ (mainnet) | ที่นี่ (testnet) |
|---|---|---|
| เครื่องรัน sequencer | เช่า VPS | **Oracle Cloud Always Free** (A1.Flex 4 OCPU / 24 GB) = 0 บาท |
| L1 RPC + Beacon | จ่าย provider | publicnode.com สาธารณะ ฟรี ไม่ต้องสมัคร |
| ค่าแก๊ส deploy สัญญา L1 | หลักหมื่นบาท | **Sepolia ETH จาก faucet ฟรี** |
| ค่าแก๊ส batcher/proposer รายเดือน | หลักพัน-หมื่นบาท/เดือน | Sepolia ETH จาก faucet เติมได้เรื่อย ๆ |
| https + โดเมน | ซื้อโดเมน | Caddy + Let's Encrypt + sslip.io ฟรี |

เหรียญและ ETH บนเชนนี้**ไม่มีมูลค่า** ห้ามโฆษณาหรือขาย

## ตั้งเครื่องบน Oracle Cloud (ทำบนหน้าเว็บทั้งหมด)

1. สมัคร/เข้า **cloud.oracle.com** (Free Tier) แบบเดียวกับ [เชน ZETAPHY](../zetaphy-chain/README.th.md)
2. **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 24.04** · Shape: **VM.Standard.A1.Flex, 2-4 OCPU / 12-24 GB** (RAM ต่ำกว่านี้ได้ สคริปต์เพิ่ม swap เอง แต่ build ช้าขึ้น)
   - Networking ค่าเริ่มต้น + public IPv4
3. **Show advanced options → Management → Paste cloud-init script**:
   วางไฟล์ [`setup-rollup.sh`](./setup-rollup.sh) **ทั้งไฟล์** (เปิดบน GitHub → Raw → คัดลอกทั้งหมด
   ไฟล์นี้ ~22 KB เล็กกว่าเพดาน 32,000 ไบต์ของ Oracle จึงวางตรง ๆ ได้ ไม่ต้องมีตัวโหลด)
4. กด Create แล้วรอ build ประมาณ 20–40 นาที (เครื่องเล็ก/1 GB อาจเป็นชั่วโมง)
5. เปิดพอร์ตใน Security List แบบเดียวกับเชนเดิม: **80** และ **443** เท่านั้น
   (เชนนี้ไม่มี P2P สาธารณะ — เครื่องอื่นตามเชนได้จากข้อมูลบน Sepolia ล้วน ๆ)
6. ดูความคืบหน้า: หน้าเครื่อง → Console connection หรือ SSH แล้ว
   ```bash
   sudo tail -f /var/log/zrollup-setup.log
   ```

### ขั้นที่ต้องลงมือเอง 1 ครั้ง: เติม Sepolia ETH จาก faucet (ฟรี)

ถึงขั้น `6/9` สคริปต์จะพิมพ์ **ที่อยู่ admin** แล้วหยุดรอ ให้ไปขอ Sepolia ETH ฟรีส่งไปที่อยู่นั้น
อย่างน้อยตามที่สคริปต์บอก (ค่าเริ่มต้น 1 ETH — ตัว deploy ใช้จริงราว 0.1–0.3 ที่เหลือ
แบ่งให้กระเป๋า batcher 0.3 และ proposer 0.15 โดยอัตโนมัติ):

- **https://sepolia-faucet.pk910.de** — faucet แบบขุดในเบราว์เซอร์ ไม่ต้องสมัครอะไร
  เปิดแท็บทิ้งไว้จนได้ครบ (ได้หลัก 0.5–2 ETH ต่อวัน) ← ทางหลักของแผน 0 บาท
- https://cloud.google.com/application/web3/faucet/ethereum/sepolia — 0.05/วัน (บัญชี Google)
- https://www.alchemy.com/faucets/ethereum-sepolia — ต้องสมัคร Alchemy

สคริปต์เช็กยอดทุก 30 วินาที พอครบจะ deploy ต่อเองจนจบ ไม่ต้องทำอะไรอีก

### ตรวจว่าเชนทำงาน

เพิ่มเครือข่ายใน MetaMask:
- Network name: `ZETAPHY Rollup Testnet`
- RPC URL: `https://<IP ที่เปลี่ยนจุดเป็นขีด>.sslip.io` (ตามที่ log พิมพ์ตอนจบ)
- Chain ID: `77391` · Currency symbol: `ETH`

หรือใน Cloud Shell:
```bash
curl -s -X POST https://<ชื่อเครื่อง>.sslip.io -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```
ตัวเลขควรเพิ่มทุก ~2 วินาที

### เอาเหรียญเข้าเชน (bridge จาก Sepolia)

ส่ง Sepolia ETH จาก MetaMask (เครือข่าย Sepolia) ไปที่ **ที่อยู่ OptimismPortal**
ที่ log พิมพ์ตอนจบ (และอยู่ใน `https://<ชื่อ>.sslip.io/zrollup/l1-addresses.json`)
ประมาณ 3–4 นาที ETH จำนวนเดียวกันจะปรากฏที่ที่อยู่ของคุณเองบนเชน 77391
ขาถอนกลับ (L2 → L1) ใช้เวลานานกว่าและต้องผ่าน dispute game — ฝั่ง testnet แนะนำให้ถือว่าฝากขาเดียว

## เครื่องอื่นเข้าร่วมเป็น replica (อ่านอย่างเดียว)

บนเครื่องฟรีอีกเครื่อง (Oracle/Google) วางสคริปต์เดิมแต่ตั้ง `JOIN` เป็นชื่อเครื่องแรก:
```bash
curl -fsS "https://<ชื่อเครื่องแรก>.sslip.io/zrollup/setup-rollup.sh" -o /root/setup-rollup.sh
sudo JOIN=<ชื่อเครื่องแรก>.sslip.io bash /root/setup-rollup.sh
```
replica ดึง genesis + rollup config จากเครื่องแรก แล้ว**ตามเชนจากข้อมูลบน Sepolia ล้วน ๆ**
(ไม่ต้องเชื่อม P2P ไม่ต้องเชื่อใจเครื่องแรก) จึงเห็นเฉพาะบล็อกที่ batcher post แล้ว
ช้ากว่าหัวเชนราว "max-channel-duration" ที่ตั้งไว้ (ค่าเริ่มต้นสูงสุด ~5 ชั่วโมง เพื่อประหยัดแก๊ส —
ลดได้ด้วย `OP_BATCHER_MAX_CHANNEL_DURATION` ใน `~oprollup/.zrollup/env/op-batcher.env`)

## สิ่งที่ต่างจากเชน ZETAPHY เดิม (77390)

| เรื่อง | ZETAPHY (Cosmos) | เชนนี้ (Rollup) |
|---|---|---|
| ความปลอดภัย | validator ของเราเอง (เป้า ≥ 20 ราย) | ฝากกับ Ethereum: ข้อมูลธุรกรรมทุกชุดอยู่บน Sepolia |
| เหรียญแก๊ส | ZETAPHY | ETH (bridge มาจาก Sepolia) |
| ลายเซ็นต้านควอนตัม ML-DSA | มี (บัญชี PQ, vote, ใบรับรองบล็อก) | **ไม่มี** — OP Stack ยังเป็น ECDSA ทั้งระบบ |
| IBC / USDC จาก Noble | มี | ไม่มี (โลก EVM ใช้ bridge ของ OP Stack แทน) |
| ถ้า sequencer ล่ม | เชนหยุดถ้า validator หลักหยุด | ผู้ใช้ยังถอนผ่าน L1 ได้ (force inclusion ผ่าน portal) |
| ค่าใช้จ่ายต่อเนื่อง | 0 (เครื่องฟรี) | 0 บน testnet แต่บน mainnet มี "ค่าเช่า L1" เสมอ |

## ความปลอดภัย (testnet เท่านั้น)

- กุญแจ 4 ดอก (admin, batcher, proposer, sequencer) สร้างบนเครื่องและอยู่ที่
  `/home/oprollup/.zrollup-keys` (อ่านได้เฉพาะผู้ใช้ `oprollup`) **ไม่มีกุญแจใน repo นี้**
- ทุก binary build จากซอร์สที่ตรึง commit และตรวจ `git rev-parse HEAD` ก่อน build;
  Go toolchain ที่ใช้ถูกตรวจกับ checksum database สาธารณะของ Go
- เปิดสาธารณะแค่ 80/443 (Caddy → RPC ภายใน) ไม่มีพอร์ต P2P/authrpc โผล่ออกนอกเครื่อง
- RPC สาธารณะยังไม่มีตัวกรองแบบ rpc-guard ของเชนเดิม (เป็นงานขั้นถัดไป) —
  testnet รับได้ แต่อย่าเปิดเครื่องนี้ให้บริการอะไรที่มีมูลค่า
- `L1_TRUST_RPC=true`: โหนดเชื่อคำตอบของ RPC สาธารณะโดยไม่ตรวจ receipt ซ้ำ
  เพื่อลดปริมาณเน็ต — สำหรับ testnet พอเหมาะ, ก่อนจริงต้องรัน L1 node เองหรือปิดค่านี้

## สถานะของสคริปต์นี้

เขียนตามเวอร์ชันที่ตรึงไว้ข้างบนและทดสอบส่วนที่ทดสอบได้ (ไวยากรณ์ทั้งไฟล์,
ตัวช่วย `zrkeytool` คอมไพล์และสร้างกุญแจจริง) แต่**ยังไม่เคยรันครบวงจรบนเครื่องจริง**
(ต้องมีเครื่อง Oracle + faucet ETH) รอบแรกที่รันถ้าติดขั้นไหน ดู
`/var/log/zrollup-setup.log` — สคริปต์รันซ้ำได้ปลอดภัย (ทำต่อจากที่ค้าง:
op-deployer เก็บความคืบหน้าใน `state.json` ของมันเอง)
