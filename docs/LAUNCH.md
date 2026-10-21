# วันเปิด ZETAPHY testnet: เช็กลิสต์ของเจ้าของ

ไล่ทำจากบนลงล่าง จากศูนย์จนถึง testnet ที่ใช้งานได้จริง
- **ทุกขั้นทำบนหน้าเว็บ** (Oracle, GitHub, Vercel, MetaMask, ผู้ให้บริการ DNS) ไม่ต้องรันอะไรบนคอมพิวเตอร์ของคุณ
- **ฟรีทั้งหมด** (Oracle Always Free, GitHub Actions, Vercel Hobby, npm สาธารณะ, Reown ฟรี)
- **testnet เท่านั้น** เหรียญไม่มีมูลค่า สัญญายังไม่ผ่าน audit (ข้อ 14)
- **ห้ามส่ง private key, seed หรือรหัสผ่านใด ๆ ในแชต** รวมถึงในแชตกับ Claude: Claude ไม่ขอและไม่ต้องใช้

สัญลักษณ์: 🤖 = Claude ทำต่อให้ได้ เมื่อคุณให้สิทธิ์ที่บอกไว้ หรือเมื่อเชนเปิดแล้ว

| ข้อ | ทำอะไร | ใครทำ |
|---|---|---|
| 1 | สร้างเครื่อง Oracle + วาง `cloud-init.sh` + เปิดพอร์ต | คุณ |
| 2 | รอแล้วตรวจว่าเชนทำงาน | คุณ (🤖 ตรวจ RPC ให้ได้เมื่อรู้ชื่อโฮสต์) |
| 3 | สร้างกระเป๋า deployer ใหม่แล้วโอน ZETAPHY ให้ | คุณ |
| 4 | ใส่ key ใน GitHub secret `ZETAPHY_DEPLOYER_KEY` | คุณ |
| 5 | รัน workflow **launch-testnet** แล้ว merge PR | คุณ หรือ 🤖 (ถ้าให้สิทธิ์ GitHub Actions) |
| 6 | โปรเจกต์ Vercel: wallet, explorer, DEX, NFT | คุณ หรือ 🤖 (ถ้าให้สิทธิ์ Vercel ของทีม) |
| 7 | DNS: CNAME `explorer`, `swap`, `nft`, `wallet` | คุณ (🤖 ถ้า DNS อยู่ที่ Vercel) |
| 8 | ส่งต่อสิทธิ์ผู้ดูแลให้การโหวต (gov) | คุณ (🤖 รัน workflow ได้; โหวตต้องทำบนเครื่อง) |
| 9 | MetaMask Snap: npm + allowlist | คุณ + 🤖 |
| 10 | WalletConnect projectId | คุณสมัคร, 🤖 ใส่ค่า |
| 11 | อีเมลติดต่อใน `docs/LEGAL.md` และ `legal.html` | คุณให้อีเมล, 🤖 แก้ไฟล์ |
| 12 | ปรึกษาทนาย | คุณ |
| 13 | PR ขึ้นรายชื่อ chainlist / Keplr | 🤖 เตรียมไฟล์, คุณเปิด PR จากบัญชีคุณ |
| 14 | audit ก่อนมีเงินจริง | คุณ |
| 15 | IBC + USDC จาก Noble testnet (relayer บนเครื่องโหนด) | คุณ (🤖 ตรวจผลให้ได้) |
| 16 | สะพาน: ปิดไว้ก่อน เปิดเมื่อผ่านทุกประตู + ตัวเฝ้าดู | คุณ (🤖 ตรวจประตูให้ได้) |

---

## 1. สร้างเครื่อง Oracle และวาง `cloud-init.sh`

> ใช้ **Google Cloud e2-micro** แทนได้: ทำตามหัวข้อ "Google Cloud e2-micro (ฟรีถาวร)" ใน [`zetaphy-chain/README.md`](../zetaphy-chain/README.md) (วาง `setup-node.sh` ทั้งไฟล์, เปิดพอร์ต 26656, ตั้ง Budget alert $1) แล้วข้ามไปข้อ 2

ทำตาม [`zetaphy-chain/README.md`](../zetaphy-chain/README.md) หัวข้อ "ตั้งเครื่องบน Oracle Cloud" สรุป:
1. **cloud.oracle.com** → สมัคร Free Tier → Home Region **Singapore**
2. เมนู ☰ → **Compute → Instances → Create instance**
   - Name `zetaphy-node-0`, Image **Canonical Ubuntu 24.04**, Shape **Ampere VM.Standard.A1.Flex** (2 OCPU / 12 GB)
   - Networking: ค่าเริ่มต้น มี **public IPv4**
   - SSH keys: **Generate a key pair for me** → **Save private key** (เก็บไว้ ใช้ในข้อ 8)
   - **Show advanced options → Management → Paste cloud-init script**: เปิด [`zetaphy-chain/cloud-init.sh`](../zetaphy-chain/cloud-init.sh) บน GitHub → **Raw** → คัดลอกทั้งหมด → วาง
   - **แนะนำ:** แก้บรรทัด `OWNER_EVM_ADDRESS=""` เป็นที่อยู่ MetaMask **หลัก** ของคุณ (ที่อยู่ 0x… เท่านั้น ห้ามใส่ key) เพื่อรับ 1,000,000 ZETAPHY ทดลอง ใช้โอนให้ deployer ในข้อ 3
