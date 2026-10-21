# USDC จริงจาก Noble เข้าเชน ZETAPHY ผ่าน IBC (testnet ก่อน)

**Noble** เป็นเชน Cosmos ที่ Circle ออก USDC เองโดยตรง (native USDC ไม่ใช่เหรียญห่อของสะพาน)
เราต่อ ZETAPHY กับ Noble ด้วย **IBC**: ทั้งสองเชนตรวจกันเองด้วย light client
มี **relayer** (โปรแกรม Hermes) คอยส่งข้อความระหว่างสองเชน relayer รันบนเครื่อง Oracle เครื่องเดียวกับโหนด

```
Noble (uusdc) ──IBC transfer/channel──▶ ZETAPHY: เหรียญ ibc/<hash>
                                          └─ ERC-20 ที่ 0x… (MetaMask เห็นเป็น USDC)
                                          └─ เพดาน x/ratelimit (เช่น 1% ต่อ 24 ชม.)
```

- ฟรี: Hermes เป็นโปรแกรมเปิด, ค่าแก๊สบน Noble testnet จ่ายด้วย USDC จาก faucet, ZETAPHY testnet ไม่มีมูลค่า
- **ไม่มีอะไรรันบนคอมพิวเตอร์ของคุณ**: ทุกขั้นทำในเบราว์เซอร์ (Oracle Cloud Shell, หน้า faucet, MetaMask)
- **ไม่มีความลับให้คุณถือ**: กุญแจของ relayer สร้างบนเครื่องโหนดและไม่ถูกพิมพ์ออกมา คุณเห็นแค่ที่อยู่ (สาธารณะ) เพื่อเติมค่าแก๊ส
- **testnet ก่อน** mainnet ทำได้หลังผ่านเงื่อนไข audit เท่านั้น (หัวข้อ "ทางไป mainnet")

ไฟล์ในโฟลเดอร์นี้:

| ไฟล์ | ทำอะไร |
|---|---|
| `setup-relayer.sh` | ติดตั้ง Hermes (ตรึงเวอร์ชันและ SHA-256), ผู้ใช้ `relayer`, กุญแจ, config, เปิดช่อง, service |
| `test-ibc.sh` | พิสูจน์ทั้งระบบบนเชนทดลอง 2 เชน (ไม่ต้องใช้ Noble จริง) |
| `../gov.sh` | คำสั่ง `ibc-usdc-*`: ชื่อเหรียญ, ERC-20, เพดาน (ผ่านโหวต) |

---

## ค่าของ Noble testnet ที่ใช้ (และแหล่งที่มา)

| ค่า | ใช้ | แหล่ง / สถานะ |
|---|---|---|
| Chain ID | `grand-1` | ✅ `noble-assets/noble` ไฟล์ `upgrade/constants.go` (`TestnetChainID = "grand-1"`) และ cosmos/chain-registry `testnets/nobletestnet/chain.json` |
| RPC | `https://noble-testnet-rpc.polkachu.com:443` (สำรอง `https://rpc.testnet.noble.strange.love:443`) | chain-registry (commit `05d3261`, 20 ต.ค. 2026) ⚠️ TODO: ยังไม่ได้ลองต่อจริง (เครื่องที่ทดสอบออกเน็ตไป Noble ไม่ได้) |
| Websocket | `wss://noble-testnet-rpc.polkachu.com/websocket` | สร้างจาก RPC ⚠️ TODO: ถ้าต่อไม่ได้ใช้ `NOBLE_EVENTS=pull` |
| gRPC | `http://noble-testnet-grpc.polkachu.com:21590` | chain-registry ระบุ `noble-testnet-grpc.polkachu.com:21590` ⚠️ TODO: ไม่ได้ระบุว่าเป็น TLS หรือไม่ ใช้แบบไม่เข้ารหัส (`http://`) ไว้ก่อน ถ้า `status` แจ้ง error ให้ลอง `https://` |
| เหรียญ USDC | `uusdc` (6 ตำแหน่ง: 1 USDC = 1,000,000 uusdc) | ✅ chain-registry `testnets/nobletestnet/assetlist.json` |
| ค่าแก๊สบน Noble | จ่ายเป็น `uusdc` ตั้งไว้ `0.1` uusdc/แก๊ส | chain-registry testnet: low 0.01 / average 0.025 / high 0.03 (fixed min 0); mainnet: 0.1 เราใช้ 0.1 เพราะผ่านทั้งสองแบบ (แพงกว่านิดหน่อย) ⚠️ TODO: ยืนยันค่าขั้นต่ำปัจจุบันจากโหนดจริง |
| ที่อยู่ | ขึ้นต้น `noble1…`, coin type 118, กุญแจ secp256k1 | ✅ chain-registry |
| Unbonding | 21 วัน → ตั้ง `trusting_period = 14days` | ✅ chain-registry (`lock_duration 1814400s`) |
| Faucet | **faucet.circle.com** → เลือก **Noble Testnet** → ได้ USDC ทดลอง | ⚠️ TODO: มาจากผลค้นหาเว็บ (หน้า Circle ระบุว่า Public Faucet รองรับ Noble Testnet) เปิดหน้าเว็บโดยตรงจากเครื่องทดสอบไม่ได้ chain-registry ไม่มีรายการ faucet ของ Noble testnet จำนวนต่อครั้ง/ความถี่ให้ดูบนหน้า faucet |
| Explorer | `https://mintscan.io/noble-testnet`, `https://explore.strange.love/grand-1` | chain-registry |

