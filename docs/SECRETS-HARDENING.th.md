# ล็อก secret: ใช้ key ผ่าน GitHub Environments เท่านั้น

[English](SECRETS-HARDENING.md)

ทุก job ของ GitHub Actions ที่ใช้ private key หรือ token ตอนนี้อ่านค่าจาก **GitHub Environment**
ไม่ใช่จาก repository secret อีกต่อไป repository secret ถูกอ่านได้จากทุก workflow บนทุก branch
ที่ใครก็ตามที่มีสิทธิ์ write push ขึ้นมา ส่วน environment secret จะถูกส่งให้เฉพาะ job ที่ระบุชื่อ environment นั้น
และต้องผ่านกฎของ environment ก่อน คือ branch ไหนใช้ได้ และ (สำหรับ environment ที่เซ็นธุรกรรม) ต้องให้เจ้าของกดอนุมัติ

> **กฎ: ใช้กับ testnet เท่านั้น** environment เหล่านี้เก็บ key ของ **testnet** สำหรับ mainnet ห้ามใส่ deployer key,
> admin key หรือ upgrade key ไว้ใน CI เลย รวมถึงใน environment ด้วย การ deploy และการเรียกฟังก์ชัน admin บน mainnet
> ต้องเซ็นด้วย **Safe multisig ที่เจ้าของแต่ละคนใช้ hardware wallet** (หรือเซ็นด้วย hardware wallet โดยตรง)
> CI ทำได้แค่เตรียมธุรกรรม (calldata, ไฟล์ JSON ของ Safe Transaction Builder, gov proposal) ส่วนการเซ็นเป็นหน้าที่ของคน

เอกสารนี้และ workflow ทั้งหมดไม่มีค่า secret อยู่เลย ห้ามวางค่า secret ลงใน issue, pull request, แชต หรือ log

## 1. รายการ secret ทั้งหมด

ตัวย่อ trigger: `PR` = pull_request, `push`, `sched` = schedule, `manual` = workflow_dispatch
ไม่มี workflow ไหนใช้ `pull_request_target` หรือ `workflow_run` (ตรวจแล้ว ดูหัวข้อ 5)