3. **Create** แล้วรอ (A1 ประมาณ 15–25 นาที)
4. **เปิดพอร์ต:** หน้าเครื่อง → **Primary VNIC → Subnet** → **Security Lists** → *Default Security List* → **Add Ingress Rules**
   (Source CIDR `0.0.0.0/0`, IP Protocol **TCP**) ทีละพอร์ต: **80**, **443**, **8545**, **26656**
   - 80/443: https ฟรีจาก Let's Encrypt ที่ `https://<IP เปลี่ยนจุดเป็นขีด>.sslip.io` (เว็บทุกตัวต้องใช้ https)
   - 8545: MetaMask แบบ http, 26656: เครื่องอื่นมาต่อเชน

## 2. รอแล้วตรวจว่าเชนทำงาน

1. หน้าเครื่องใน Oracle: จด **Public IP address** เช่น `1.2.3.4` → ชื่อโฮสต์คือ `1-2-3-4.sslip.io`
2. เปิดในเบราว์เซอร์ (มือถือก็ได้): `https://1-2-3-4.sslip.io/zetaphy/evm-chain.json`
   - ขึ้น JSON ที่มี `"chainId": "0x12e4e"` และ `"rpcUrls": ["https://1-2-3-4.sslip.io"]` = เชนและ https พร้อมแล้ว
   - ค่าเดียวกับใน `NODE-INFO.txt` บนเครื่อง (บรรทัด **HTTPS RPC (wallet)**) ดูไฟล์นั้นได้ที่หน้าเครื่อง → **Resources → Console connection** หรือ Cloud Shell (ข้อ 8)
   - ถ้ายังไม่ขึ้น: รอต่อ หรือดู log ตาม `zetaphy-chain/README.md` ข้อ 4
3. เพิ่มเครือข่ายใน MetaMask: RPC `https://1-2-3-4.sslip.io`, Chain ID `77390`, สัญลักษณ์ `ZTPHY`
   ถ้าใส่ `OWNER_EVM_ADDRESS` ไว้ จะเห็น 1,000,000 ZTPHY

**URL ที่ใช้ทุกข้อต่อจากนี้** = `https://1-2-3-4.sslip.io` (แทนด้วยของจริง) เรียกว่า **RPC**

🤖 บอกชื่อโฮสต์ให้ Claude แล้ว Claude ตรวจ `eth_chainId`, ความสูงบล็อก และ https ให้ได้

## 3. สร้างกระเป๋า deployer ใหม่ แล้วโอน ZETAPHY ให้

deployer คือบัญชีที่ workflow ใช้ deploy สัญญา ใช้ **บัญชีใหม่แยกต่างหาก** ไม่ใช่บัญชีหลัก

**สร้าง (วิธีที่ง่ายและปลอดภัยที่สุดแบบฟรี: MetaMask):**
1. MetaMask → แตะชื่อบัญชีด้านบน → **Add account or hardware wallet → Add a new account** → ตั้งชื่อ `ZETAPHY deployer`
2. คัดลอก **ที่อยู่** (0x…) ของบัญชีนี้ไว้ (ที่อยู่เปิดเผยได้ ส่งให้ Claude ได้)

**โอนเงินให้:** ใน MetaMask สลับไปบัญชีหลัก (ที่ได้ 1,000,000 ZTPHY) บนเครือข่าย ZETAPHY Testnet → **Send** → วางที่อยู่ deployer → **1,000 ZTPHY** → Confirm
- ใช้จริงประมาณ 300 ZETAPHY: 100 เป็นทุนสำรองของ StableGateway, 200 เป็นสภาพคล่องเริ่มต้นของ 2 พูลทดลองใน DEX ค่าแก๊สทั้งหมดไม่ถึง 1 ZETAPHY
  (ข้อ 5 รันแบบ dry run ก่อน จะบอกยอดที่ต้องใช้และยอดที่มีจริง)
- faucet ของเชน (`zetaphy_faucet`) ให้แค่ 10 ZETAPHY ต่อวัน ไม่พอสำหรับ deploy