ค่าฝั่ง ZETAPHY ตรงกับ `setup-node.sh`: `zetaphy_77390-1`, RPC `127.0.0.1:26657`, gRPC `127.0.0.1:9090` (ในเครื่องเท่านั้น), ค่าแก๊ส 2 gwei (`2000000000azetaphy`), กุญแจ `eth_secp256k1`

ทุกค่าเปลี่ยนได้ด้วยตัวแปร เช่น `sudo NOBLE_RPC=https://… NOBLE_GRPC=http://… bash setup-relayer.sh config` สคริปต์จำค่าไว้ใน `/home/relayer/.hermes/settings.env` รอบต่อไปไม่ต้องพิมพ์ซ้ำ

---

## ขั้นตอน (ทำในเบราว์เซอร์ทั้งหมด)

ก่อนเริ่ม: เชน ZETAPHY ทำงานแล้ว (`docs/LAUNCH.md` ข้อ 1–2) และมี MetaMask ที่ต่อ ZETAPHY testnet

### 1. เข้าเครื่องโหนด
หน้า Oracle → ไอคอน **Cloud Shell** `>_` มุมขวาบน → ⚙ → **Upload** ไฟล์ private key ที่เก็บไว้ตอนสร้างเครื่อง แล้ว:
```bash
chmod 600 ssh-key-*.key && ssh -i ssh-key-*.key ubuntu@<Public IP>
```

### 2. เอาสคริปต์ขึ้นเครื่อง
บน GitHub เปิด `zetaphy-chain/ibc/setup-relayer.sh` → **Raw** → คัดลอกทั้งหมด แล้วในหน้าต่างเครื่อง:
```bash
cat > setup-relayer.sh      # วาง แล้วกด Ctrl-D
```
(ถ้า repo เป็นสาธารณะ ใช้ `curl -fsSLO https://raw.githubusercontent.com/<เจ้าของ>/swd-amm/main/zetaphy-chain/ibc/setup-relayer.sh` แทนได้)
ทำแบบเดียวกันกับ `zetaphy-chain/gov.sh` ถ้ายังไม่มีบนเครื่อง (`sudo install -m 755 gov.sh /usr/local/bin/gov.sh`)

### 3. ติดตั้ง relayer
```bash
sudo bash setup-relayer.sh
```
- ดาวน์โหลด Hermes v1.13.3 จาก GitHub ตรวจ SHA-256 ที่ตรึงไว้ (x86_64 และ aarch64 สำหรับ Ampere) ไม่ตรง = ไม่ติดตั้ง
- สร้างผู้ใช้ `relayer` (ไม่มีรหัสผ่าน ไม่มีสิทธิ์ sudo) และ config ที่ `/home/relayer/.hermes/config.toml`
- สร้างกุญแจ 2 ดอก: ZETAPHY (`eth_secp256k1`, path `m/44'/60'/0'/0/0` แบบ MetaMask) และ Noble (`m/44'/118'/0'/0/0`)
  สร้างจาก entropy ของเครื่อง เก็บในที่ที่อ่านได้เฉพาะผู้ใช้ `relayer` ไฟล์ seed ชั่วคราวถูก `shred` ทิ้ง