| Secret | คืออะไร | Workflow → job | Trigger ของ workflow | job รันบน PR ไหม | Environment |
|---|---|---|---|---|---|
| `ZETAPHY_DEPLOYER_KEY` | EVM key ของ deployer บน testnet (`0x6af5…a245`) เป็น minter ของ BZTPHY และเป็น signer สำรองของ relayer ด้วย | `bridge-testnet` → `deploy` | PR, manual | ไม่ (เฉพาะ manual `deploy`) | `testnet-deploy` |
| | | `hyperlane-core` → `deploy` | manual | ไม่ | `testnet-deploy` |
| | | `launch-testnet` → `launch` | manual | ไม่ | `testnet-deploy` |
| | | `rewards` → `deploy` | PR, sched, manual | ไม่ (เฉพาะ manual `deploy`) | `testnet-deploy` |
| | | `saphan-route` → `deploy` | PR, manual | ไม่ (เฉพาะ manual `deploy`) | `testnet-deploy` |
| | | `timelock` → `execute` | manual | ไม่ | `testnet-deploy` |
| | | `neuro-fl` → `deploy` (FederatedRounds ปิดไว้ก่อน เป็นของ timelock; เฉพาะ `mode: deploy`) | sched, PR, manual | ไม่ (เฉพาะ `deploy` ที่สั่งเอง; งาน `aggregate` รายสัปดาห์และ `propose` ไม่ใช้ secret ที่เก็บไว้) | `testnet-deploy` |
| | | `rewards` → `award` | PR, sched, manual | ไม่ (ตาม schedule รายวัน และ manual `award`) | `testnet-automation` |
| | | `hyperlane-relayer` → `relay` (signer สำรอง) | sched, manual | ไม่ | `testnet-automation` |
| `ZETAPHY_RELAYER_KEY` (ใหม่ ไม่บังคับ) | key เฉพาะของ relayer ถ้าตั้งไว้จะใช้แทน deployer key | `hyperlane-relayer` → `relay` | sched, manual | ไม่ | `testnet-automation` |
| `ZETAPHY_VALIDATOR_KEY` | key ของ Hyperlane validator ของเรา (เซ็น checkpoint ของ ZETAPHY) | `hyperlane-relayer` → `relay` | sched, manual | ไม่ | `testnet-automation` |
| | | `saphan-route` → `validator-address` (แสดงแค่ address) | PR, manual | ไม่ (manual `check` / `deploy`) | `testnet-automation` |
| `BRIDGE_MARKER_KEY` | private key ของ *marker* ของ airlock (ทำเครื่องหมายผู้เรียก ไม่ย้ายเงิน) | `bridge-monitor` → `monitor` | manual (schedule ยัง comment ไว้ จะเปิดภายหลัง) | ไม่ | `monitoring` |
| `BRIDGE_WATCHLIST`, `BRIDGE_MONITOR_THRESHOLDS` | ค่าตั้งของ monitor ที่เป็นความลับ | `bridge-monitor` → `monitor` | manual (จะมี sched) | ไม่ | `monitoring` |
| `PRIVATE_ALERTS_TOKEN` | fine-grained PAT สิทธิ์ Issues บน repo แจ้งเตือนส่วนตัว | `bridge-monitor` → `monitor` | manual (จะมี sched) | ไม่ | `monitoring` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` | ช่องทางแจ้งเตือน | `bridge-monitor` → `monitor` | manual (จะมี sched) | ไม่ | `monitoring` |
| `ETHERSCAN_API_KEY` | API key ของ explorer (ใช้ verify source) | `zetaphy-verify` → `verify` | sched, push ไป main, manual | ไม่ | `explorer-verify` |
| `DEVNET_DEPLOYER_KEYPAIR`, `PROGRAM_KEYPAIR` | keypair ของ deployer และของ program บน Solana **devnet** | `CI` (security.yml) → `deploy-devnet` | push, PR, sched, manual | ไม่ (เฉพาะ manual ที่ติ๊ก `deploy_devnet`) | `devnet` (มีอยู่แล้ว) |
| `MAINNET_RPC_URL` | URL ของ Solana RPC (อาจมี API key ของผู้ให้บริการอยู่ใน URL) อ่านอย่างเดียว ไม่เซ็นอะไร | `CI` (security.yml) → `program` | push, PR, sched, manual | **ใช่** | ไม่มี ยังเป็น repository secret (ดูด้านล่าง) |
| `GITHUB_TOKEN` (มีในตัว) | token ประจำแต่ละ run | หลายตัว | | | ไม่ใช่ secret ที่เก็บไว้ ถูกจำกัดสิทธิ์ด้วย `permissions:` |

**ทำไม `MAINNET_RPC_URL` ยังเป็น repository secret** job `program` รัน Anchor test ทุก pull request
ถ้าใส่ใน environment ที่จำกัด branch จะทำให้ PR branch รันไม่ได้ และถ้ามี reviewer ก็ต้องกดอนุมัติทุก PR
ค่านี้ไม่เซ็นอะไรและไม่ย้ายเงิน แย่ที่สุดคือมีคนใช้โควตา RPC ของเรา และ GitHub ไม่ส่งค่านี้ให้ PR จาก fork อยู่แล้ว
ให้ใช้เป็น key มูลค่าต่ำ: แพ็กเกจฟรีหรือจำกัด rate, จำกัด origin ถ้าผู้ให้บริการรองรับ และเปลี่ยนใหม่ถ้าสงสัย

`NPM_TOKEN` (docs/LAUNCH.th.md) ตอนนี้ไม่มี workflow ไหนใช้ ถ้าเพิ่ม workflow สำหรับ publish ภายหลัง ให้ใช้ environment `release`

## 2. Environment ที่ใช้

| Environment | Secrets | Deployment branches | Required reviewers | เหตุผล |
|---|---|---|---|---|
| `testnet-deploy` | `ZETAPHY_DEPLOYER_KEY` | `main` เท่านั้น | **เจ้าของ** | deploy ด้วยมือ และ timelock execute: ต้องมีคนอนุมัติทุกครั้ง |
| `testnet-automation` | `ZETAPHY_VALIDATOR_KEY`, `ZETAPHY_DEPLOYER_KEY` (minter ของ BZTPHY และ signer สำรองของ relayer), `ZETAPHY_RELAYER_KEY` (ไม่บังคับ) | `main` เท่านั้น | **ไม่มี** | รันตาม schedule (relayer ทุก 15 นาที, award รายวัน) ถ้ามี reviewer ทุก run จะค้างรออนุมัติ |
| `monitoring` | `BRIDGE_*`, `TELEGRAM_*`, `DISCORD_WEBHOOK_URL`, `PRIVATE_ALERTS_TOKEN` | `main` เท่านั้น | **ไม่มี** | จะรันตาม schedule |
| `explorer-verify` | `ETHERSCAN_API_KEY` | `main` เท่านั้น | **ไม่มี** | schedule รายวัน |
| `devnet` | `DEVNET_DEPLOYER_KEYPAIR`, `PROGRAM_KEYPAIR` | `main` เท่านั้น | **เจ้าของ** | deploy Solana devnet ด้วยมือ |
| `release` | ไม่มี (ใช้คุมการ publish ด้วย `GITHUB_TOKEN` ของ job release ใน `release-zetaphyd` และ `oracle-stack`) | `main` เท่านั้น | เจ้าของ แนะนำ (ไม่บังคับ) | ให้คนอนุมัติทุก release ที่เผยแพร่ ถ้าไม่อยากให้การ publish อัตโนมัติเมื่อ push ไป main ต้องรอ ก็ไม่ต้องใส่ reviewer |

**Schedule กับ reviewer** required reviewer จะหยุด job ไว้จนมีคนกด *Approve* ส่วน run ตาม schedule จะค้างรอ (และหมดอายุใน 30 วัน)
ดังนั้น environment ที่ใช้กับ schedule (`testnet-automation`, `monitoring`, `explorer-verify`) จึงใช้ **แค่กฎ branch**
สิ่งที่ปกป้องคือ มีแต่โค้ดที่อยู่บน `main` เท่านั้นที่อ่านได้ ดังนั้นต้องป้องกัน `main` ไว้ (ต้องผ่าน pull request และรีวิวก่อน merge,
ห้าม force push) ไม่อย่างนั้นกฎ branch ก็ไม่ได้ป้องกันอะไรเลย

**Deployer key อยู่ในสอง environment** (`testnet-deploy` ที่มี reviewer และ `testnet-automation` ที่ไม่มี)
เพราะตอนนี้ยังเป็น minter ของ BZTPHY (award รายวัน) และเป็น signer ของ relayer จนกว่าจะแยกออก
สิ่งที่ปกป้อง key จริง ๆ คือ branch protection ของ `main` วิธีเอาออกจาก `testnet-automation`:
1. สร้าง key ใหม่ให้ relayer เติม testnet ETH เล็กน้อยบนทุก source chain แล้วเพิ่มเป็น `ZETAPHY_RELAYER_KEY`
   ใน `testnet-automation` (relayer เลือกใช้ key นี้ก่อนอยู่แล้ว)
2. ผ่าน timelock: ให้สิทธิ์ minter ของ BZTPHY กับ key ใหม่สำหรับ award, ถอนสิทธิ์จาก deployer
   แล้วเปลี่ยน `DEPLOYER` ใน job `award` ของ `rewards.yml` เป็น address ใหม่ (หรือเพิ่ม secret แยกสำหรับมัน)
3. จากนั้นลบ `ZETAPHY_DEPLOYER_KEY` ออกจาก `testnet-automation`: key จะอยู่หลัง reviewer เท่านั้น

## 3. ขั้นตอนที่เจ้าของต้องกด (GitHub → repo `swd-amm`)

ทำครั้งเดียว ใช้เวลาประมาณ 10 นาที เปิดไว้สองแท็บ: **Settings → Environments** และ
**Settings → Secrets and variables → Actions**

### 3.1 ป้องกัน `main` ก่อน

**Settings → Branches** (หรือ **Rules → Rulesets**) → สร้างกฎสำหรับ `main`: *Require a pull request before merging*,
*Block force pushes*, *Restrict deletions* ถ้าไม่ทำ "main เท่านั้น" ก็มีความหมายแค่ "ใครก็ได้ที่ push ไป main ได้"

### 3.2 สร้างแต่ละ environment

ทำกับ `testnet-deploy`, `testnet-automation`, `monitoring`, `explorer-verify`, `devnet` (อาจมีอยู่แล้ว ให้เปิดเข้าไป), `release`:

1. **Settings → Environments → New environment** → ตั้งชื่อให้ตรงตามตาราง (ตัวพิมพ์เล็ก มีขีด) → **Configure environment**
2. **Deployment protection rules**:
   - `testnet-deploy`, `devnet` (และ `release` ถ้าต้องการอนุมัติทุก release): ติ๊ก **Required reviewers** → เพิ่มตัวคุณ (เจ้าของ)
     → ปล่อย *Prevent self-review* **ปิด** ไว้ (คุณเป็น reviewer คนเดียวและเป็นคนกดรันเอง) → **Save protection rules**
   - `testnet-automation`, `monitoring`, `explorer-verify`: **ไม่ติ๊ก Required reviewers** และ *Wait timer* เป็น 0
   - ถ้ามีตัวเลือก **Allow administrators to bypass configured protection rules** ให้เอาติ๊กออก
3. **Deployment branches and tags** → เปลี่ยนจาก *No restriction* เป็น **Selected branches and tags** →
   **Add deployment branch or tag rule** → Ref type *Branch*, Name pattern `main` → **Add rule**
4. ไม่ต้องเพิ่ม *Environment variables*

### 3.3 ย้าย secret แต่ละตัวเข้า environment แล้วลบตัวที่อยู่ระดับ repository

GitHub ไม่แสดงค่า secret ซ้ำอีก ดังนั้น "ย้าย" คือ เพิ่มค่าเข้า environment จากสำเนาที่คุณมี (password manager,
MetaMask "Show private key", หน้า dashboard ของผู้ให้บริการ) แล้วลบตัวที่อยู่ระดับ repository

ทำตามแต่ละแถวในตารางหัวข้อ 2:

1. **Settings → Environments → `<environment>` → Environment secrets → Add environment secret** →
   ตั้งชื่อตรงตามตาราง (เช่น `ZETAPHY_DEPLOYER_KEY`) → วางค่า → **Add secret** แล้วล้างคลิปบอร์ด
   - `ZETAPHY_DEPLOYER_KEY`: เพิ่มใน **ทั้ง** `testnet-deploy` และ `testnet-automation` (เหตุผลและวิธีเลิกใช้สำเนาที่สองอยู่ในหัวข้อ 2)
   - ถ้าไม่มีค่าเดิมแล้ว (เช่น token ที่ไม่ได้เก็บไว้) ให้สร้างใหม่ที่ต้นทาง (Telegram bot token ใหม่ด้วย @BotFather `/revoke`,
     fine-grained PAT ใหม่, Etherscan key ใหม่) แล้ว revoke ตัวเก่า
2. เมื่อ secret ทุกตัวอยู่ใน environment แล้ว: **Settings → Secrets and variables → Actions → Repository secrets** →
   ลบตัวต่อไปนี้ด้วยไอคอน 🗑:
   `ZETAPHY_DEPLOYER_KEY`, `ZETAPHY_VALIDATOR_KEY`, `BRIDGE_MARKER_KEY`, `BRIDGE_WATCHLIST`,
   `BRIDGE_MONITOR_THRESHOLDS`, `PRIVATE_ALERTS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `DISCORD_WEBHOOK_URL`, `ETHERSCAN_API_KEY`, `DEVNET_DEPLOYER_KEYPAIR`, `PROGRAM_KEYPAIR`
   **เก็บ** `MAINNET_RPC_URL` ไว้ (หัวข้อ 1) และดู **Organization secrets** ในหน้าเดียวกันด้วย: ไม่ควรมี key สำหรับเซ็นธุรกรรม