**ถ้าไม่ได้ใส่ `OWNER_EVM_ADDRESS`:** เหรียญอยู่ในบัญชี genesis `liquidity` บนเครื่อง เข้าเครื่องตามข้อ 8 ("เข้าเครื่อง") แล้วพิมพ์ในหน้าต่างนั้น:
```bash
sudo -iu zetaphy
zetaphyd debug addr 0xที่อยู่deployer          # ได้ "Bech32 Acc: zetaphy1…"
zetaphyd tx bank send liquidity zetaphy1… 1000000000000000000000azetaphy --keyring-backend test \
  --keyring-dir ~/.zetaphy-genesis-keys --chain-id zetaphy_77390-1 --gas auto --gas-adjustment 1.5 --gas-prices 1000000000azetaphy -y
```
(1,000 ZETAPHY = `1000` ตามด้วยเลขศูนย์ 18 ตัว หน่วย `azetaphy`) ไม่มี key ออกจากเครื่อง

## 4. ใส่ key ใน GitHub secret `ZETAPHY_DEPLOYER_KEY`

1. MetaMask → บัญชี `ZETAPHY deployer` → ⋮ → **Account details → Show private key** → ใส่รหัสผ่าน MetaMask → กดค้างเพื่อแสดง → **Copy**
2. GitHub → repo `swd-amm` → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ZETAPHY_DEPLOYER_KEY`
   - Secret: วาง key (มีหรือไม่มี `0x` ก็ได้) → **Add secret**
3. ล้างคลิปบอร์ด (คัดลอกข้อความอื่นทับ)

**ทำไมใช้วิธีนี้ และข้อแลกเปลี่ยนตามจริง**
- **ดี:** ฟรี ไม่ต้องติดตั้งอะไร key ไม่ผ่านแชตหรือ log; GitHub เก็บ secret แบบเข้ารหัส อ่านย้อนไม่ได้ (เขียนทับได้อย่างเดียว) และปิดบังค่าใน log อัตโนมัติ
- **ข้อเสีย:** key ปรากฏบนจอคุณหนึ่งครั้งและผ่านคลิปบอร์ด; MetaMask ของคุณยังถือ key นี้อยู่ด้วย
  (รับได้สำหรับ testnet: บัญชีนี้มีแค่เหรียญทดลอง และหลังข้อ 8 ไม่มีสิทธิ์ผู้ดูแลอะไรเหลือ)
- **ทางเลือกที่ไม่แนะนำ:**
  - ให้ workflow สร้าง key แล้วเขียนเป็น secret เอง: `GITHUB_TOKEN` เขียน secret ไม่ได้ ต้องสร้าง Personal Access Token สิทธิ์ "Secrets: write"
    แล้วเก็บเป็น secret อีกตัว ซึ่งเป็นความลับที่มีอำนาจมากกว่า key ทดลองนี้เสียอีก
  - ให้ workflow สร้าง key แล้วเก็บเป็น artifact เข้ารหัส: คุณต้องดาวน์โหลดและถอดรหัสบนเครื่องตัวเองก่อนใส่ secret ซึ่งผิดเงื่อนไข "ไม่รันอะไรบนเครื่อง"
    และ artifact ใน repo สาธารณะใครก็ดาวน์โหลดได้
- เปลี่ยน key ภายหลัง: สร้างบัญชีใหม่ตามข้อ 3 แล้ว **Update** secret เดิม (แต่ state ของ launch ผูกกับ deployer เดิม ดูข้อ 5 "รันซ้ำ")

## 5. รัน workflow **launch-testnet** แล้ว merge PR

ครั้งแรกเปิดสิทธิ์ให้ workflow เปิด PR ได้: **Settings → Actions → General → Workflow permissions** → ติ๊ก
**Allow GitHub Actions to create and approve pull requests** → Save (ถ้าไม่เปิด workflow ยัง push branch ได้ และบอกลิงก์ให้เปิด PR เอง)

**รอบที่ 1 (dry run: ตรวจอย่างเดียว ไม่ส่งธุรกรรม)**
1. **Actions → launch-testnet → Run workflow**
2. `rpc` = RPC จากข้อ 2 (เช่น `https://1-2-3-4.sslip.io`), `dry_run` = **yes**, ที่เหลือค่าเริ่มต้น → **Run workflow**
3. เปิด run → job **Launch** → ขั้น **Launch** ต้องเห็น:
   - `ZETAPHY testnet (EVM chain 77390)` และ `deployer 0x…` ตรงกับที่อยู่ในข้อ 3
   - `balance … need about …` ยอดมีพอ, และรายการ `would run:` ของทุกขั้น

**รอบที่ 2 (ของจริง)**
1. Run workflow อีกครั้ง: `rpc` เดิม, `dry_run` = **no**, `governance` = `deployer`, `handover` = `no`
   - `neuro_url` = หน้าเว็บ Neuro บน Vercel ลงท้าย `/web/` (ค่าเริ่มต้น `https://swd-amm-zetaphy-neuro.vercel.app/web/` ถ้าใช้โดเมนอื่นให้แก้)
   - `wallet_origin` = `https://wallet.sawasdeecoin.com` (โดเมนกระเป๋าในข้อ 7) ถ้ายังไม่มีเว้นว่าง