- พิมพ์ **แค่ที่อยู่** เช่น
  ```
  ZETAPHY (zetaphy_77390-1):  zetaphy1…
                               0x…  (the same account in MetaMask)
  Noble   (grand-1):  noble1…
  ```
รันซ้ำได้: ของที่มีแล้ว (Hermes, ผู้ใช้, กุญแจ) ไม่ถูกสร้างใหม่

### 4. เติมค่าแก๊ส
1. **ZETAPHY**: ใน MetaMask ส่ง **10 ZTPHY** ไปที่อยู่ `0x…` ของ relayer (พอใช้หลายเดือน)
2. **Noble**: เปิด **faucet.circle.com** → เลือก **USDC** และ **Noble Testnet** → วางที่อยู่ `noble1…` → ขอ
   USDC นี้ใช้ทั้งเป็นค่าแก๊สบน Noble และเป็น USDC ที่จะโอนเข้า ZETAPHY
3. ตรวจ: `sudo bash setup-relayer.sh balances`

### 5. เปิดช่อง IBC
```bash
sudo bash setup-relayer.sh create-channel
```
สร้าง light client ทั้งสองฝั่ง, connection และช่อง `transfer` (ใช้เวลาไม่กี่นาที) แล้วพิมพ์เช่น
```
ZETAPHY_CHANNEL=channel-0
NOBLE_CHANNEL=channel-123
```
**จดเลขช่องฝั่ง ZETAPHY** (`channel-0`) ใช้กับ `gov.sh` ข้างล่าง รันซ้ำได้: ถ้าช่องเปิดอยู่แล้วจะไม่สร้างใหม่
หลังจากนี้ relayer ส่งเฉพาะช่องนี้ (packet filter)

### 6. เริ่ม relayer
```bash
sudo bash setup-relayer.sh start      # service ชื่อ hermes-relayer, เปิดเองหลังรีบูต
sudo bash setup-relayer.sh status
```

### 7. โอน USDC ก้อนแรกเข้า ZETAPHY
```bash
sudo bash setup-relayer.sh send-usdc <ที่อยู่ MetaMask 0x…> 1000000     # 1 USDC
```
ส่งจากที่อยู่ Noble ของ relayer (ที่ได้จาก faucet) ภายในราวหนึ่งนาที USDC เข้า ZETAPHY
ก้อนแรกนี้ทำให้ USDC กลายเป็น ERC-20 บนเชนโดยอัตโนมัติ และจำเป็นก่อนตั้งเพดาน (ข้อ 9)
จะโอนจาก Keplr บน Noble testnet ก็ได้ (IBC transfer แบบกำหนดช่องเอง → ช่อง `NOBLE_CHANNEL`)

### 8. USDC เป็น ERC-20 (MetaMask, explorer, DEX)
บนเครื่อง ในฐานะผู้ใช้ `zetaphy`:
```bash
sudo -iu zetaphy
gov.sh ibc-usdc-denom channel-0        # ibc/<hash> และที่อยู่ ERC-20 (ไม่ต้องต่อเชน)
gov.sh ibc-usdc-erc20 channel-0        # ที่อยู่จริงบนเชน + รายการ token list (JSON)
```
- Cosmos EVM v0.7.3 **ไม่มี proposal สำหรับลงทะเบียนเหรียญ IBC**: โมดูล erc20 ลงทะเบียน `ibc/…` ทุกตัวเองตอนเหรียญแรกมาถึง
  (IBC middleware, แบบ "STRv2") ที่อยู่ ERC-20 = 20 ไบต์ท้ายของ hash ของเหรียญ และใช้ได้ทันทีกับ `balanceOf`, `transfer`, `approve`
- `MsgRegisterERC20` ของ v0.7.3 ใช้กับสัญญา ERC-20 ที่มีอยู่แล้วเท่านั้น (ไม่ใช่กรณีนี้)
- ถ้าโหวตเคยหยุด ERC-20 ตัวนี้ไว้ `ibc-usdc-erc20` จะเสนอ `MsgToggleConversion` ให้เปิดคืน; ถ้าทั้งโมดูลปิดอยู่ จะเสนอ `MsgUpdateParams` (`enable_erc20: true`)
- MetaMask: **Import tokens** → วางที่อยู่ ERC-20
- ใช้ JSON ที่พิมพ์ออกมาใส่ใน token list ของ explorer, กระเป๋า และ DEX (`symbol USDC`, `decimals 6`)