3. repository secret คือสิ่งที่ branch ที่ไม่หวังดีอ่านได้ หลังขั้นที่ 2 ควรเหลือแค่ `MAINNET_RPC_URL`

### 3.4 ตั้งค่า Actions สำหรับ pull request

**Settings → Actions → General**:
- *Fork pull request workflows from outside collaborators*: **Require approval for all external contributors**
  (อย่างน้อย *first-time contributors*)
- ถ้า repo เป็น private: *Fork pull request workflows in private repositories*: ปล่อย **Send secrets and variables to workflows
  from fork pull requests** และ **Send write tokens to workflows from fork pull requests** ให้ **ปิด**
- *Workflow permissions*: **Read repository contents and packages permissions** (workflow ขอสิทธิ์ write เองเฉพาะที่จำเป็น)
  ส่วน *Allow GitHub Actions to create and approve pull requests* ตั้งตามที่ใช้อยู่ (`launch-testnet` / `hyperlane-core` เปิด PR เอง
  ถ้าปิดไว้ก็จะพิมพ์ลิงก์ให้เปิดเอง)

### 3.5 ตรวจว่าใช้งานได้

- Actions → **saphan-route** → Run workflow บน `main`, `mode = check`: job `route` รันทันที ส่วน job `validator-address`
  อ่าน `ZETAPHY_VALIDATOR_KEY` จาก `testnet-automation` แล้วแสดง address