2. ใช้เวลาไม่กี่นาที workflow:
   - deploy: NeuroJobs + NeuroControl (โหวต skill ปัจจุบันเข้าแล้ว), ThreatRegistry, ThreatReports, NeuroIdentity + NeuroValidation,
     RewardVault, QuantumWalletFactory, test USDC/USDT + StableGateway, ComputeMarket, DEX (factory, router, 2 เหรียญทดลองพร้อมพูล), NFT (factory, marketplace)
   - ต่อสาย: DEX และ NFT ตรวจ ThreatRegistry, ป้องกันโค้ดร่วมของคอลเลกชัน NFT ใน ThreatRegistry (ธงเดียวจะได้ไม่โดนทุกคอลเลกชัน)
   - เขียน config: `zetaphy-dex/web/deployments.json`, `zetaphy-nft/web/deployments.json`, `zetaphy-explorer/config.json`,
     `zetaphy-wallet/index.html` (RPC และ ThreatRegistry), `zetaphy-snap/snap.config.js` แล้ว build snap ใหม่ (shasum ใน `snap.manifest.json`)
   - บันทึกที่อยู่ทั้งหมดใน `zetaphy-launch/state/77390.json` (ที่อยู่เท่านั้น ไม่มี key) และแนบเป็น artifact ของ run
3. **Pull requests** → เปิด PR "Testnet launch: contract addresses and web configs" → ดู diff (มีแต่ที่อยู่และ RPC) → **Merge**
   Vercel deploy เว็บใหม่เองหลัง merge

**ถ้าพังกลางทาง:** แค่กด Run workflow ซ้ำด้วยค่าเดิม ขั้นที่เสร็จแล้วถูกข้าม (state อยู่ใน branch `launch/testnet`) ไม่ deploy ซ้ำ
PR ที่ขึ้นว่า **Partial** อย่าเพิ่ง merge
**เชนถูกล้าง/เริ่มใหม่:** workflow จะปฏิเสธ (บล็อก 1 ไม่ตรงกับ state) ลบไฟล์ `zetaphy-launch/state/77390.json` ใน branch `launch/testnet` (หรือลบ branch นั้น) แล้วรันใหม่
**ไม่ทำโดยค่าเริ่มต้น:** สะพาน Neuro (`zetaphy deploy-bridge`) ต้องมี LockBox บนเชนต้นทางก่อน; เมื่อมีแล้ว 🤖 รันให้ได้ด้วย `--bridge-lockbox <chainId>:0x…`
**สะพาน lock/mint ติดตั้งแบบปิด (CLOSED) เสมอ:** ขั้น bridge ของ workflow ติดตั้งสัญญาแต่ไม่เปิด route (เพดานแข็ง 1,000 โทเคน) และจะล้มถ้าพบว่า route เปิดอยู่
workflow นี้ **เปิดสะพานไม่ได้** ดูข้อ 16
ส่วนการย้ายกองรางวัล 500 ล้านเข้า RewardVault ใช้ key `rewards` บนเครื่อง (`zetaphy deploy-vault --fund` ใน `zetaphy-network/README.md`)

🤖 ถ้าให้ Claude ใช้ GitHub Actions ของ repo นี้ได้ Claude กด Run workflow, อ่านผล และรีวิว PR ให้ได้ (secret ยังเป็นของคุณ Claude ไม่เห็นค่า)

## 6. โปรเจกต์ Vercel

vercel.com (Hobby ฟรี) → **Add New… → Project** → Import repo `swd-amm` → ตั้ง **Root Directory** ตามตาราง,
Framework Preset **Other**, ไม่ต้องตั้ง Build/Output (มี `vercel.json` ในแต่ละโฟลเดอร์แล้ว) → **Deploy**

| เว็บ | Root Directory | โดเมน (ข้อ 7) |
|---|---|---|
| Neuro | `zetaphy-neuro` (มีอยู่แล้ว: `swd-amm-zetaphy-neuro`) | เดิม |
| กระเป๋า PQ | `zetaphy-wallet` | `wallet.sawasdeecoin.com` |
| Explorer | `zetaphy-explorer` | `explorer.sawasdeecoin.com` |
| DEX | `zetaphy-dex/web` | `swap.sawasdeecoin.com` |
| NFT | `zetaphy-nft/web` | `nft.sawasdeecoin.com` |

แต่ละโปรเจกต์: **Settings → Domains → Add** → พิมพ์โดเมนตามตาราง

🤖 ถ้าให้สิทธิ์ Vercel MCP กับทีม Vercel ของคุณ (Vercel → Integrations/consent ให้ทีม `swd-e92d`) Claude สร้างโปรเจกต์และเพิ่มโดเมนให้ได้

## 7. DNS: CNAME

