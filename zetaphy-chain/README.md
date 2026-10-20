# ZETAPHY Chain — ขั้น 0: เชนทดลอง (testnet)

เชนทดลอง validator ตัวเดียว รันบน **Oracle Cloud** ทั้งหมด ทำผ่านหน้าเว็บ Oracle อย่างเดียว
ไม่ต้องรันอะไรบนคอมพิวเตอร์ของคุณ

| ค่า | ตั้งไว้ |
|---|---|
| ซอฟต์แวร์ | Cosmos SDK + Cosmos EVM `v0.7.3` (commit `c3ae906…` ตรวจตรงก่อน build) |
| Chain ID (Cosmos) | `zetaphy-testnet-1` |
| Chain ID (EVM / MetaMask) | `77390` (ยังว่างใน ethereum-lists/chains ณ 19 ต.ค. 2026) |
| เหรียญ | ZETAPHY, หน่วยย่อย `azetaphy` (1 ZETAPHY = 10^18) |
| ที่อยู่กระเป๋าแบบ Cosmos | ขึ้นต้น `zetaphy1…` (ใช้ที่อยู่ 0x… ใน MetaMask ได้ตามปกติ) |
| เวลาต่อบล็อก | ~5 วินาที |
| ซัพพลาย | 1,000,000,000 ZETAPHY ไม่มี inflation และลดลงตามค่าธรรมเนียมที่ถูกเผา (ครึ่งหนึ่งของค่าธรรมเนียมทุกบล็อก) |

การแบ่งเหรียญตอนเปิดเชน (ตามแผน แบบ B):

| ส่วน | จำนวน | หมายเหตุ |
|---|---|---|
| รางวัลคนรันร่างและ validator | 500,000,000 | บัญชี `rewards` ย้ายเข้า `RewardVault` (`zetaphy deploy-vault --fund`) ซึ่งปล่อยปีละ 10% ของที่เหลือ ถอนเร็วกว่านั้นไม่ได้ |
| แจกคนถือ SWD | 200,000,000 | บัญชี `swd-airdrop` รอ snapshot |
| กองทุนชุมชน | 150,000,000 | บัญชี `community` |
| สภาพคล่องและพาร์ทเนอร์ | 100,000,000 | หักให้ validator 1,000,000 และกระเป๋าคุณ 1,000,000 (ถ้าใส่) |
| ทีมพัฒนา | 50,000,000 | บัญชี vesting: ล็อก 1 ปี แล้วปลดแบบเส้นตรงจนครบปีที่ 4 |

---

## ตั้งเครื่องบน Oracle Cloud (ทำบนหน้าเว็บทั้งหมด)

### 1. สมัคร / เข้าสู่ระบบ
1. เข้า **cloud.oracle.com** สมัคร Free Tier (ต้องยืนยันบัตร แต่ทรัพยากร Always Free ไม่ถูกเก็บเงิน)
2. เลือก Home Region ใกล้ไทย เช่น **Singapore** (เปลี่ยนภายหลังไม่ได้)

### 2. สร้างเครื่อง
1. เมนู ☰ → **Compute → Instances → Create instance**
2. **Name:** `zetaphy-node-0`
3. **Image:** กด *Change image* → **Canonical Ubuntu 24.04**
4. **Shape:** กด *Change shape*
   - ถ้ามี **Ampere → VM.Standard.A1.Flex**: ตั้ง **2 OCPU / 12 GB** (หรือเท่าที่ฟรีให้) ← แนะนำ
   - ถ้าไม่มี: **VM.Standard.E2.1.Micro** (1 GB) ใช้ได้ แต่ติดตั้งนานขึ้นมาก (สคริปต์เพิ่ม swap ให้เอง)
5. **Networking:** ใช้ค่าเริ่มต้น (สร้าง VCN และ public subnet ใหม่) และให้มี **public IPv4**
6. **SSH keys:** เลือก *Generate a key pair for me* แล้วกด *Save private key* เก็บไว้เผื่อฉุกเฉิน
   (ขั้นตอนปกติไม่ต้องใช้)
7. กด **Show advanced options → Management → Paste cloud-init script**
   - เปิดไฟล์ [`setup-node.sh`](./setup-node.sh) บน GitHub → กด **Raw** → เลือกทั้งหมดแล้วคัดลอก → วางในช่องนี้
   - (ไม่บังคับ) ถ้าอยากได้เหรียญทดลอง 1,000,000 ZETAPHY ในกระเป๋า MetaMask ของคุณ:
     แก้บรรทัด `OWNER_EVM_ADDRESS="${OWNER_EVM_ADDRESS:-}"` เป็น
     `OWNER_EVM_ADDRESS="0xที่อยู่กระเป๋าของคุณ"` (ที่อยู่สาธารณะเท่านั้น ห้ามใส่ private key)