- Actions → **hyperlane-relayer** → Run workflow บน `main`: เริ่มรันโดยไม่ต้องรออนุมัติ
- Actions → **timelock** → `action = status`: รันทันที (ไม่ใช้ key) ส่วน `action = execute`: จะขึ้น
  *Waiting for review: testnet-deploy* → **Review deployments** → ติ๊ก `testnet-deploy` → **Approve and deploy**
- ลองรันบน branch อื่นที่ไม่ใช่ `main`: job ที่ใช้ environment จะล้มด้วยข้อความว่า branch นี้ไม่ได้รับอนุญาต ซึ่งเป็นสิ่งที่ต้องการ

## 4. สิ่งที่เปลี่ยนใน workflow

- **แยก job** เพื่อให้ pull request, `check` และ `dry_run` ไม่แตะ key หรือ environment เลย และ CI บน PR ทำงานต่อได้โดยไม่ต้องอนุมัติ
  (รวม PR จาก fork ซึ่งไม่ได้ secret อยู่แล้ว): `bridge-testnet` (`bridge` | `deploy`), `rewards` (`dry-run` | `deploy` | `award`),
  `saphan-route` (`route` | `validator-address` | `deploy`), `hyperlane-core` (`dry-run` | `deploy`),
  `timelock` (`timelock` สำหรับ status/schedule/cancel | `execute`)