ที่ผู้ให้บริการ DNS ของ `sawasdeecoin.com` เพิ่มระเบียน (ถ้าใช้ Cloudflare ตั้ง **DNS only** เมฆสีเทา):

| Type | Name | Value |
|---|---|---|
| CNAME | `explorer` | `cname.vercel-dns.com` |
| CNAME | `swap` | `cname.vercel-dns.com` |
| CNAME | `nft` | `cname.vercel-dns.com` |
| CNAME | `wallet` | `cname.vercel-dns.com` (ถ้าต้องการโดเมนกระเป๋า) |

รอใน Vercel จนขึ้น **Valid Configuration** (Vercel ออกใบรับรอง https ให้เอง)
ถ้าใส่ `wallet_origin` ในข้อ 5 ไม่ตรงกับโดเมนจริง รัน workflow ซ้ำด้วยค่าที่ถูก (snap จะ build ใหม่)

🤖 ถ้า DNS ของโดเมนอยู่ที่ Vercel และให้สิทธิ์แล้ว Claude เพิ่มระเบียนให้ได้

## 8. ส่งต่อสิทธิ์ผู้ดูแลให้การโหวต (gov)

ระหว่างเปิด testnet deployer เป็นผู้ดูแลทุกสัญญาไว้ก่อน ตั้งค่าเพิ่มได้ทันทีโดยไม่ต้องรอโหวต
**ส่งต่อเมื่อทุกอย่างใช้งานได้แล้วเท่านั้น** เพราะหลังจากนั้นการเปลี่ยนแปลงทุกอย่างต้องผ่านโหวต (proposal ฝาก 1,000 ZETAPHY, โหวต 10 นาที)

1. **Actions → launch-testnet → Run workflow**: `rpc` เดิม, `dry_run` = **no**, `governance` = **gov**, `handover` = **yes**
   - deployer ส่งธุรกรรมโอนสิทธิ์เอง (ไม่ต้องโหวต) ให้ gov module (`0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2`):
     NeuroControl, ThreatRegistry (คุม ThreatReports ด้วย), RewardVault, StableGateway, NeuroIdentity, NFT marketplace
   - DEX factory เป็นแบบสองขั้น: gov ต้อง "ตอบรับ" ด้วยการโหวต workflow เขียนไฟล์ proposal ไว้ที่
     `zetaphy-launch/state/proposals/77390-dex-accept-governance.json` (อยู่ใน PR และ artifact) แล้ว merge PR
   - ถ้าจะให้ multisig ถือแทน ใส่ `governance` = `0x<multisig>`; multisig ต้องเรียก `acceptGovernance()` ของ DEX factory เอง
2. **เข้าเครื่อง (ทำในเบราว์เซอร์):** หน้า Oracle → ไอคอน **Cloud Shell** `>_` มุมขวาบน →
   เมนูเฟือง ⚙ ของ Cloud Shell → **Upload** → เลือกไฟล์ private key ที่ Save ไว้ในข้อ 1 แล้วพิมพ์:
   ```bash
   chmod 600 ssh-key-*.key && ssh -i ssh-key-*.key ubuntu@<Public IP>
   sudo -iu zetaphy
   ```
3. **โหวตตอบรับ DEX:** เปิดไฟล์ proposal บน GitHub → **Raw** → คัดลอกทั้งหมด แล้วในหน้าต่างเครื่อง:
   ```bash
   cat > dex.json        # วาง แล้วกด Ctrl-D
   F="--from validator --keyring-backend test --keyring-dir ~/.zetaphy-genesis-keys --chain-id zetaphy_77390-1 --gas auto --gas-adjustment 1.5 --gas-prices 1000000000azetaphy -y"
   zetaphyd tx gov submit-proposal dex.json $F
   zetaphyd q gov proposals -o json | jq -r '.proposals[-1].id'     # เลข proposal
   zetaphyd tx gov vote <เลข> yes $F
   ```
   รอ 10 นาที `zetaphyd q gov proposal <เลข>` ต้องเป็น `PROPOSAL_STATUS_PASSED`
4. **ต่อจากนี้ Neuro ใช้โหวต:** สคริปต์ [`zetaphy-chain/gov.sh`](../zetaphy-chain/gov.sh) (คัดลอกไปไว้บนเครื่องแบบเดียวกับข้อ 3) เช่น
   `gov.sh neuro pause <NeuroControl>`, `gov.sh neuro approve-skill <skill id> <NeuroControl>` แล้ว `gov.sh vote <เลข> yes`
   ที่อยู่ NeuroControl อยู่ใน `zetaphy-launch/state/77390.json` (`neuroControl`) และ workflow พิมพ์คำสั่งเต็มให้ทุกครั้งที่รันโดยไม่ได้ handover