8. กด **Create** แล้วรอ: เครื่อง A1 ประมาณ 15–25 นาที, เครื่อง Micro อาจนานถึง 1–2 ชั่วโมง

### 3. เปิดพอร์ตให้คนภายนอกเข้าได้
1. ในหน้าเครื่อง → **Primary VNIC → Subnet** (ลิงก์) → **Security Lists** → *Default Security List*
2. **Add Ingress Rules** สองรายการ:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **8545** (สำหรับ MetaMask)
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **26656** (ให้เครื่องอื่นมาต่อเชน ในขั้น 1)
3. ไฟร์วอลล์ในตัวเครื่อง สคริปต์เปิดให้เองแล้ว

### 4. ตรวจว่าเชนทำงาน (ไม่ต้องใช้คอมพิวเตอร์)
- **ทางที่ง่ายที่สุด:** เพิ่มเครือข่ายใน MetaMask (บนมือถือก็ได้):
  - Network name: `ZETAPHY Testnet`
  - RPC URL: `http://<Public IP ของเครื่อง>:8545`
  - Chain ID: `77390`
  - Currency symbol: `ZETAPHY`
  ถ้าเพิ่มได้และเห็นยอด 1,000,000 ZETAPHY (กรณีใส่ OWNER_EVM_ADDRESS) แปลว่าเชนทำงานแล้ว
- **หรือใช้ Cloud Shell ของ Oracle** (ไอคอน `>_` มุมขวาบนของหน้าเว็บ Oracle) แล้ววาง:
  ```bash
  curl -s -X POST http://<Public IP>:8545 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  ```
  ตัวเลข `result` ควรเพิ่มขึ้นทุก ~5 วินาที

ถ้าผ่านไปนานแล้วยังไม่ทำงาน: หน้าเครื่อง → **Resources → Console connection**
แล้วดู log ที่ `/var/log/zetaphy-setup.log`

---

## ความปลอดภัย (testnet เท่านั้น)

- เหรียญบนเชนนี้ไม่มีมูลค่า ห้ามโฆษณาหรือขาย
- กุญแจของบัญชีตอนเปิดเชนเก็บแยกไว้ที่ `/home/zetaphy/.zetaphy-genesis-keys` (อ่านได้เฉพาะผู้ใช้ `zetaphy`)
  ไม่อยู่ในโฟลเดอร์ที่ node ใช้ คนที่ต่อ RPC จึงสั่งโอนเงินจากบัญชีเหล่านี้ไม่ได้
- เปิดสาธารณะแค่ 8545 (EVM JSON-RPC: eth, net, web3, txpool) และ 26656 (P2P)
  ส่วน 26657 / 1317 / 9090 ฟังเฉพาะในเครื่อง
- ก่อนขั้น 3 (เงินจริง) ต้องเปลี่ยน: กุญแจไปเก็บใน multisig/HSM, RPC ผ่าน https (Cloudflare Tunnel),
  validator อิสระ ≥ 20 ราย, audit ตามแผน

## สิ่งที่ขั้น 0 ยังไม่มี (ทำในขั้นถัดไป)

- ~~ระบบปล่อยรางวัลปีละ 10% ของกองที่เหลือ~~ ทำแล้ว: `RewardVault` ใน zetaphy-network
- ~~เผาค่าธรรมเนียมแบบ EIP-1559~~ ทำแล้ว: เผาครึ่งหนึ่งของค่าธรรมเนียมทุกบล็อก (`evmd/zetaphy_feeburn.go` ใน patch) อีกครึ่งให้ validator
- ~~จ่ายค่าธรรมเนียมเป็น USDC~~ ทำแล้วผ่าน StableGateway + relay (zetaphy-network ขั้น 2)
- โปรแกรม `zetaphy node start` สำหรับคนรันร่าง Neuro
- ลายเซ็นต้านควอนตัม, สะพานเชื่อมเชน

## ขั้น 5: ลายเซ็นต้านควอนตัม (ML-DSA)

`setup-node.sh` ใส่ patch ไว้ท้ายไฟล์ ตอน build จะทำ 3 อย่าง:
1. เพิ่ม precompile ตรวจลายเซ็น ML-DSA (FIPS 204) ที่ `0x0000000000000000000000000000000000000900` ใช้ Cloudflare CIRCL v1.6.3
2. รันชุดทดสอบของ precompile ก่อน build ถ้าไม่ผ่าน การติดตั้งจะหยุด
3. เปิดใช้ precompile นี้ใน genesis

กระเป๋าที่ใช้ precompile นี้ได้แก่ `QuantumWallet` ใน `zetaphy-network` (คำสั่ง `zetaphy pq`)

เครื่องที่ติดตั้งก่อนหน้านี้ต้อง build ใหม่: `FORCE_BUILD=1 bash setup-node.sh`
- ถ้าเชนรันอยู่แล้ว การเปิด precompile ใหม่ต้องผ่านการโหวตอัปเกรดด้วย `gov.sh`