**⚠️ เรื่องทศนิยมบน testnet ปัจจุบัน:** ibc-go v11 เขียน metadata ของเหรียญ IBC ให้เองตอนเหรียญแรกมาถึง แบบค่าเริ่มต้น
(symbol `UUSDC`, หน่วยเดียวทศนิยม 0) ทำให้ `decimals()` ของ ERC-20 ตอบ **0** และ `symbol()` ตอบ `UUSDC`
กระเป๋าที่อ่านจากสัญญาจะแสดงยอดเป็น uusdc (1 USDC แสดงเป็น 1,000,000) `gov.sh ibc-usdc-erc20` จะเตือนเมื่อเป็นแบบนี้
- ใน v0.7.3/SDK v0.54 ไม่มีข้อความโหวตใดแก้ metadata ได้ ต้องแก้ด้วย **การอัปเกรดเชน** (handler ที่ตั้งค่าตาม `gov.sh ibc-usdc-metadata channel-0`)
- เชนใหม่ (เช่น mainnet): ใส่ผลของ `gov.sh ibc-usdc-metadata <ช่องที่จะได้>` ใน `app_state.bank.denom_metadata` ของ genesis
  ibc-go จะไม่เขียนทับ และ ERC-20 จะตอบ `USDC` / 6 ตำแหน่ง (`test-ibc.sh` พิสูจน์ทั้งสองกรณี)
  ช่องแรกที่เปิดบนเชนใหม่คือ `channel-0` จึงเดาเลขได้ แต่ต้องเปิดช่องไป Noble เป็นช่องแรกจริง ๆ

### 9. ตั้งเพดาน USDC (โหวต)
```bash
gov.sh ibc-usdc-ratelimit channel-0            # ค่าเริ่มต้นต่ำ: ออก 1% / เข้า 1% ต่อ 24 ชม.
gov.sh vote <เลข> yes
gov.sh ratelimits                               # หลังโหวตผ่าน (10 นาทีบน testnet)
```
- เพดานเป็น **% ของ USDC ทั้งหมดที่อยู่บน ZETAPHY** (นับตอนต้นรอบ) ไม่ใช่จำนวนตายตัว และนับสุทธิ (เข้า − ออก)
  - ถ้ามี USDC บนเชน 100 USDC เพดาน 1% = 1 USDC ต่อวัน; ถ้ามีแค่ 1 USDC = 0.01 USDC ต่อวัน
  - จึงต้องมี USDC บนเชนก่อน (ข้อ 7) ไม่งั้นโมดูลปฏิเสธ (`gov.sh` บอกให้ทำข้อ 7 ก่อน)
  - ช่วงเริ่ม ถ้าเพดานแน่นเกินจนโอนไม่ได้ ให้โอนเข้ามากขึ้นก่อน หรือโหวตเพิ่มเพดาน
- รันคำสั่งเดิมด้วยค่าใหม่เพื่อ **เปลี่ยน** เพดาน (เสนอ `MsgUpdateRateLimit` ตัวนับเริ่มใหม่) เช่น `gov.sh ibc-usdc-ratelimit channel-0 10 10 24`
- โอนที่เกินเพดาน: ขาเข้า → Noble คืนเงินให้ผู้ส่ง, ขาออก → ธุรกรรมไม่ผ่าน เงินไม่หายทั้งสองทาง

---

## ดูแล relayer

| ดู | คำสั่ง (บนเครื่อง) |
|---|---|
| ภาพรวม: ทำงานไหม, ช่อง, health check, ยอดแก๊ส, log ล่าสุด | `sudo bash setup-relayer.sh status` |
| ยอดแก๊สสองฝั่ง | `sudo bash setup-relayer.sh balances` |
| log สด | `journalctl -u hermes-relayer -f` |
| ตัวเลข (Prometheus, ในเครื่องเท่านั้น) | `curl -s 127.0.0.1:3001/metrics \| grep -E 'wallet_balance\|tx_latency\|send_packet'` |
| หยุด / เริ่ม | `sudo bash setup-relayer.sh stop` / `start` |