🤖 Claude รัน workflow ขั้น 1 ให้ได้ (ถ้าให้สิทธิ์ GitHub Actions) แต่การโหวตต้องใช้กุญแจ validator บนเครื่องของคุณ: คุณทำเอง

## 9. MetaMask Snap (npm และ allowlist)

ตอนนี้ snap ติดตั้งได้เฉพาะใน **MetaMask Flask** จาก npm; MetaMask ปกติต้องอยู่ใน allowlist (ต้อง audit ก่อน)
1. สมัคร **npmjs.com** (ฟรี) → เปิด **2FA** → **Add Organization** ชื่อ `zetaphy` (ฟรีสำหรับแพ็กเกจสาธารณะ)
   ถ้าชื่อถูกใช้แล้ว บอก Claude ชื่อ scope ใหม่ (🤖 แก้ชื่อทุกจุดตาม `zetaphy-snap/README.md`)
2. ไม่ต้อง publish จากเครื่องตัวเอง: npmjs.com → รูปโปรไฟล์ → **Access Tokens → Generate New Token → Granular Access Token**
   (Packages: Read and write เฉพาะ `@zetaphy`, หมดอายุสั้น ๆ) → คัดลอก → GitHub **Settings → Secrets and variables → Actions → New repository secret** ชื่อ `NPM_TOKEN`
3. 🤖 Claude เพิ่ม workflow publish (กดปุ่มเดียวแบบเดียวกับข้อ 5: build, ตรวจ shasum, `npm publish --access public` ด้วย `NPM_TOKEN`) ให้ได้เมื่อคุณพร้อม
   หลัง publish ชื่อ+เวอร์ชันนั้นแก้ไม่ได้ ควรรอให้ `snap.config.js` มีค่าจริงจากข้อ 5 และโดเมนกระเป๋าจากข้อ 7 ก่อน
4. ทดสอบใน MetaMask Flask: เปิดเว็บกระเป๋า → "ใช้ MetaMask (ZETAPHY Snap)"
5. **allowlist** (ทีหลัง): audit ของ snap (ข้อ 14) แล้วกรอกฟอร์ม https://go.metamask.io/snaps-directory-request ตาม `zetaphy-snap/README.md` ข้อ 7

## 10. WalletConnect projectId

1. **cloud.reown.com** (ฟรี) → สมัคร → **Create project** (ประเภท WalletKit/AppKit) → ใส่โดเมน `wallet.sawasdeecoin.com` ใน **Allowlist / Domain**
2. คัดลอก **Project ID** (ไม่ใช่ความลับ: อยู่ในหน้าเว็บสาธารณะอยู่แล้ว ส่งให้ Claude ได้)
3. 🤖 Claude ใส่ใน `<meta name="zetaphy-walletconnect-project-id">` ของ `zetaphy-wallet/index.html` (ปุ่มจะกดได้; การต่อ SDK จริงเป็นงานขั้นต่อไปตาม `zetaphy-wallet/README.md`)

## 11. อีเมลติดต่อ

ต้องมีช่องทางให้เจ้าของสัญญาที่ถูกติดธงขอชี้แจง/แก้ไข ตอนนี้เป็นข้อความเว้นว่างไว้:
- `docs/LEGAL.md` (`[ใส่อีเมลติดต่อของเจ้าของโครงการ]` และ `[project owner's contact email]`)
- `zetaphy-neuro/web/legal.html` (ไทยและอังกฤษ)

สร้างอีเมลสำหรับโครงการโดยเฉพาะ (เช่น Gmail ฟรี หรือ alias ของโดเมน) แล้ว 🤖 บอก Claude เพื่อแก้ทั้งสองไฟล์ หรือแก้เองบนหน้า GitHub (ไอคอนดินสอ → Commit changes)

## 12. ปรึกษาทนาย

ก่อนประกาศให้คนทั่วไปใช้ โดยเฉพาะ: การติดธงสัญญาของคนอื่น (หมิ่นประมาท/ความรับผิด), การแจก SWD airdrop, เหรียญและ stablecoin ทดลอง,
การเก็บข้อมูล (PDPA) ใช้ `docs/LEGAL.md` เป็นเอกสารตั้งต้นในการคุย (มีรายชื่อแหล่งช่วยเหลือทางกฎหมายฟรีในไทยที่ต้องตรวจสอบเอง)
Claude ไม่ใช่ทนาย และ testnet ไม่ทำให้ข้อนี้หมดไป

## 13. ขึ้นรายชื่อ chainlist และ Keplr

ทำหลังเชนเปิดนิ่งแล้ว และควรมีโดเมนถาวรแทน `sslip.io` (IP เปลี่ยน = รายชื่อพัง) ดู [`zetaphy-chain/wallets/README.md`](../zetaphy-chain/wallets/README.md) ข้อ 9
- chainlist: PR ไปที่ `ethereum-lists/chains` ด้วยไฟล์ `zetaphy-chain/wallets/ethereum-lists/eip155-77390.json`
- Keplr: PR ไปที่ `chainapsis/keplr-chain-registry` และ `cosmos/chain-registry` (`zetaphy-chain/wallets/chain-registry/zetaphytestnet/`)
- PR ต้องมาจากบัญชี GitHub ของคุณ: บนหน้าเว็บ GitHub กด **Fork** → **Add file → Create new file** → วางเนื้อไฟล์ → **Propose changes / Create pull request**