- เพิ่ม `environment:` เฉพาะ job ที่อ่าน key (หัวข้อ 1) ทุก job มีเงื่อนไขเป็น `workflow_dispatch` หรือ `schedule` ไม่เคยเป็น `pull_request`
- `launch-testnet`: dry run ก็อ่าน key ด้วย (ตรวจ address และยอดเงินของ deployer) ทั้ง job จึงอยู่หลัง `testnet-deploy`: dry run ก็ต้องกดอนุมัติ
- **สิทธิ์น้อยที่สุด**: `permissions:` ระดับบนสุดของทุก workflow เป็น `contents: read` ส่วน `contents: write` / `pull-requests: write`
  ให้เฉพาะ job ที่ push branch หรือเปิด PR (job deploy และ job release)
- `actions/checkout` ใส่ `persist-credentials: false` ทุกที่ ยกเว้น job ที่ `git push` หรือ `git fetch` ภายหลัง
  (job deploy ของ `bridge-testnet`, `rewards`, `saphan-route`, `hyperlane-core`, `launch-testnet` และทั้งสอง job ของ `timelock`)
- `hyperlane-relayer` เซ็นด้วย `ZETAPHY_RELAYER_KEY` ถ้าตั้งไว้ ไม่อย่างนั้นใช้ `ZETAPHY_DEPLOYER_KEY`
- action ของบุคคลที่สามถูก pin ด้วย commit SHA อยู่แล้ว (`foundry-rs/foundry-toolchain`, `hashicorp/setup-terraform`,
  `dtolnay/rust-toolchain`, `Swatinem/rust-cache`, `taiki-e/install-action`, `actions/attest-build-provenance`)
  ส่วน `actions/*` ของ GitHub เองใช้ tag ระดับ major การ pin ด้วย SHA ด้วย (เช่นใช้ Dependabot สำหรับ `github-actions`) เป็นขั้นต่อไปที่สมเหตุสมผล