- ตรวจอย่างน้อยสัปดาห์ละครั้ง: `status` ต้องขึ้น `relayer: running` และยอด Noble ต้องเหลือ (เติมจาก faucet เมื่อน้อย)
- relayer อัปเดต light client เองทุก ~4.7 วัน (1/3 ของ 14 วัน) แม้ไม่มีใครโอน **อย่าปล่อยให้หยุดเกิน 14 วัน** (ดูความเสี่ยง)
- `WARN … SDK module at version '0.54.3' does not meet compatibility requirements >=0.46, <0.54` ใน health check ของฝั่ง ZETAPHY
  เป็นแค่คำเตือนของ Hermes 1.13 (ยังไม่รู้จัก SDK v0.54) การทดสอบบนเชนจริงผ่านทุกข้อ
- `account sequence mismatch … retrying` ใน log เป็นเรื่องปกติ Hermes ลองใหม่เอง

## ค่าใช้จ่าย

| อะไร | เท่าไร |
|---|---|
| Hermes, เครื่อง | ฟรี (เครื่อง Oracle เดิม, ใช้ RAM ราวร้อยกว่า MB) |
| แก๊สฝั่ง ZETAPHY | ราว 0.0005 ZETAPHY ต่อข้อความ (แก๊ส ~250,000 × 2 gwei) เหรียญ testnet ไม่มีมูลค่า |
| แก๊สฝั่ง Noble testnet | ราว 0.02–0.03 USDC ต่อธุรกรรม (แก๊ส ~200,000–300,000 × 0.1 uusdc) จ่ายด้วย USDC จาก faucet ฟรี |
| ต่อการโอนหนึ่งครั้ง | Noble → ZETAPHY: รับฝั่ง ZETAPHY + ยืนยันกลับฝั่ง Noble; บวกการอัปเดต client เป็นระยะ |

ตัวเลขเป็นค่าประมาณจากแก๊สที่เห็นในการทดสอบ `test-ibc.sh` (ไม่ใช่ Noble จริง)

## ความเสี่ยง

- **relayer ล่ม = ช้า ไม่ใช่เสียเงิน (liveness เท่านั้น):** relayer แค่ขนหลักฐานระหว่างเชน ปลอมหรือขโมยไม่ได้
  เพราะแต่ละเชนตรวจหลักฐานด้วย light client ของอีกฝั่งเอง ข้อความที่ค้างจะถูกส่งเมื่อ relayer กลับมา (`clear_on_start`)
  การโอนที่หมดเวลา (10 นาทีสำหรับ `send-usdc`) จะคืนเงินผู้ส่ง ใครก็รัน relayer ของช่องนี้ซ้ำได้
- **กุญแจ relayer** ถือแค่ค่าแก๊ส ถ้าหลุด เสียแค่ค่าแก๊ส (ไม่มีสิทธิ์อะไรกับเงินในช่อง)
- **light client หมดอายุ:** ถ้าไม่มีการอัปเดตเกิน `trusting_period` (14 วัน) ช่องจะใช้ไม่ได้จนกว่าจะกู้ client ด้วยการโหวต
  ฝั่ง Noble ต้องใช้การโหวตของ Noble ซึ่งเราคุมไม่ได้ → ต้องให้ relayer ทำงานต่อเนื่อง; เงินยังปลอดภัยแต่ติดอยู่
- **ไม่ต้านควอนตัม:** light client ของ IBC (ทั้งของ Noble ที่ตรวจเรา และของเราที่ตรวจ Noble) ตรวจลายเซ็น validator แบบ ed25519
  ซึ่งคอมพิวเตอร์ควอนตัมในอนาคตปลอมได้ ใบรับรอง ML-DSA ของ ZETAPHY (ขั้น 5) ยังไม่มี light client ฝั่งไหนตรวจ
  ระหว่างนี้เพดาน `x/ratelimit` จำกัดความเสียหายต่อรอบ