🤖 Claude เติม HOST/NODE_ID ในไฟล์ให้พร้อมวาง และตรวจ RPC/REST/websocket ที่ registry จะตรวจ

## 14. Audit ก่อนมีเงินจริง

ทุกอย่างในเช็กลิสต์นี้เป็น testnet สัญญาและเชนยังไม่ผ่าน audit (ขอบเขตอยู่ใน `docs/AUDIT_SCOPE.md` และ `docs/CHAIN_AUDIT_SCOPE.md`)
**ห้ามใช้กับเงินจริง** จนกว่าจะ audit โดยผู้ตรวจอิสระ แก้ทุกข้อระดับ medium ขึ้นไป และเปิดเผยรายงาน; mainnet ใช้ขั้นตอนใน `docs/MAINNET_RUNBOOK.md` ไม่ใช่ workflow นี้

## 15. IBC + USDC จาก Noble testnet

ต่อ ZETAPHY กับ Noble (เชนที่ Circle ออก USDC) ผ่าน IBC ฟรี ทำในเบราว์เซอร์ทั้งหมด รายละเอียดใน [`zetaphy-chain/ibc/README.md`](../zetaphy-chain/ibc/README.md)
ทำหลังข้อ 2 (เชนทำงาน) และใช้ Noble **testnet** (`grand-1`) เท่านั้น; mainnet (`noble-1`) รอข้อ 14
1. เข้าเครื่องทาง Cloud Shell แบบข้อ 8.2 (เป็น `ubuntu` ยังไม่ต้อง `sudo -iu zetaphy`) แล้วเอา `zetaphy-chain/ibc/setup-relayer.sh` ขึ้นเครื่อง (GitHub → **Raw** → `cat > setup-relayer.sh` วาง Ctrl-D)
2. `sudo bash setup-relayer.sh` → ได้ที่อยู่ relayer 2 ที่ (ไม่มี key ให้ถือ)
3. เติมแก๊ส: MetaMask ส่ง 10 ZTPHY ไปที่ `0x…` ของ relayer; **faucet.circle.com** → Noble Testnet → ที่อยู่ `noble1…`
4. `sudo bash setup-relayer.sh create-channel` → จด `ZETAPHY_CHANNEL` (เช่น `channel-0`) แล้ว `sudo bash setup-relayer.sh start`
5. `sudo bash setup-relayer.sh send-usdc <ที่อยู่ MetaMask> 1000000` (1 USDC เข้าเชน)
6. `sudo -iu zetaphy` แล้ว `gov.sh ibc-usdc-erc20 channel-0` (ที่อยู่ ERC-20 ไปใส่ MetaMask / token list) และ
   `gov.sh ibc-usdc-ratelimit channel-0` → `gov.sh vote <เลข> yes` (เพดาน 1% ต่อ 24 ชม.)
7. ดูแล: `sudo bash setup-relayer.sh status` สัปดาห์ละครั้ง เติม USDC จาก faucet เมื่อยอดฝั่ง Noble ต่ำ ห้ามหยุด relayer เกิน 14 วัน

🤖 บอกผลของ `status` (ไม่มีความลับในนั้น) แล้ว Claude ช่วยอ่านและแก้ปัญหาให้ได้

## 16. สะพาน: ปิดไว้จนกว่าจะผ่านทุกประตู

สะพาน lock/mint (`BridgeAirlock` → `BridgeGuard`) **ปิดอยู่** หลัง launch และต้องปิดต่อไปจนกว่าจะมี **ครบทุกข้อ** (การตัดสินใจของเจ้าของโครงการ):
1. **lane ที่สองที่อิสระจริง:** Hyperlane (`HyperlaneLane` + `HyperlaneLockBox`) ที่ผู้ควบคุม (Mailbox/ISM/validator ของ Hyperlane) ไม่ใช่กลุ่มเดียวกับคนรันร่าง Neuro
   ZETAPHY ยังไม่มี Hyperlane: ต้องติดตั้ง Mailbox, ISM, relayer และ validator ของ Hyperlane เองก่อน
