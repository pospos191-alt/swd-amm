[English](README.md) | **ภาษาไทย**

# ZETAPHY Chain — ขั้น 0: เชนทดลอง (testnet)

เชนทดลอง validator ตัวเดียว รันบน **Oracle Cloud** ทั้งหมด ทำผ่านหน้าเว็บ Oracle อย่างเดียว
ไม่ต้องรันอะไรบนคอมพิวเตอร์ของคุณ

| ค่า | ตั้งไว้ |
|---|---|
| ซอฟต์แวร์ | Cosmos SDK + Cosmos EVM `v0.7.3` (commit `c3ae906…` ตรวจตรงก่อน build) |
| Chain ID (Cosmos) | `zetaphy_77390-1` |
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
   - เปิดไฟล์ [`cloud-init.sh`](./cloud-init.sh) บน GitHub → กด **Raw** → เลือกทั้งหมดแล้วคัดลอก → วางในช่องนี้
     - ไฟล์นี้สั้นแค่ไม่กี่บรรทัด: ดาวน์โหลด [`setup-node.sh`](./setup-node.sh) ตัวเต็มจาก repo สาธารณะ
       [github.com/pospos191-alt/zetaphy-chain](https://github.com/pospos191-alt/zetaphy-chain)
       (ตัวเต็มใหญ่เกินที่ Oracle รับได้ 32,000 ไบต์) แล้วรันเฉพาะเมื่อลายนิ้วมือ SHA-256 ตรงกับที่เขียนไว้ในไฟล์
     - ไฟล์ใน repo สาธารณะตั้งชื่อตาม SHA-256 และไม่ถูกแก้อีก CI ตรวจทุกครั้งว่า `cloud-init.sh` ตรงกับ `setup-node.sh`
   - (ไม่บังคับ) ถ้าอยากได้เหรียญทดลอง 1,000,000 ZETAPHY ในกระเป๋า MetaMask ของคุณ:
     แก้บรรทัด `OWNER_EVM_ADDRESS=""` ใน `cloud-init.sh` ที่วางแล้วเป็น
     `OWNER_EVM_ADDRESS="0xที่อยู่กระเป๋าของคุณ"` (ที่อยู่สาธารณะเท่านั้น ห้ามใส่ private key)
8. กด **Create** แล้วรอ: เครื่อง A1 ประมาณ 15–25 นาที, เครื่อง Micro อาจนานถึง 1–2 ชั่วโมง

### 3. เปิดพอร์ตให้คนภายนอกเข้าได้
1. ในหน้าเครื่อง → **Primary VNIC → Subnet** (ลิงก์) → **Security Lists** → *Default Security List*
2. **Add Ingress Rules** (Source CIDR `0.0.0.0/0`, IP Protocol **TCP**) ทีละพอร์ต:
   - **8545** สำหรับ MetaMask
   - **26656** ให้เครื่องอื่นมาต่อเชน (ในขั้น 1)
   - **80** และ **443** สำหรับ https (กระเป๋าบนเว็บต้องใช้ https)
     - สคริปต์ติดตั้ง Caddy (จากคลังโปรแกรมของ Ubuntu) ซึ่งขอใบรับรอง Let's Encrypt ฟรีให้อัตโนมัติ
     - ที่อยู่คือ `https://<IP ที่เปลี่ยนจุดเป็นขีด>.sslip.io` เช่น IP `1.2.3.4` → `https://1-2-3-4.sslip.io`
     - sslip.io เป็นบริการ DNS ฟรีที่ชื่อชี้กลับมาที่ IP นั้นเอง
     - ถ้าเปิดพอร์ตหลังเครื่องติดตั้งเสร็จ Caddy จะลองขอใบรับรองซ้ำเอง
3. ไฟร์วอลล์ในตัวเครื่อง สคริปต์เปิดให้เองแล้ว

### 4. ตรวจว่าเชนทำงาน (ไม่ต้องใช้คอมพิวเตอร์)
- **ทางที่ง่ายที่สุด:** เพิ่มเครือข่ายใน MetaMask (บนมือถือก็ได้):
  - Network name: `ZETAPHY Testnet`
  - RPC URL: `http://<Public IP ของเครื่อง>:8545`
  - Chain ID: `77390`
  - Currency symbol: `ZTPHY` (MetaMask และ chainlist รับได้ไม่เกิน 6 ตัว ดู [`wallets/README.md`](./wallets/README.th.md))
  ถ้าเพิ่มได้และเห็นยอด 1,000,000 ZTPHY (= ZETAPHY, กรณีใส่ OWNER_EVM_ADDRESS) แปลว่าเชนทำงานแล้ว
  - กระเป๋าอื่น (Rabby, Trust, OKX, Coinbase, Keplr, Leap, Ledger, มือถือ) และการขึ้นรายชื่อ chainlist / Keplr: [`wallets/README.md`](./wallets/README.th.md)
- **หรือใช้ Cloud Shell ของ Oracle** (ไอคอน `>_` มุมขวาบนของหน้าเว็บ Oracle) แล้ววาง:
  ```bash
  curl -s -X POST http://<Public IP>:8545 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  ```
  ตัวเลข `result` ควรเพิ่มขึ้นทุก ~5 วินาที
- กระเป๋าบนเว็บ (`zetaphy-wallet`) ใส่ RPC เป็น `https://<IP ที่เปลี่ยนจุดเป็นขีด>.sslip.io`

ถ้าผ่านไปนานแล้วยังไม่ทำงาน: หน้าเครื่อง → **Resources → Console connection**
แล้วดู log ที่ `/var/log/zetaphy-setup.log`

### Google Cloud e2-micro (ฟรีถาวร)

Google Cloud ให้เครื่อง **e2-micro** ฟรีถาวรเครื่องเดียว (RAM 1 GB, ดิสก์ 30 GB, เฉพาะเขต US)
เล็กกว่า Oracle มาก: build นาน 1–2 ชั่วโมงขึ้นไป (สคริปต์เพิ่ม swap 4 GB ให้เอง) และ RAM ตึง
1. สมัครที่ **cloud.google.com/free** (ต้องยืนยันบัตร ใช้แค่ส่วนฟรีไม่ถูกเก็บเงิน)
2. **Compute Engine → VM instances → Create instance**
   - **Region:** `us-central1` (หรือ `us-west1`, `us-east1` เท่านั้นที่ฟรี) · **Machine type:** `e2-micro`
   - **Boot disk:** Ubuntu 24.04 LTS (x86/64), **Standard persistent disk** 30 GB
   - **Firewall:** ติ๊ก Allow HTTP และ HTTPS
   - **Advanced → Management → Metadata → Add item:** Key = `user-data`
     Value = เนื้อไฟล์ [`setup-node.sh`](./setup-node.sh) ทั้งไฟล์ (Google รับได้ใหญ่กว่า Oracle จึงไม่ต้องใช้ `cloud-init.sh`)
     ถ้าจะรับเหรียญทดลอง แก้บรรทัด `OWNER_EVM_ADDRESS="${OWNER_EVM_ADDRESS:-}"` เป็น `OWNER_EVM_ADDRESS="0x…"`
3. **VPC network → Firewall → Create firewall rule:** Targets = All instances, Source `0.0.0.0/0`,
   TCP `26656` เท่านั้น (ไม่ต้องเปิด 8545: กระเป๋าและเว็บใช้ `https://<IP มีขีด>.sslip.io` ซึ่งบีบอัดข้อมูล ประหยัดกว่า)
4. ตรวจแบบเดียวกับข้อ 4 ข้างบน (ใช้ External IP ของเครื่อง) ดู log ได้ที่ปุ่ม **SSH** ในหน้าเครื่อง: `sudo tail -f /var/log/zetaphy-setup.log`
5. **กันเสียเงิน (สำคัญ):** **Billing → Budgets & alerts → Create budget** ตั้ง $1 และให้ส่งอีเมลที่ 50% / 100%

**ส่งข้อมูลออกฟรีแค่ 1 GB/เดือน** ส่วนที่เกินคิดเงิน สคริปต์รู้เองว่าเป็น e2-micro แล้วเปิด **โหมดประหยัด** ให้:
- peer น้อย (เข้า 4 / ออก 2) และจำกัดความเร็วส่งต่อ peer 256 KB/s
- บีบอัด (gzip/zstd) ทุกคำตอบผ่าน https และจำกัดขนาดคำตอบ RPC (logs 500 รายการ, batch 20)
- **ตัวเฝ้าโควต้า** ทุก 10 นาที: ถ้าเดือนนี้ส่งออกเกิน 800 MB จะปิด RPC สาธารณะชั่วคราว
  (เชนยังเดินต่อ บล็อกไม่หยุด) แล้วเปิดเองเมื่อขึ้นเดือนใหม่
  ดูยอด: ปุ่ม **SSH** → `cat /var/lib/zetaphy-egress/status`
- บังคับเปิด/ปิด: แก้บรรทัด `LOW_EGRESS="${LOW_EGRESS:-auto}"` ในสคริปต์เป็น `1` หรือ `0`,
  เปลี่ยนเพดานที่ `EGRESS_LIMIT_MB`

ข้อจำกัด: RAM 1 GB พอสำหรับเชนอย่างเดียว ยังไม่ควรรัน relayer IBC หรือตัวรัน Neuro บนเครื่องนี้
เมื่อจะเปิดให้คนทั่วไปใช้ ให้ย้ายไปเครื่องที่ใหญ่กว่า (เช่น Contabo / OVH) ด้วยสคริปต์เดิมและไฟล์กุญแจ validator

---

## เข้าร่วมเชน: เป็น node หรือ validator (ให้เชนไม่อยู่ที่เครื่องเดียว)

**คำสั่งเดียว (แนะนำ):** บนเครื่อง Ubuntu 24.04 ใดก็ได้ (Oracle ฟรี, Google ฟรี, VPS) วางคำสั่งนี้:
```bash
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo MONIKER=ชื่อของคุณ bash -s -- validator
```
- ใช้ไฟล์เชนสำเร็จรูป (ตรวจ SHA-256) ไม่ต้อง build เอง ต่อเข้ากับ `rpc.sawasdeecoin.com` และขอ 10 ZETAPHY จาก faucet ให้เอง
- ตัวจับเวลาเช็กทุก 10 นาที: ซิงก์ครบและมีเหรียญแล้ว จะ stake 9 ZETAPHY เป็น validator เอง แล้วหยุดเช็ก
- `sudo zetaphy-validator status` ดูความคืบหน้า, `sudo zetaphy-validator backup` ไฟล์ที่ต้องเก็บไว้ออฟไลน์,
  `sudo zetaphy-validator unjail` กลับมาทำงานหลังถูกพักเพราะเครื่องดับ
- เปิดพอร์ต 26656 (และ 80, 443) ใน firewall ของผู้ให้บริการคลาวด์ หรือใช้ปุ่ม Oracle (`deploy/oracle`) เลือก `validator` ซึ่งเปิดให้เอง

วิธีเดิมแบบทำเองทีละขั้น:

ใครก็เข้าร่วมได้ด้วยเครื่องฟรีแบบเดียวกัน (Oracle / Google) โดยไม่ต้องมีไฟล์จาก repo นี้
เครื่องแรกเผยแพร่สิ่งที่ต้องใช้ไว้ที่ `https://<ชื่อ>.sslip.io/zetaphy/` (genesis, ที่อยู่ peer, สคริปต์ติดตั้ง)

1. ตอนสร้างเครื่อง วางสคริปต์สั้น ๆ นี้แทน `cloud-init.sh` (แก้ `JOIN` เป็นชื่อ https ของเครื่องที่จะเข้าร่วม):
   ```bash
   #!/bin/bash
   JOIN=1-2-3-4.sslip.io
   curl -fsS "https://$JOIN/zetaphy/setup-node.sh" -o /root/zetaphy-setup-node.sh
   JOIN=$JOIN bash /root/zetaphy-setup-node.sh
   ```
   - เครื่องจะ build เชนแบบเดียวกัน ดึง genesis และต่อเข้ากับเครื่องนั้น แล้วซิงก์บล็อกทั้งหมด
   - สร้างกุญแจ `validator` ให้ แล้วขอ 10 ZETAPHY จาก faucet ของเครื่องแรกให้เอง
2. เปิดพอร์ต 26656 (และ 8545, 80, 443 ถ้าจะให้บริการ RPC ด้วย) แบบเดียวกับข้อ 3
3. (ถ้าจะเป็น validator) เมื่อซิงก์เสร็จ เข้าเครื่องทาง SSH ของหน้าเว็บ Oracle/Google แล้วสั่ง:
   ```bash
   sudo bash /root/zetaphy-setup-node.sh --become-validator 9   # stake 9 ZETAPHY
   ```
4. **ให้ validator ใหม่มีเสียงจริง (delegation program):** stake ของคนใหม่น้อยมากเมื่อเทียบกับเครื่องแรก
   ผู้ดูแลกองทุนชุมชนแบ่ง stake ให้ได้บนเครื่องแรก:
   ```bash
   gov.sh validators                              # ใครเป็น validator และถือเสียงกี่ %
   gov.sh delegate zetaphyvaloper1… 50000         # stake จากกองทุนชุมชนให้ validator นั้น
   ```
   เป้าของประตู 3: validator อิสระ ≥ 20 ราย และไม่มีใครถือเกิน 33%

**Faucet (testnet):** `zetaphy_faucet` บนพอร์ต 8545 ให้ 10 ZETAPHY ต่อที่อยู่ วันละครั้ง (รวมไม่เกิน 200 ครั้งต่อวัน)
และไม่ให้ที่อยู่ที่มีเงินอยู่แล้ว ใช้กุญแจแยกที่ถือ 1,000,000 ZETAPHY ทดลอง (จากส่วนสภาพคล่อง) เท่านั้น
```bash
curl -s https://<ชื่อ>.sslip.io -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"zetaphy_faucet","params":["0xที่อยู่ของคุณ"]}'
```

## เครื่องเล็ก (เช่น RAM 1 GB)

สคริปต์ปรับเองตาม RAM ของเครื่อง:
- เก็บ state ย้อนหลังราว 6 วัน (pruning) ดิสก์จึงไม่โตไม่หยุด
- RAM ต่ำกว่า 3 GB: compile ทีละงาน, cache เล็กลง และเพิ่ม swap 4 GB
- จำกัดหน่วยความจำของ node ไว้ที่ 60% ของ RAM (`GOMEMLIMIT`) กันเครื่องค้าง

### ไฟล์เชนสำเร็จรูป

compile บนเครื่อง RAM 1 GB ใช้เวลาหลายชั่วโมง (หรือลิงก์ไม่จบ) GitHub Actions สร้าง `zetaphyd` ให้ทุกครั้งที่มี
`setup-node.sh` รุ่นใหม่ (x86_64 และ ARM64) แล้วเผยแพร่เป็น release `zetaphyd-<sha256 ของสคริปต์ 12 ตัวแรก>`
พร้อม `SHA256SUMS` ติดตั้งด้วย `ZETAPHYD_BIN=`:

```bash
S=<sha256 ของสคริปต์>; R=zetaphyd-${S:0:12}; ARCH=amd64   # เครื่อง ARM ใช้ arm64
cd /tmp
curl -fsSLO https://github.com/pospos191-alt/swd-amm/releases/download/$R/zetaphyd-linux-$ARCH
curl -fsSLO https://github.com/pospos191-alt/swd-amm/releases/download/$R/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/zetaphy-chain/main/v/$S.sh -o setup.sh
echo "$S  setup.sh" | sha256sum -c
sudo OWNER_EVM_ADDRESS=0x<ที่อยู่กระเป๋าของคุณ> ZETAPHYD_BIN=/tmp/zetaphyd-linux-$ARCH \
  setsid bash setup.sh >/dev/null 2>&1 </dev/null &
sudo tail -f /var/log/zetaphy-setup.log     # Ctrl+C เลิกดู การติดตั้งยังทำต่อ
```

สคริปต์รันได้ทีละรอบ ถ้าสั่งซ้ำ รอบที่สองจะบอกแล้วออกเอง ใครก็ build ไฟล์นี้ใหม่จากซอร์สเดียวกัน
(`.github/workflows/release-zetaphyd.yml`) แล้วเทียบ hash ได้

### ใช้โดเมนของตัวเองเป็น RPC

แทน `<ip>.sslip.io` กระเป๋าใช้ชื่อของคุณเองได้ (IP เครื่องเปลี่ยนก็ยังใช้ได้ และจำเป็นสำหรับการขึ้นรายชื่อ chainlist / Keplr)
ที่ผู้ให้บริการ DNS เพิ่ม **A record** เช่น `rpc` → IP ของเครื่อง (DNS only ไม่ผ่าน proxy) แล้วรันคำสั่งติดตั้งเดิมอีกครั้ง
โดยเติม `PUBLIC_HOST=rpc.<โดเมนของคุณ>` หลัง `sudo` Caddy จะรับทั้งสองชื่อและออกใบรับรองเอง `keplr.json` กับ `evm-chain.json`
ใช้ชื่อใหม่ การรันซ้ำไม่กระทบเชน กุญแจ และ genesis


WebSocket: `wss://<ชื่อ>/ws` (EVM JSON-RPC เช่น `eth_subscribe` รับบล็อกใหม่และ log) Caddy ส่งต่อไปที่พอร์ต 8546 บนเครื่อง
โหนดที่ติดตั้งก่อนเวอร์ชันนี้ ได้ WebSocket เมื่อรันคำสั่งติดตั้งเดิมอีกครั้ง
## ความปลอดภัย (testnet เท่านั้น)

- เหรียญบนเชนนี้ไม่มีมูลค่า ห้ามโฆษณาหรือขาย
- กุญแจของบัญชีตอนเปิดเชนเก็บแยกไว้ที่ `/home/zetaphy/.zetaphy-genesis-keys` (อ่านได้เฉพาะผู้ใช้ `zetaphy`)
  ไม่อยู่ในโฟลเดอร์ที่ node ใช้ คนที่ต่อ RPC จึงสั่งโอนเงินจากบัญชีเหล่านี้ไม่ได้
- เปิดสาธารณะแค่ 8545 (EVM JSON-RPC: eth, net, web3, txpool, zetaphy), 26656 (P2P) และ 80/443 (Caddy: https ที่ส่งต่อไป 8545 ตัวเดียวกัน)
  ส่วน 26657 / 1317 / 9090 ฟังเฉพาะในเครื่อง
  - `zetaphy_sendCosmosTx` แค่ส่งต่อธุรกรรมที่เซ็นมาแล้ว (เหมือน `eth_sendRawTransaction`) ไม่ถือกุญแจใด ๆ
- ก่อนขั้น 3 (เงินจริง) ต้องเปลี่ยน: กุญแจไปเก็บใน multisig/HSM, https บนชื่อโดเมนของโครงการเอง (แทน sslip.io),
  validator อิสระ ≥ 20 ราย, audit ตามแผน

## สิ่งที่ขั้น 0 ยังไม่มี (ทำในขั้นถัดไป)

- ~~ระบบปล่อยรางวัลปีละ 10% ของกองที่เหลือ~~ ทำแล้ว: `RewardVault` ใน zetaphy-network
- ~~เผาค่าธรรมเนียมแบบ EIP-1559~~ ทำแล้ว: เผาครึ่งหนึ่งของค่าธรรมเนียมทุกบล็อก (`evmd/zetaphy_feeburn.go` ใน patch) อีกครึ่งให้ validator
- ~~จ่ายค่าธรรมเนียมเป็น USDC~~ ทำแล้วผ่าน StableGateway + relay (zetaphy-network ขั้น 2)
- ~~โปรแกรม `zetaphy node start` สำหรับคนรันร่าง Neuro~~ ทำแล้วใน zetaphy-network
- ~~ลายเซ็นต้านควอนตัม~~ ทำแล้ว (ขั้น 5 ข้างล่าง)
- ~~เพดานการโอนผ่าน IBC~~ ทำแล้ว (ขั้น 3 ข้างล่าง)
- ~~สัญญามาตรฐานของ EVM~~ ทำแล้ว: เชนใหม่มี CREATE2 deployer (`0x4e59…956C`), Multicall3 (`0xcA11…CA11`), Permit2 (`0x0000…8BA3`) และ Safe singleton factory (`0x914d…43d7`) ตั้งแต่ genesis (`app_state.evm.preinstalls`) ที่อยู่และโค้ดตรงกับ Ethereum จึงใช้กับกระเป๋าและเครื่องมือ dev ได้ทันที (EIP-2935 เชนติดตั้งเอง ไม่อยู่ในรายการนี้)
- สะพานเชื่อมเชนจริง (ต้องมีเชนปลายทางและ relayer)

## ขั้น 3: เพดานการโอนผ่าน IBC (เช่น USDC จาก Noble)

เชนมีโมดูล `x/ratelimit` คั่นอยู่บนทางโอนเหรียญข้ามเชน (IBC ทั้ง v1 และ v2)
- เป็นโค้ดที่เผยแพร่แล้วของ ibc-apps (rate-limiting v10.7.0) ตรวจ hash ก่อนใช้ แล้ว patch ให้ใช้กับ ibc-go v11
- governance ตั้งเพดานต่อเหรียญต่อช่อง เป็น % ของเหรียญนั้นที่มีบนเชน ในช่วงเวลาที่กำหนด แยกขาเข้าและขาออก
- โอนที่จะทำให้เกินเพดานจะถูกปฏิเสธ เงินไม่หาย (ขาออก: ธุรกรรมไม่ผ่าน, ขาเข้า: เงินคืนผู้ส่ง)
  - ถ้าสะพานฝั่งโน้นถูกแฮ็ก จะเสียหายได้ไม่เกินเพดานของช่วงนั้น
- ใช้คู่กับ `BridgeGuard` (zetaphy-network) ซึ่งคุมเพดานฝั่งสัญญา EVM

เมื่อเปิดช่อง IBC ไป Noble แล้ว เสนอเพดาน USDC ด้วย (บนเครื่องโหนด ในฐานะผู้ใช้ `zetaphy`):
```
gov.sh propose-ratelimit ibc/<hash ของ USDC> channel-0 10 10 24   # เข้า/ออกไม่เกิน 10% ต่อ 24 ชม.
gov.sh vote <id> yes
gov.sh ratelimits
```

## ขั้น 3 ต่อ: USDC จริงจาก Noble (IBC + relayer)

ชุดเครื่องมือใน [`ibc/`](ibc/README.th.md) ต่อ ZETAPHY กับ Noble (เชนที่ Circle ออก USDC เอง) ทำบนเครื่องโหนดผ่าน Cloud Shell ทั้งหมด ฟรี:
```
sudo bash setup-relayer.sh                  # Hermes (ตรึงเวอร์ชัน + SHA-256), ผู้ใช้ relayer, กุญแจ; พิมพ์แค่ที่อยู่ให้เติมแก๊ส
sudo bash setup-relayer.sh create-channel   # light client + connection + ช่อง transfer
sudo bash setup-relayer.sh start            # service hermes-relayer (status / balances / stop)
sudo bash setup-relayer.sh send-usdc <0x…> 1000000   # USDC ก้อนแรก 1 USDC
gov.sh ibc-usdc-erc20 channel-0             # ที่อยู่ ERC-20 ของ USDC สำหรับ MetaMask, explorer, DEX
gov.sh ibc-usdc-ratelimit channel-0         # เพดานต่ำ 1% / 1% ต่อ 24 ชม. (โหวต)
```
- USDC บน ZETAPHY คือเหรียญ `ibc/<sha256("transfer/<ช่อง>/uusdc")>` (`gov.sh ibc-usdc-denom <ช่อง>`)
  โมดูล erc20 ของ Cosmos EVM v0.7.3 ทำให้เป็น ERC-20 เองตอนเหรียญแรกมาถึง (ไม่มี proposal ลงทะเบียน)
- testnet ปัจจุบัน: ERC-20 นี้ตอบ `decimals()` = 0 (metadata ค่าเริ่มต้นของ ibc-go) แก้ได้ด้วยการอัปเกรดเชนหรือใส่ `gov.sh ibc-usdc-metadata` ใน genesis ของเชนใหม่
- relayer ล่มทำให้โอนช้าแต่เงินไม่หาย (light client ตรวจกันเอง) แต่ห้ามหยุดเกิน 14 วัน; light client ของ IBC ตรวจ ed25519 ซึ่งไม่ต้านควอนตัม
- testnet ก่อน (Noble `grand-1`); mainnet (`noble-1`) หลังผ่าน audit เท่านั้น
- ทดสอบบนเชนทดลอง 2 เชนโดยไม่ต้องใช้ Noble: `ibc/test-ibc.sh` (`npm run test:devnet:ibc` ใน zetaphy-network)

## ขั้น 5: ลายเซ็นต้านควอนตัม (ML-DSA)

`setup-node.sh` ใส่ patch ไว้ท้ายไฟล์ ตอน build จะเพิ่มสิ่งต่อไปนี้ (รวมข้อ 8–10 เรื่องเลขสุ่ม การเผาเหรียญ และความสูงเปิดใช้):
1. precompile ตรวจลายเซ็น ML-DSA (FIPS 204) ที่ `0x0000000000000000000000000000000000000900` (Cloudflare CIRCL v1.6.3) เปิดใช้ใน genesis
   - กระเป๋าที่ใช้คือ `QuantumWallet` ใน `zetaphy-network` (คำสั่ง `zetaphy pq`) ซึ่งยังต้องมีบัญชี ECDSA จ่ายค่าแก๊ส
2. **บัญชี PQ แท้:** บัญชีที่มีแค่กุญแจ ML-DSA-44 (`crypto/mldsa44`) ใช้ส่งธุรกรรม Cosmos ธรรมดาได้เลย ไม่มีกุญแจ ECDSA และไม่ต้องมีคนจ่ายค่าแก๊สแทน
   - ที่อยู่ = `sha256("zetaphy/mldsa44\0" + public key)[0:20]` เห็นได้ทั้งแบบ `zetaphy1…` และ `0x…`
   - ส่งผ่านพอร์ต 8545 เดิมด้วย JSON-RPC `zetaphy_pqAccount` และ `zetaphy_sendCosmosTx` (ไม่ต้องเปิดพอร์ตใหม่)
   - ใช้ได้จาก `zetaphy pq native` และกระเป๋าบนเว็บ `zetaphy-wallet/`
   - ทดสอบบนเชนจริงแล้ว: ส่งได้ และเชนปฏิเสธธุรกรรมที่ใช้กุญแจอื่นสวมบัญชี ลายเซ็นที่ถูกแก้ และธุรกรรมเก่าที่ส่งซ้ำ
   - stake / ถอน stake / รับรางวัล ด้วยกุญแจ ML-DSA ได้ (ข้อความ staking มาตรฐานของ Cosmos)
3. **บัญชี PQ ใช้ EVM ได้ครบ (`MsgEVMCall`, `evmd/zetaphy_pqcall.go`):** ส่งโทเคน ERC-20 ใช้ DEX เรียกสัญญาใดก็ได้ และ**สร้างสัญญาใหม่**ได้ (เว้น `to` ว่าง) โดย `msg.sender` คือที่อยู่ `0x…` ของบัญชี PQ เอง
   - ค่าแก๊ส EVM คิดรวมในค่าธรรมเนียม Cosmos ตามกติกาเดียวกับธุรกรรม EVM ปกติ (เพดานคืนแก๊ส และขั้นต่ำ) จำกัด 10 ล้านแก๊สต่อครั้ง
   - ถ้าสัญญา revert ทั้งธุรกรรมถูกยกเลิก (เงินและโทเคนไม่ขยับ) แต่เสียค่าธรรมเนียม
   - สร้างสัญญาได้ 1 สัญญาต่อธุรกรรม และ log ของการเรียกแบบนี้ไม่ขึ้นใน `eth_getLogs` (ยอดคงเหลือถูกต้อง)
4. **ล็อกควอนตัม (`evmd/zetaphy_pqguard.go`):** บัญชี MetaMask (ECDSA) ยกการควบคุมให้บัญชี ML-DSA-44 ได้ถาวร
   - ทำจาก MetaMask เอง: ส่งธุรกรรม 0 ZETAPHY ไปที่ `0x0000000000000000000000000000000000005051` โดยใส่ data เป็นที่อยู่ 20 ไบต์ของบัญชีผู้ควบคุม (กระเป๋าเว็บมีปุ่มให้) หรือ `gov.sh quantum-lock` บนเซิร์ฟเวอร์
   - ผู้ควบคุมต้องเป็นบัญชี ML-DSA-44 ที่เคยส่งธุรกรรมแล้ว (เชนรู้กุญแจสาธารณะ)
   - หลังล็อก เชนปฏิเสธทุกธุรกรรมที่กุญแจ ECDSA เดิมเซ็น ทั้งแบบ EVM และ Cosmos (รวม authz และ fee grant)
   - ที่อยู่ 0x เดิม เงิน โทเคน และสิทธิ์ในสัญญา (เช่น owner/admin) อยู่ที่เดิม ผู้ควบคุมสั่งแทนผ่าน `MsgEVMCall` ช่อง `as_owner` (`zetaphy pq native … --as <0x…>`)
   - ผู้ควบคุมโอนสิทธิ์ต่อให้บัญชี ML-DSA อื่นได้ (`MsgQuantumLock`) แต่ปลดล็อกกลับเป็น ECDSA ไม่ได้
   - กุญแจเดิมใช้ไม่ได้ทุกทาง: ลงชื่อธุรกรรม, เป็นผู้จ่ายค่าธรรมเนียม, authz, fee grant, EIP-7702 และลายเซ็นที่สัญญาตรวจด้วย `ecrecover` (เช่น `permit`) ส่วน MetaMask จะได้ข้อความ "quantum-locked" ทันทีที่ส่ง
   - บัญชี ML-DSA ล็อกไม่ได้ (ต้านควอนตัมอยู่แล้ว) จึงไม่มีการล็อกต่อกันเป็นทอดจนบัญชีค้าง
   - การล็อกและกุญแจโหวตติดไปกับ genesis export (`app_state.zetaphypq`)
5. **ลายเซ็น ML-DSA ในการโหวตบล็อก:** CometBFT เซ็นโหวตด้วย ed25519 เท่านั้น จึงให้ validator เซ็น ML-DSA-44 แนบไปกับทุกโหวตยืนยันบล็อก (vote extension) และโหนดทิ้งโหวตของ validator ที่ลงทะเบียนกุญแจแล้วแต่ลายเซ็น ML-DSA ไม่ถูก
   - กุญแจอยู่ที่ `config/pq_vote_key.seed` (สร้างอัตโนมัติ สำรองไว้คู่กับ `priv_validator_key.json`) และลงทะเบียนอัตโนมัติตอนติดตั้งหรือ `--become-validator`
   - เมื่อ validator ที่ถือ stake รวมเกิน 2/3 ลงทะเบียนแล้ว การปลอมลายเซ็น ed25519 อย่างเดียวจะยืนยันบล็อกไม่ได้
   - validator ที่ยังไม่ลงทะเบียนไม่ถูกตรวจ จึงลงทะเบียนทีหลังได้เสมอโดยเชนไม่ค้าง
   - ถ้าไฟล์กุญแจไม่ตรงกับที่ลงทะเบียน โหนดจะหยุดตัวเองแทนการส่งโหวตที่ถูกปฏิเสธ (ส่งโหวตผิดอาจทำให้เชนค้าง ส่วนโหนดหยุดเท่ากับออฟไลน์)
   - เปลี่ยนกุญแจ: ย้ายไฟล์เดิมเป็น `pq_vote_key.seed.old` ใส่กุญแจใหม่ แล้ว `gov.sh vote-key` (ต้องมีลายเซ็นกุญแจเดิม)
   - ทำกุญแจหาย: ดูข้อ 7 (ต้องล็อกควอนตัมบัญชี operator ไว้)
   - เปลี่ยนกุญแจได้ครั้งเดียวต่อบล็อก
   - ถ้าบัญชี operator ถูกล็อกควอนตัม ผู้ควบคุมลงทะเบียนแทนได้ (ช่อง `validator_owner` ของ `MsgPQVoteKey`)
6. **ใบรับรองบล็อก ML-DSA (`evmd/zetaphy_pqcert.go`):** ผู้เสนอบล็อก H+1 ใส่ลายเซ็น ML-DSA ของการโหวตบล็อก H เป็นธุรกรรมแรกของบล็อก (`MsgPQCertificate`)
   - ทุกโหนดตรวจ ทั้งตอนรับข้อเสนอบล็อก และตอนรันบล็อก รวมถึงโหนดใหม่ที่ sync ย้อนหลัง (blocksync)
   - กติกา: ผู้เซ็นที่ถูกต้องต้องมีพลังโหวตเกิน 2/3 ของทั้งหมด ลบด้วยพลังของ validator ที่ยังไม่ลงทะเบียนกุญแจ
   - เชนที่ปลอมด้วย ed25519 อย่างเดียวจึงถูกโหนดปฏิเสธ (โหนดหยุดแทนที่จะเดินตามเชนปลอม)
   - ใครก็ตรวจบล็อกแบบต้านควอนตัมเองได้: `zetaphy pq verify-block <height>` (ดู `zetaphy-network`)
   - ตั้งแต่ความสูงเปิดใช้ v2 (ข้อ 10): ถ้าผู้เสนอบล็อกเป็น validator ของบล็อก H และลงทะเบียนกุญแจแล้ว ใบรับรองต้องมีลายเซ็นของผู้เสนอเองด้วย (ผู้เสนอเซ็นให้ตัวเองตอนเสนอได้ แม้โหวตของตัวเองไม่อยู่ใน commit) จึงเลือกไม่ใส่ตัวเองหรือไม่ส่งใบรับรองเลยไม่ได้
   - กติกานี้ไม่ทำให้เชนค้าง: ผู้เสนอที่ไม่มีกุญแจที่ถูกต้องแค่เสียรอบของตัวเอง แล้วผู้เสนอคนถัดไปเสนอแทน (ถ้าทุกคนไม่มีกุญแจที่ถูก กติกา 2/3 เดิมก็ไม่ผ่านอยู่แล้ว)
   - ส่วนกติกาที่เข้มกว่า "ต้องมีใบรับรองที่ไม่ว่างเมื่อมีใครลงทะเบียนกุญแจ" ไม่ได้ใช้ เพราะทำให้เชนค้างได้ เช่นถ้า validator คนเดียวที่มีกุญแจ (พลังโหวตน้อยกว่า 1/3) ออฟไลน์ ทุกบล็อกจะไม่มีลายเซ็นให้ใส่
7. **สวิตช์หลักฐานการเซ็นซ้ำ:** CometBFT พิสูจน์การเซ็นซ้ำด้วย ed25519 เท่านั้น ซึ่งคอมพิวเตอร์ควอนตัมอาจปลอมเพื่อให้ validator ที่สุจริตถูกปรับได้
   - เมื่อถึงวันที่ ed25519 ไม่ปลอดภัย ให้เสนอ `gov.sh pq-evidence on` แล้วโหวตตามปกติ (`gov.sh vote <id> yes`)
   - เมื่อผ่าน เชนไม่ลงโทษจากหลักฐาน ed25519 อย่างเดียว สำหรับ validator ที่มีกุญแจ ML-DSA (ไม่ต้องเปลี่ยนโปรแกรมเชน)
   - `gov.sh pq-evidence off` สลับกลับ; ค่าเริ่มต้นคือปิด (ลงโทษตามปกติ) เพราะวันนี้ ed25519 ยังปลอดภัยและการลงโทษช่วยกันการเซ็นซ้ำจริง
   - ทำกุญแจโหวตหาย: ถ้าบัญชี operator ล็อกควอนตัมไว้ ผู้ควบคุมลงทะเบียนกุญแจใหม่ได้เมื่อ validator ถูก jail
     (บัญชี operator ที่ยังเป็น ECDSA ล้างกุญแจไม่ได้ เพราะลายเซ็น ECDSA อาจถูกปลอม)
8. **เลขสุ่มบนเชน (`block.prevrandao`, `evmd/zetaphy_random.go`):** เดิม `PREVRANDAO` เป็นค่าคงที่ (0xff…ff) และ `BLOCKHASH` ได้ 0 สัญญาที่ใช้เป็นเมล็ดสุ่ม (เช่นลอตเตอรีของ NeuroJobs) จึงเดาได้ล่วงหน้า
   - ค่าของบล็อก N = `sha256("zetaphy.prevrandao.v1" ‖ 0 ‖ chain-id ‖ 0 ‖ N (8 ไบต์) ‖ 0x01 ‖ ความสูงที่รับรอง N-1 (8 ไบต์) ‖ attestations)` โดย attestations คือเนื้อในใบรับรอง ML-DSA ของบล็อก N-1 (ข้อ 6, ธุรกรรมแรกของบล็อก N) ที่ตรวจผ่านแล้ว เรียงตามที่อยู่ validator
   - ลายเซ็นเหล่านี้ต้องใช้กุญแจลับของ validator และเกิดหลังโหวตบล็อก N-1 เท่านั้น ผู้ส่งธุรกรรมจึงเดาค่าไม่ได้ตอนส่ง
   - ถ้ายังไม่มีใบรับรอง (ยังไม่เปิด vote extension, ยังไม่มีใครลงทะเบียนกุญแจ, บล็อกแรก) ใช้ค่าสำรอง `sha256(... ‖ 0x00 ‖ hash ของบล็อก N-1)` ซึ่งเปลี่ยนทุกบล็อกแต่ใครก็คำนวณได้ทันทีที่บล็อก N-1 จบ
   - ค่าเก็บในสโตร์ตอน PreBlocker ทุกโหนดได้ค่าเดียวกัน; `eth_call` / `eth_estimateGas` / CheckTx เห็นค่าของบล็อกล่าสุดที่ commit แล้ว ส่วนธุรกรรมจริงเห็นค่าของบล็อกที่มันอยู่
   - **ข้อจำกัด: "ผู้ใช้เดาไม่ได้ แต่ผู้เสนอบล็อกเอนค่าได้"** ML-DSA เซ็นข้อความเดิมได้หลายลายเซ็นที่ถูกต้อง ผู้เสนอบล็อก N จึงเซ็นส่วนของตัวเองใหม่หลายครั้งและเลือกว่าจะใส่ลายเซ็นของใครบ้าง (เกิน 2/3) เพื่อเลือกค่าที่ชอบภายในเวลาหนึ่งบล็อก และ validator อื่นก็เลือกลายเซ็นของตัวเองได้ก่อนโหวต กติกาข้อ 6 (ผู้เสนอต้องใส่ลายเซ็นตัวเอง) ตัดได้แค่ทางเลือก "ไม่ส่งใบรับรอง" ไม่ได้ตัดการเซ็นใหม่หลายครั้ง
   - **ห้ามใช้ `PREVRANDAO` เป็นแหล่งสุ่มเดียวของลอตเตอรีหรือรางวัลมูลค่าสูง** ผู้เสนอบล็อกที่ได้ประโยชน์จากผลสามารถเลือกผลได้ ลอตเตอรีของ NeuroJobs จึงเปลี่ยนไปใช้ `blockhash(startBlock+1)`
   - โหนดที่ดูโหวตอยู่มักคำนวณค่าของบล็อก N ได้ในช่วง timeout_commit (~1 วินาที) ก่อนบล็อก N ถูกเสนอ สัญญาจึงต้องใช้ค่าของบล็อก**หลัง**บล็อกที่ล็อกเดิมพัน (commit ก่อน แล้วสุ่มในบล็อกถัดไป) ไม่ใช่ค่าในธุรกรรมเดียวกับที่ผู้ใช้ส่งคำขอ
   - เงินรางวัลสูงยังควรใช้ commit-reveal ร่วมด้วย เพราะนี่คือ "ผู้ใช้เดาไม่ได้" ไม่ใช่ "validator คุมไม่ได้"
   - `BLOCKHASH(n)` ของ 256 บล็อกล่าสุดได้ hash จริงแล้ว: cosmos/evm เก็บ hash ไว้ในสัญญา EIP-2935 (`0x0000F90827F1C53a10cb7A02335B175320002935`) แต่ genesis จาก `zetaphyd init` ไม่มีสัญญานี้ เชนจึงติดตั้งให้เองตอนต้นบล็อกแรกที่ไม่มี (ตั้งแต่ความสูงเปิดใช้ v2)
   - เรียกสัญญา EIP-2935 ตรง ๆ (`get(n)`) ก็ได้ hash ที่ถูกต้องย้อนหลัง 8191 บล็อก: สัญญาอ่านช่อง `n % 8191` เชนจึงเขียน hash ของบล็อก n ลงช่อง `n % 8191` (พารามิเตอร์ `history_serve_window` = 8191 เดิม upstream ใช้ 8192 ซึ่งให้ hash ผิดหลังบล็อก 8191) และเขียนตอน**ท้าย**บล็อกแบบ EIP-2935 (ระหว่างบล็อก N ช่องนั้นยังเป็นของบล็อก N-8191) ห้ามโหวตเปลี่ยน `history_serve_window` จาก 8191
9. **เผาเหรียญที่ส่งไป `0x000000000000000000000000000000000000dEaD` จริง (`evmd/zetaphy_feeburn.go`):** Neuro ส่ง 5% ของค่าธรรมเนียมไปที่อยู่นี้ เดิมเหรียญแค่ค้างอยู่และยังนับใน total supply
   - ทุกต้นบล็อก (ที่เดียวกับการเผาค่าธรรมเนียม 50%) ยอด azetaphy ทั้งหมดของ dEaD ย้ายไปบัญชีโมดูล EVM (มีสิทธิ์ Burner) แล้วเผา total supply ลดลงจริง และมี event `zetaphy_dead_burn`
   - เผาเฉพาะเหรียญหลัก (azetaphy) เหรียญอื่นที่ dEaD ถืออยู่ไม่ถูกแตะ
   - ไม่มีบัญชีหรือยอดเป็น 0 ก็ข้ามไป ถ้าเผาไม่สำเร็จจะ log แล้วข้าม (ทำใน cache ทั้งก้อน) ไม่ทำให้เชนหยุด
   - เผาเฉพาะยอดที่ใช้ได้ (spendable): ถ้ามีคนทำให้ dEaD เป็นบัญชี vesting หรือบัญชีล็อกถาวรก่อน ส่วนที่ล็อกจะค้างอยู่ (เป็นเงินของคนสร้างเองและใช้ไม่ได้ตลอดไป) แต่เหรียญที่ส่งมาทีหลังยังถูกเผาทุกบล็อก การเผาไม่ติดค้างถาวร
10. **ความสูงเปิดใช้ v2 (`evmd/zetaphy_upgrade.go`):** ข้อ 8, 9 และกติกาผู้เสนอในข้อ 6 ทำงานตั้งแต่ความสูงที่เก็บในคีย์ `08` ของ `app_state.zetaphypq` เท่านั้น ต่ำกว่านั้น (หรือไม่มีคีย์) บล็อกรันแบบเดิมทุกอย่าง: ไม่เผาที่ dEaD ไม่ติดตั้งสัญญา EIP-2935 และ `PREVRANDAO` = 0xff…ff การรันเชนเดิมซ้ำด้วยโปรแกรมใหม่จึงได้ state เดิม
   - เชนใหม่: `zetaphyd init` ใส่ความสูง 1 ให้ และ `setup-node.sh` ตั้งซ้ำ (`{"key":"08","value":"0000000000000001"}`) พร้อม `history_serve_window` = 8191
   - เชนที่รันอยู่แล้ว: `gov.sh propose-upgrade zetaphy-v2 <ความสูง H> "<สรุป>"` แล้วโหวตให้ผ่าน ทุก validator เปลี่ยนเป็นโปรแกรมนี้เมื่อเชนหยุดที่ H handler `zetaphy-v2` ตั้งความสูงเปิดใช้เป็น H+1 และ `history_serve_window` เป็น 8191 (ถ้าโปรแกรมที่รันอยู่ยังไม่มีสโตร์ `zetaphypq` หรือ `ratelimit` ต้องเพิ่มชื่อสโตร์ใน `StoreUpgrades` ของ handler ก่อน)
   - genesis export เก็บค่านี้ไว้ (เป็น 1 ถ้าเปิดแล้ว)
- **MetaMask:** ตัว MetaMask เซ็นได้แค่ ECDSA แต่ `zetaphy-snap/` (MetaMask Snap) ให้ MetaMask ถือกุญแจ ML-DSA ได้ กุญแจกู้คืนได้จาก seed phrase ของ MetaMask
  ก่อนเผยแพร่ใน MetaMask ปกติต้องผ่านการรีวิวและ audit ของ MetaMask (ดู README ของ snap)
- **สิ่งที่ยังไม่ต้านควอนตัม:**
  - เชนอื่นที่เชื่อม IBC กับเราใช้ light client ของเขาเอง ซึ่งตรวจแค่ ed25519 จนกว่าเขาจะใช้ตัวตรวจที่อ่านใบรับรองของเรา
    ระหว่างนี้เพดาน IBC (rate limit) จำกัดความเสียหาย
  - ถ้าเปิดสวิตช์ข้อ 7 แล้ว validator ที่มีกุญแจ ML-DSA จะไม่ถูกลงโทษจากการเซ็นซ้ำ เพราะ CometBFT ไม่ส่งเลขรอบให้เซ็น ML-DSA จึงพิสูจน์การเซ็นซ้ำด้วย ML-DSA ไม่ได้
- ลายเซ็น ML-DSA-44 ใหญ่ (~2.4 KB) ธุรกรรมโอนเงินจึงใช้แก๊สราว 250,000 (ค่าธรรมเนียมราว 0.00005 ZETAPHY) ซึ่งยังถูกมาก
  ML-DSA-44 เป็นขนาดเล็กที่สุดของมาตรฐาน NIST ที่ใช้ได้จริงตอนนี้

ชุดทดสอบของ patch อยู่ที่ `fork-tests/` และ `test-vote-keys.sh` CI รันทุกครั้งที่แก้ `zetaphy-chain/`:
ทดสอบ ML-DSA, การโอน IBC และเพดาน, build `zetaphyd` แล้วรันเชนทดลองทดสอบกระเป๋า PQ ล็อกควอนตัม และเชน 2 validator ทดสอบลายเซ็นโหวต ใบรับรองบล็อก และโหนดใหม่ที่ sync ย้อนหลัง
เลขสุ่ม `PREVRANDAO`, `BLOCKHASH` และการเผาที่ dEaD ทดสอบด้วย `fork-tests/evmd/zetaphy_chainrand_test.go` และบนเชนจริงด้วย `npm run test:devnet:chainrand` ใน `zetaphy-network`
ความสูงเปิดใช้ (ทั้งสองฝั่ง) handler `zetaphy-v2` สัญญา EIP-2935 ข้ามจุดวนรอบ 8191 การเผาบัญชี vesting ที่ dEaD และกติกาผู้เสนอ ทดสอบด้วย `fork-tests/evmd/zetaphy_v2_test.go`

**ข้อ 8–10 เปลี่ยนผลการรันบล็อก (state):** บนเชนที่รันอยู่แล้วจะเปิดใช้ผ่านการอัปเกรด `zetaphy-v2` เท่านั้น (ข้อ 10) ทุก validator ต้องเปลี่ยนเป็นโปรแกรมใหม่ที่บล็อกอัปเกรดเดียวกัน ถ้ารันโปรแกรมเก่ากับใหม่ปนกันหลังความสูงเปิดใช้ app hash จะไม่ตรงกันและเชนหยุด

เครื่องที่ติดตั้งก่อนหน้านี้ต้อง build ใหม่: `FORCE_BUILD=1 bash setup-node.sh`
- ถ้าเชนรันอยู่แล้ว การเปิด precompile ใหม่ต้องผ่านการโหวตอัปเกรดด้วย `gov.sh`

## ขั้น 6: ความปลอดภัยในแกนกลางของเชน (Q-day, threat gate, IBC hold)

คู่มือผู้ใช้: [`docs/SECURITY-CORE.md`](../docs/SECURITY-CORE.th.md) — patch ส่วนนี้อยู่ใน `setup-node.sh` เดียวกัน
(`evmd/zetaphy_security.go`, `zetaphy_qday.go`, `zetaphy_threatgate.go`, `zetaphy_secprecompile.go`, `zetaphy_ibchold.go`)
ทั้งสามกติกา **ปิดอยู่จนกว่าจะโหวต** ด้วย `gov.sh` แล้วดูค่าที่ใช้อยู่ด้วย `gov.sh security`
1. **Q-day** (`gov.sh qday <ความสูง> [reveal_delay]`): ตั้งแต่ความสูงนั้น เชนไม่รับธุรกรรมที่เซ็นด้วย ECDSA
   (ทั้ง EVM และ Cosmos) และ `ecrecover` ไม่คืนที่อยู่อีก บัญชีที่ล็อกควอนตัมแล้วใช้ต่อผ่านผู้ควบคุม ML-DSA-44
   บัญชีที่ยังไม่ย้ายถูกแช่แข็ง (เงินอยู่ที่เดิม) ยกเว้นกุญแจที่ไม่เคยใช้บนเชน ซึ่งย้ายได้ด้วย commit–reveal
   (`MsgQDayCommit` แล้ว `MsgQDayReveal` ห่างกันอย่างน้อย reveal_delay บล็อก แล้วรออีกเท่ากันจึงเป็นล็อกควอนตัม)
   - **validator:** ล็อกควอนตัมบัญชี operator ก่อน Q-day (`gov.sh quantum-lock`) เพราะหลัง Q-day บัญชี ECDSA
     ส่งธุรกรรม (รวมการโหวต) ไม่ได้ จัดการ validator ผ่าน `MsgEVMCall as_owner` ไปที่ precompile staking /
     distribution / slashing / gov
   - `gov.sh qday` ไม่ยอมตั้งความสูงที่ใกล้เกินไป (ค่าเริ่ม: ต้องห่างอย่างน้อย 100 บล็อก, `QDAY_MIN_NOTICE`)
     mainnet ควรประกาศล่วงหน้าเป็นเดือน
2. **Threat gate** (`gov.sh threat-gate <ThreatRegistry 0x…> on|off`): ธุรกรรมที่ปลายทางมีธงบังคับใช้ใน ThreatRegistry
   ถูกปฏิเสธ เว้นแต่ผู้ส่งยินยอมก่อน (`consent(ปลายทาง, วินาที)` ที่ precompile `0x…0901` นานสุด 1 วัน)
   ธงเตือน/ธงพัก key ที่ป้องกัน และธงที่ถูกล้าง ไม่ทำให้ถูกปฏิเสธ registry ที่ใช้งานไม่ได้ = ด่านปิด (เชนไม่ค้าง)
3. **IBC hold** (`gov.sh ibc-hold <วินาที> [guardian]`, `gov.sh ibc-hold-rule <denom|*> <ขั้นต่ำ> <bps>`):
   การโอนเข้าที่ถึงเกณฑ์ถูกพัก (acknowledgement แบบ async) ครบเวลาเชนส่งต่อเอง ระหว่างนั้น guardian
   (`gov.sh ibc-hold-cancel <id>`) หรือ governance คืนเงินให้ผู้ส่งได้ ดูรายการด้วย `gov.sh ibc-holds`
   ทำงานอยู่บนสุดของ IBC stack เหนือ x/ratelimit (ซึ่งยังทำงานเหมือนเดิม)

**อัปเกรด:** เชนใหม่เปิดใช้ตั้งแต่บล็อก 1 (`{"key":"0f","value":"0000000000000001"}` ใน `app_state.zetaphypq`,
`setup-node.sh` ใส่ให้) เชนที่รันอยู่: `gov.sh propose-upgrade zetaphy-v3 <ความสูง H> "<สรุป>"` แล้วโหวต
ทุก validator เปลี่ยน binary ที่ H; ตั้งแต่ H+1 precompile `0x…0901` และกติกาใหม่จึงมีผล (ใช้ binary เดิมรันบล็อกก่อน H)

ทดสอบ: `fork-tests/evmd/zetaphy_security_test.go` (Q-day, การแซงหน้า commit–reveal, กุญแจที่เคยใช้ vs ไม่เคยใช้,
บัญชี MetaMask ที่ล็อกแล้วยังใช้ได้ผ่านผู้ควบคุม, threat gate: ไม่ยินยอม/ยินยอม/หมดอายุ/ล้างธง/ปิด/registry เสีย/
ค่าใช้จ่าย, precompile, genesis, handler `zetaphy-v3`), `fork-tests/evmd/tests/ibc/zetaphy_ibchold_test.go`
(พัก ปล่อย คืนเงิน เกณฑ์ supply) และบนเชนจริง `npm run test:devnet:security` กับ `ibc/test-ibc.sh` (ข้อ 4)
รายละเอียดด้านความปลอดภัยเก็บแยกไว้สำหรับทีม

## ขั้น 7: สัญญาอัจฉริยะภาษา Rust (CosmWasm) คู่กับ EVM

เชนเดียวกัน บัญชีเดียวกัน เหรียญเดียวกัน: นอกจากสัญญา Solidity (EVM) แล้ว ZETAPHY รันสัญญา CosmWasm
(เขียนด้วย Rust, compile เป็น WASM) ได้ด้วย ผ่านโมดูล `x/wasm` ของ wasmd (patch อยู่ใน `setup-node.sh` เดียวกัน:
`evmd/zetaphy_cosmwasm.go`)

**รุ่นที่ใช้ (pin ไว้พร้อม hash):** wasmd `v0.70.5` (รุ่นสำหรับ Cosmos SDK v0.54) + wasmvm `v3.0.9`
(CosmWasm VM 3.0.11) ทั้งคู่ถูกตรวจ hash ผ่าน `evmd/go.sum` (Go checksum database)
ส่วน ibc-go คงไว้ที่ `v11.0.0` ตัวเดิม (wasmd v0.70.5 ขอ v11.2.0 แต่รุ่นนั้นพ่วงโมดูล rate-limiting ของ ibc-go
ที่ชนกับ x/ratelimit ของเรา; wasmd v0.70.0–v0.70.2 ก็ build บน v11.0.0)

**ไลบรารี VM (libwasmvm):** เป็นไลบรารี Rust ที่ binary ลิงก์แบบ shared (`libwasmvm.x86_64.so` / `libwasmvm.aarch64.so`)
`setup-node.sh` ติดตั้งไว้ที่ `/usr/local/lib` หลังตรวจ SHA-256 กับค่าที่ pin ไว้ (`WASMVM_SO_SHA256_*`, ตรงกับ
`checksums.txt` ของ wasmvm) ใช้ได้ทั้ง x86_64 และ ARM (Oracle ARM) บน Ubuntu 24.04
(ต้องการ glibc ≥ 2.30) ถ้าใช้ไฟล์เชนสำเร็จรูป (`ZETAPHYD_BIN=`) สคริปต์ดาวน์โหลด libwasmvm จาก release ของ
CosmWasm แล้วตรวจ hash เดียวกัน
- ทำไมไม่ลิงก์แบบ static (musl): ชุดเครื่องมือ musl บน Ubuntu 24.04 ลิงก์ libwasmvm แบบ static ไม่ผ่าน
  (`libgcc_eh` ของ Ubuntu ต้องการ `_dl_find_object` ของ glibc) ทางเลี่ยงที่มีทำให้ Rust panic กลายเป็นโปรแกรมล้ม
  จึงใช้ไฟล์ .so ที่ตรวจ hash แทน
- เวลา build และขนาด: เวลา compile แทบไม่เปลี่ยน (~4 นาทีบนเครื่อง 4 core ทั้งก่อนและหลัง), `zetaphyd` ใหญ่ขึ้น
  ~3 MB (152 → 156 MB หลัง strip) บวกไฟล์ libwasmvm 19.5 MB (x86_64) / 17.5 MB (ARM) ดิสก์ของเชนมีโฟลเดอร์
  `wasm/` เพิ่ม (โค้ดสัญญาที่ compile แล้ว)

**ค่าความปลอดภัยเริ่มต้น**
- **อัปโหลดโค้ดสัญญา: governance เท่านั้น** (`code_upload_access = Nobody`) ส่งโค้ดเป็น proposal แล้วโหวต:
  ```bash
  bash gov.sh wasm-store cw20_base.wasm "cw20-base v2.0.0"      # พิมพ์ sha256 ของโค้ดให้เทียบกับ build ที่เผยแพร่
  bash gov.sh vote <id> yes
  bash gov.sh wasm-codes                                         # โค้ดที่เก็บแล้ว + กติกาอัปโหลดตอนนี้
  bash gov.sh wasm-upload-access zetaphy1…,zetaphy1…             # (ถ้าต้องการ) ให้บางที่อยู่อัปโหลดได้โดยไม่ต้องโหวต
  ```
  สัญญาขนาด ~380 KB (gzip ~150 KB) ใช้ gas ราว 25 ล้านตอนยื่น proposal เพดานบล็อกคือ 30 ล้าน
  สัญญาใหญ่กว่านั้นต้องให้ governance เปิดสิทธิ์อัปโหลดให้ที่อยู่หนึ่ง (`wasm-upload-access`) แทน
- **สร้าง (instantiate) และเรียกใช้: ทุกคน** (`zetaphyd tx wasm instantiate / execute`)
- ขนาดโค้ดสูงสุด 800 KiB (หลังแตก gzip) ทั้งแบบอัปโหลดตรงและผ่าน proposal; query สัญญาใช้ gas ได้ไม่เกิน 3 ล้าน
  (`[wasm]` ใน app.toml; cache ของ VM 100 MiB หรือ 32 MiB บนเครื่อง RAM < 3 GB)
- **ธุรกรรม wasm คือธุรกรรม Cosmos ธรรมดา** จึงอยู่ใต้กติกาเดิมทั้งหมด: ค่าธรรมเนียมเป็น azetaphy และเผาครึ่งหนึ่ง,
  Q-day (หลัง Q-day ต้องเซ็นด้วย ML-DSA-44), บัญชีที่ล็อกควอนตัมใช้กุญแจเดิมส่งไม่ได้
- **สิ่งที่สัญญาส่งต่อก็ถูกตรวจ:** สัญญาใช้สิทธิ์ authz ของบัญชีที่ล็อกควอนตัมไม่ได้, ส่งธุรกรรม EVM หรือข้อความ
  `zetaphy.pq.*` ไม่ได้, เปิดช่อง IBC/ส่ง packet IBC เองไม่ได้ (โอนเหรียญแบบ ICS-20 ได้ และผ่านเพดาน IBC ตามปกติ)
- **IBC สำหรับสัญญา: ปิด** (ไม่มี route ให้พอร์ต `wasm.*` / `wasm2*`) การเปิดภายหลังต้องเป็นการอัปเกรดที่ตรวจแยก
- **Threat gate ยังใช้กับ EVM เท่านั้น:** ThreatRegistry เก็บธงของสัญญา EVM (ที่อยู่ 20 ไบต์) ส่วนที่อยู่สัญญา
  CosmWasm ยาว 32 ไบต์ และสัญญา CosmWasm เรียกสัญญา EVM ในนามตัวเองไม่ได้ จึงไม่มีทางอ้อมด่าน
  (Neuro อ่านสัญญา CosmWasm ของ ZETAPHY ได้: `node cli.js zetaphy-wasm <zetaphy1…> --rest https://<โหนด>/rest`)

**ข้อควรรู้ก่อนล็อกควอนตัม:** ผู้ควบคุม ML-DSA-44 ใช้งานแทนบัญชีที่ล็อกได้เฉพาะฝั่ง EVM (`MsgEVMCall as_owner`)
ยังสั่งสัญญา CosmWasm แทนไม่ได้ ถ้ามีโทเคน cw20 หรือเป็น admin ของสัญญา CosmWasm ให้ย้ายไปบัญชี ML-DSA-44
ก่อนล็อก

**อัปเกรด:** เชนใหม่มี CosmWasm ตั้งแต่ genesis (`zetaphyd init` และ `setup-node.sh` ตั้งค่าข้างบนให้)
เชนที่รันอยู่: `gov.sh propose-upgrade zetaphy-v4 <ความสูง H> "<สรุป>"` แล้วโหวต ทุก validator เปลี่ยน binary ที่ H
(handler เพิ่ม store ของ wasm, ตั้งค่า "อัปโหลดโดย governance เท่านั้น" และเปิด v2/v3 ให้ด้วยถ้ายังไม่เปิด)

ทดสอบ: `fork-tests/evmd/zetaphy_cosmwasm_test.go` (สัญญาอ้างอิง hackatom/reflect จาก wasmd testdata ตรวจ sha256,
อัปโหลดเฉพาะ governance, instantiate/execute, Q-day และล็อกควอนตัมกับธุรกรรม wasm, สิ่งที่สัญญาส่งต่อ, พอร์ต IBC ปิด,
handler `zetaphy-v4`) และบนเชนจริง `npm run test:devnet:wasm` (zetaphy-network: โหวตเก็บ cw20-base v2.0.0
ที่ตรวจ sha256 แล้ว instantiate โอน และดูการเผาค่าธรรมเนียม) CI รันทั้งบน x86_64 และ ARM64