- **USDC เป็นของ Circle:** Circle อายัด/หยุดที่อยู่บน Noble ได้ USDC บน ZETAPHY มีค่าเพราะ USDC ที่ถูกล็อกไว้ในช่องบน Noble
- **RPC สาธารณะของ Noble** (Polkachu, Strangelove) ฟรีแต่ไม่มีสัญญาบริการ อาจจำกัดอัตราหรือเปลี่ยนที่อยู่ เปลี่ยนด้วย `NOBLE_RPC`/`NOBLE_GRPC`
- **Noble testnet อาจรีเซ็ตหรืออัปเกรด** ถ้า `grand-1` เปลี่ยน chain id ต้องเปิดช่องใหม่ (`channel.env` ลบแล้ว `create-channel`) ⚠️ TODO
- **ทศนิยมของ ERC-20** บน testnet (ข้อ 8)

## ทางไป mainnet (`noble-1`)

**ทำได้หลังผ่านเงื่อนไข audit เท่านั้น** (`docs/LAUNCH.md` ข้อ 14, `docs/MAINNET_RUNBOOK.md`): เชนและโมดูล `x/ratelimit` ผ่าน audit อิสระ,
แก้ทุกข้อระดับ medium ขึ้นไป, validator อิสระ, กุญแจ multisig/HSM ตามที่ README หลักกำหนด

ค่าของ Noble mainnet (cosmos/chain-registry `noble/chain.json`): chain id `noble-1` (ยืนยันกับ `upgrade/constants.go` ด้วย),
ค่าแก๊ส `0.1` uusdc (fixed min), RPC เช่น `https://noble-rpc.polkachu.com:443`, gRPC `noble-grpc.polkachu.com:21590`
```bash
sudo NOBLE_CHAIN_ID=noble-1 NOBLE_RPC=https://noble-rpc.polkachu.com:443 NOBLE_GRPC=http://noble-grpc.polkachu.com:21590 \
  ZETAPHY_CHAIN_ID=<chain id mainnet> bash setup-relayer.sh
```
สิ่งที่ต้องมีเพิ่ม:
- metadata ของ USDC ใน genesis (`gov.sh ibc-usdc-metadata channel-0`) ให้ ERC-20 เป็น 6 ตำแหน่งตั้งแต่ต้น
- เพดานตั้งก่อนประกาศ และเริ่มต่ำ (`ibc-usdc-ratelimit` ค่าเริ่มต้น 1%)
- relayer อย่างน้อย 2 ตัวบนเครื่องคนละที่ + การแจ้งเตือนเมื่อยอดแก๊สต่ำหรือหยุด
- ⚠️ TODO: ตรวจกับทีม Noble ว่าการเปิดช่องไป `noble-1` ต้องขออนุญาตหรือลงทะเบียนอะไร และลงช่องใน cosmos/chain-registry `_IBC/` ให้กระเป๋าเห็น

## ทดสอบ (ไม่ต้องใช้ Noble)

`test-ibc.sh` เปิดเชน ZETAPHY ทดลอง 2 เชน (`zetaphy_77390-1` และ `zetaphy_77391-1` ซึ่งแทน Noble และมี `uusdc`)
ใช้ `setup-relayer.sh` ตัวจริงตั้ง Hermes (ฝั่ง "Noble" ชี้ไปเชนที่สอง) แล้วตรวจ: ช่องเปิด, รันซ้ำไม่สร้างของใหม่,
hash ของเหรียญตรงกับเชน, USDC เข้าและกลายเป็น ERC-20 ที่ `eth_call balanceOf` อ่านได้, metadata ใน genesis ให้ 6 ตำแหน่ง,
หยุด/เปิด ERC-20 ด้วยโหวต, เพดาน 1% ผ่านโหวตแล้วกันการโอนเกินเพดานทั้งขาเข้า (คืนเงิน) และขาออก (ธุรกรรมไม่ผ่าน), เปลี่ยนเพดานด้วยโหวต
```bash
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm --prefix zetaphy-network run test:devnet:ibc
npm --prefix zetaphy-network test      # รวม test/ibc.test.js: hash, ข้อความโหวต, config ของ Hermes (ไม่ต้องมีเชน)
```
ถ้าดาวน์โหลด Hermes ไม่ได้ การทดสอบบนเชนจะ SKIP พร้อมบอกเหตุผล (ตั้ง `HERMES_TARBALL` เป็นไฟล์ที่โหลดไว้แล้วได้)