## 5. รูปแบบอันตรายที่ตรวจแล้ว

- `pull_request_target`: **ไม่ได้ใช้** (มันรันพร้อม secret และ write token ใน context ของ repo หลัก ถ้าใช้คู่กับการ checkout โค้ดของ PR
  จะทำให้ fork ใดก็ได้รันโค้ดพร้อม key ของคุณ อย่าเพิ่มเข้ามา)
- `workflow_run`: **ไม่ได้ใช้**
- Secret ใน job ที่ PR trigger ได้: ก่อนการเปลี่ยนนี้ step ที่อ่าน key อยู่ใน job เดียวกับ dry run ของ PR กันไว้แค่ด้วย `if:` ระดับ step
  ที่เช็ก `workflow_dispatch` PR จาก branch ใน repo เดียวกันแก้ `if:` นั้นได้และจะได้ repository secret ไป
  ตอนนี้ key เป็น environment secret และ environment อนุญาตแค่ `main` ดังนั้น PR branch แม้จะแก้ workflow เองก็อ่าน key ไม่ได้
- PR จาก branch ใน repo เดียวกันยังได้ `MAINNET_RPC_URL` (อ่านอย่างเดียว มูลค่าต่ำ หัวข้อ 1)
- key ถูกเขียนลง `$RUNNER_TEMP` ด้วย `umask 077`, ถูก mask (`::add-mask::`), ตรวจกับ address ที่คาดไว้ก่อนใช้
  และลบใน step `if: always()` เหมือนเดิม

## 6. Mainnet

- ห้ามมี key ของ mainnet ใน GitHub: ไม่ว่าจะเป็น repository secret, environment หรือ self-hosted runner
- contract บน mainnet ต้อง deploy และบริหารผ่าน **Safe multisig** ที่เจ้าของแต่ละคนเป็น **hardware wallet**
  (Ledger/Trezor/Keystone) และมี timelock คั่นหน้าฟังก์ชัน admin หน้าที่ของ CI คือ build และตรวจสิ่งที่จะเซ็น:
  artifact ที่ compile แล้ว, address ที่คำนวณได้ล่วงหน้า, calldata, batch ของ Safe Transaction Builder, gov proposal
- Solana mainnet: upgrade authority ของ program เป็น Squads multisig ของ hardware wallet และ CI ไม่ถือไว้เด็ดขาด
- ห้ามใช้ key ของ testnet บน mainnet และห้ามใช้ key ของ mainnet บน testnet