2. **audit** สะพานโดยผู้ตรวจอิสระ (ข้อ 14) แล้วบันทึกลิงก์ https + sha256 ของรายงานบนเชน (`BridgeGuard.setAudit`)
3. **คนรันร่าง Neuro อิสระ ≥ 10** ราย (`NeuroJobs.activeWorkers`; ต้องตรวจว่าคนละคนจริงด้วยคน)
4. **guardian และ governance เป็น multisig คนละตัว** owner ≥ 3, ต้องเซ็น ≥ 2, แต่ละ owner ใช้ **hardware wallet (Ledger/Trezor ผ่าน MetaMask)** ของตัวเอง ไม่มีใครถือหลาย key
   ไม่มี owner คนเดียวกันในทั้งสองตัว และไม่ใช่ key ของ deployer (governance เป็น gov module ได้) ดูหัวข้อ "multisig + hardware wallet" ใน `zetaphy-network/README.md`
5. **bug bounty ที่มีเงินจริงแล้ว** (`docs/BUG_BOUNTY.md`: ตอนนี้เป็นเครดิตอย่างเดียว ต้องโหวตโอนเงินเข้ากองก่อน)
6. **ตัวเฝ้าดูทำงานแล้ว:** ใส่ `rpc` ใน `zetaphy-network/bridge-monitor.json` (หรือ variable `ZETAPHY_RPC`) workflow **bridge-monitor** รันทุก 15 นาที เปิด issue `bridge-alert` เมื่อมีแจ้งเตือน
   (Telegram/Discord: secret `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` ไม่บังคับ)
7. **เพดานเริ่มต่ำมาก:** 1,000 โทเคนต่อวัน ขึ้นได้ครั้งละไม่เกิน 2 เท่า และแต่ละครั้งรอ 7 วัน (`zetaphy bridge cap propose`) ตามตารางใน README

เมื่อครบแล้ว (บนเครื่องที่มี `zetaphy-network`; key นี้ไม่ต้องมีสิทธิ์อะไร คำสั่งพิมพ์ธุรกรรมให้ multisig เซ็น):
```bash
zetaphy bridge gates --audit-report https://<ผู้ตรวจ>/report.pdf --audit-sha256 <sha256sum ของไฟล์> --i-understand-real-funds   # ตรวจอย่างเดียว
zetaphy bridge open  --audit-report https://<ผู้ตรวจ>/report.pdf --audit-sha256 <sha256sum ของไฟล์> --i-understand-real-funds   # ผ่านทุกข้อ: พิมพ์ setAudit แล้ว setRoute ให้ governance
```
- ข้อใดไม่ผ่าน คำสั่งพิมพ์ทุกข้อที่ขาดและไม่ส่งอะไร · `BridgeGuard` เองก็ไม่ยอมเปิดถ้าไม่มี audit บนเชนหรือ lane อิสระไม่ถึง 2
- คำสั่งพิมพ์ตาราง lane / controller / admin / owner ของ multisig ให้คุณ **ตรวจด้วยตา** ก่อนให้ owner เซ็น
- ฉุกเฉิน: guardian `zetaphy bridge pause` (หยุดทันที) · เปิดคืนต้องเป็น governance (`unpause`)

🤖 Claude รัน `bridge gates` และอ่านผลตัวเฝ้าดูให้ได้ แต่การเซ็นของ multisig ต้องเป็นคุณและ owner คนอื่นบน hardware wallet ของตัวเอง

---

### อ้างอิง: launch.js

workflow เรียก `node zetaphy-launch/launch.js` (โค้ดอ่านได้ใน repo; `--help` บอกตัวเลือกทั้งหมด) สิ่งที่ควรรู้:
- ใช้โค้ด deploy ของแต่ละแพ็กเกจเอง (`zetaphy-network/cli.js`, `zetaphy-dex` `deploy()`, `zetaphy-nft/cli.js deploy`) ไม่ได้เขียนซ้ำ
- ตรวจก่อนทุกครั้ง: chain id ต้องเป็น 77390 (testnet เท่านั้น), ยอดเงิน deployer พอกับค่าประมาณ, state ตรงกับเชนและ deployer เดิม
- ทุกขั้นบันทึกใน `zetaphy-launch/state/77390.json` ทันทีที่เสร็จ (`--resume` ข้ามที่เสร็จแล้ว); ขั้นตรวจ (skill, wire, protect, configs, snap, handover) รันทุกครั้งและไม่ส่งธุรกรรมถ้าทุกอย่างถูกแล้ว
- key: รับจากไฟล์ (`--key-file`, chmod 600) หรือ env เท่านั้น ไม่รับบนบรรทัดคำสั่ง ไม่พิมพ์ ไม่เขียนลง state; workflow เขียน secret ลงไฟล์ 0600 ใน `$RUNNER_TEMP` แล้วลบทิ้งท้าย run
- ทดสอบ: `cd zetaphy-launch && npm test` (ตัวรันขั้น, state, ตัวเขียน config) และ `ZETAPHYD=… flock /tmp/ci-test/devnet.lock npm run test:devnet` (เชนจริงบนเครื่อง CI: deploy ทั้งหมด, smoke DEX/NFT/Neuro, handover + โหวตจริง)
