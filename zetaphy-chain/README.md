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
   - เปิดไฟล์ [`cloud-init.sh`](./cloud-init.sh) บน GitHub → กด **Raw** → เลือกทั้งหมดแล้วคัดลอก → วางในช่องนี้
     - ไฟล์นี้คือ [`setup-node.sh`](./setup-node.sh) ที่บีบอัดไว้ เพราะ Oracle รับข้อมูลได้ไม่เกิน 32,000 ไบต์
     - อ่านว่าสคริปต์ทำอะไรได้ใน `setup-node.sh` ส่วน CI จะตรวจทุกครั้งว่าสองไฟล์ตรงกัน และเครื่องจะตรวจ SHA-256 ก่อนรัน
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
  - Currency symbol: `ZETAPHY`
  ถ้าเพิ่มได้และเห็นยอด 1,000,000 ZETAPHY (กรณีใส่ OWNER_EVM_ADDRESS) แปลว่าเชนทำงานแล้ว
- **หรือใช้ Cloud Shell ของ Oracle** (ไอคอน `>_` มุมขวาบนของหน้าเว็บ Oracle) แล้ววาง:
  ```bash
  curl -s -X POST http://<Public IP>:8545 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  ```
  ตัวเลข `result` ควรเพิ่มขึ้นทุก ~5 วินาที
- กระเป๋าบนเว็บ (`zetaphy-wallet`) ใส่ RPC เป็น `https://<IP ที่เปลี่ยนจุดเป็นขีด>.sslip.io`

ถ้าผ่านไปนานแล้วยังไม่ทำงาน: หน้าเครื่อง → **Resources → Console connection**
แล้วดู log ที่ `/var/log/zetaphy-setup.log`

### แผนสำรอง: Google Cloud (ถ้าสมัคร Oracle ไม่ผ่าน)

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
   TCP `8545,26656`
4. ตรวจแบบเดียวกับข้อ 4 ข้างบน (ใช้ External IP ของเครื่อง) ดู log ได้ที่ปุ่ม **SSH** ในหน้าเครื่อง: `sudo tail -f /var/log/zetaphy-setup.log`

---

## เข้าร่วมเชน: เป็น node หรือ validator (ให้เชนไม่อยู่ที่เครื่องเดียว)

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

## ขั้น 5: ลายเซ็นต้านควอนตัม (ML-DSA)

`setup-node.sh` ใส่ patch ไว้ท้ายไฟล์ ตอน build จะเพิ่ม 2 อย่าง:
1. precompile ตรวจลายเซ็น ML-DSA (FIPS 204) ที่ `0x0000000000000000000000000000000000000900` (Cloudflare CIRCL v1.6.3) เปิดใช้ใน genesis
   - กระเป๋าที่ใช้คือ `QuantumWallet` ใน `zetaphy-network` (คำสั่ง `zetaphy pq`) ซึ่งยังต้องมีบัญชี ECDSA จ่ายค่าแก๊ส
2. **บัญชี PQ แท้:** บัญชีที่มีแค่กุญแจ ML-DSA-44 (`crypto/mldsa44`) ใช้ส่งธุรกรรม Cosmos ธรรมดาได้เลย ไม่มีกุญแจ ECDSA และไม่ต้องมีคนจ่ายค่าแก๊สแทน
   - ที่อยู่ = `sha256(public key)[0:20]` เห็นได้ทั้งแบบ `zetaphy1…` และ `0x…`
   - ส่งผ่านพอร์ต 8545 เดิมด้วย JSON-RPC `zetaphy_pqAccount` และ `zetaphy_sendCosmosTx` (ไม่ต้องเปิดพอร์ตใหม่)
   - ใช้ได้จาก `zetaphy pq native` และกระเป๋าบนเว็บ `zetaphy-wallet/`
   - ทดสอบบนเชนจริงแล้ว: ส่งได้ และเชนปฏิเสธธุรกรรมที่ใช้กุญแจอื่นสวมบัญชี ลายเซ็นที่ถูกแก้ และธุรกรรมเก่าที่ส่งซ้ำ
   - **ส่วนที่ยังไม่ต้านควอนตัม และเหตุผล:**
     - กุญแจเซ็นบล็อกของ validator (ed25519): CometBFT รองรับแค่ ed25519 / secp256k1 / BLS
       การเปลี่ยนต้องแก้กลไกฉันทามติทั้งชุด เสี่ยงทำเชนล่ม จึงรอให้ CometBFT รองรับ ML-DSA เอง
       ระหว่างนี้: ถ้ากุญแจนี้ถูกเจาะ ผู้โจมตีเซ็นบล็อกแทนได้และอาจทำให้ validator ถูกปรับ (slash) แต่ถอนหรือโอนเงินที่ stake ไม่ได้ (เงินคุมด้วยกุญแจบัญชี ซึ่งเป็น ML-DSA ได้)
     - ธุรกรรมแบบ EVM (MetaMask) ใช้ ECDSA ตามมาตรฐาน Ethereum เปลี่ยนไม่ได้โดยไม่ทิ้ง MetaMask
       เงินที่อยากให้ปลอดภัยจากควอนตัมให้ย้ายไปบัญชี PQ แท้ (ข้อ 2) หรือ `QuantumWallet`
   - ลายเซ็น ML-DSA-44 ใหญ่ (~2.4 KB) ธุรกรรมโอนเงินจึงใช้แก๊สราว 250,000 (ค่าธรรมเนียมราว 0.00005 ZETAPHY) ซึ่งยังถูกมาก
     ML-DSA-44 เป็นขนาดเล็กที่สุดของมาตรฐาน NIST ที่ใช้ได้จริงตอนนี้

ชุดทดสอบของ patch อยู่ที่ `fork-tests/` (แยกจากสคริปต์เพื่อให้ขนาดพอดีกับ Oracle) CI รันทุกครั้งที่แก้ `zetaphy-chain/`:
ทดสอบ ML-DSA, การโอน IBC และเพดาน, build `zetaphyd` แล้วรันเชนทดลองทดสอบกระเป๋า PQ ทั้งสองแบบ

เครื่องที่ติดตั้งก่อนหน้านี้ต้อง build ใหม่: `FORCE_BUILD=1 bash setup-node.sh`
- ถ้าเชนรันอยู่แล้ว การเปิด precompile ใหม่ต้องผ่านการโหวตอัปเกรดด้วย `gov.sh`
