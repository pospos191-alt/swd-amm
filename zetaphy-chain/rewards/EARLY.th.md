[English](EARLY.md) | **ภาษาไทย**

# ZETAPHY Early (ZEARLY): เหรียญชุมชนของแอร์ดรอป testnet

| | |
|---|---|
| ชื่อ / สัญลักษณ์ | ZETAPHY Early / **ZEARLY** ทศนิยม 18 หลัก |
| เชน | ZETAPHY testnet (chain ID 77390) เป็น ERC-20 (`zetaphy-network/contracts/ZetaphyEarly.sol`) |
| จำนวนรวม | **1,000,000,000** สร้างครั้งเดียวตอน deploy ให้กระเป๋าแจก |
| ใครสร้างเพิ่มได้ | ไม่มีใคร: ไม่มีเจ้าของ ไม่มี mint ไม่มีหยุดการโอน ไม่มีค่าธรรมเนียม |
| ที่อยู่ | `early-testnet.json` ในโฟลเดอร์นี้ หลัง deploy |
| รูปเหรียญ | `logo/zearly.svg`, `logo/zearly-512.png`, `-256`, `-64` (ตัว Z ขาว เส้นทแยงสีทอง จุดทอง บนเหรียญสีเข้ม) กระเป๋าแสดงรูปผ่านปุ่ม "เพิ่มในกระเป๋า" ของ hub และ `app.sawasdeecoin.com/tokenlist.json` |

ZEARLY แสดงว่าใครเข้าร่วม ZETAPHY รุ่นแรก ทุกคนถือ โอน และแลกใน ZETAPHY Swap ได้
**ไม่มีมูลค่า ไม่ใช่ ZETAPHY และไม่ถูกแลกเป็น ZETAPHY** (ต่างจาก BZTPHY ซึ่งเป็นแต้มรางวัลของ validator และ runner ดู README.th.md)
เป็นเหรียญทดสอบบนเครือข่ายทดสอบ ไม่มีส่วนใดเป็นคำแนะนำการลงทุน

## ZEARLY ทำอะไรได้ (มากกว่าเหรียญมีม และไม่มีหน้าเว็บของตัวเอง)

| | สัญญา | คนใช้อย่างไร |
|---|---|---|
| แลกเหรียญ | พูล ZEARLY/ZETAPHY บน ZETAPHY Swap | swap.sawasdeecoin.com มี ZEARLY ในรายการเหรียญ |
| Early Pass | `ZetaphyEarlyPass` (ZEPASS) | NFT ที่ซื้อด้วย 1,000 ZEARLY (ถูกเผา) หนึ่งใบต่อกระเป๋า 14 วันแรกเฉพาะผู้ถือ 10,000 ZEARLY ขึ้นไป รูปวาดบนเชน แสดงในตลาด NFT เหมือน ERC-721 ทั่วไป |
| ภารกิจ | `ZetaphyQuests` | จ่ายเองทุกวัน: แลกเหรียญครั้งแรก 1,000 ใส่สภาพคล่อง 5,000 มี Early Pass 2,000 stake ZETAPHY 2,000 แต่ละกระเป๋าครั้งเดียวต่อภารกิจ บันทึกบนเชน |
| ฟาร์ม | `ZetaphyEarlyFarm` | ฝาก LP ของพูล ได้ ZEARLY (50,000,000 ใน 90 วัน) ถอนได้ทุกเมื่อ |
| โหวต | `ZetaphyEarlyPolls` | โหวตความเห็นตามจำนวน ZEARLY ที่ล็อกไว้จนจบ (เปิดโหวตต้องวางมัดจำ 1,000 ZEARLY ได้คืน) |
| ข้ามเชน | เส้นทางเหรียญของ Saphan | ไป Sepolia, Base Sepolia, Arbitrum Sepolia เป็น zZEARLY (เพิ่มหลัง deploy และเปิดโดย timelock ทั้งสองฝั่ง) |

ทั้งหมดนี้ไม่เปลี่ยนตัวตนของ ZEARLY: จำนวนคงที่ ไม่มีใครเพิ่มได้ ไม่มีเจ้าของ ไม่มีมูลค่า
Early Pass ฟาร์ม และโหวต เป็นการเรียกสัญญา (approve แล้ว `mint` / `stake` / `vote`) ตอนนี้ต้องใช้เครื่องมือที่เรียกสัญญาได้
ส่วนภารกิจและการแลกเหรียญไม่ต้องทำอะไรพิเศษ

**ผู้ดูแล ทำตามลำดับ (Actions › `early-token`):** `deploy` › merge `rewards/early` › `pool` › merge › `extras` › merge
หลังจากนั้นภารกิจจ่ายเองทุกวัน (รัน `quests` เองเพื่อลองดูก่อนได้)

## คนจะได้อย่างไร

1. ส่ง `/claim <ที่อยู่ 0x… หรือ zetaphy1…>` ให้บอท Telegram **@awasdeebot** (หนึ่งบัญชี Telegram ต่อหนึ่งกระเป๋า
   ต้องเป็นสมาชิก @ZETAPHYOfficial) แต่ละกระเป๋าได้ **10,000 ZEARLY** และ ZETAPHY ทดสอบ 100
2. ดูใน MetaMask: เพิ่มเครือข่าย ZETAPHY (app.sawasdeecoin.com ปุ่ม "เพิ่มเครือข่าย") แล้ว **Import token** ด้วยที่อยู่ ZEARLY

10,000 คนใช้ 100,000,000 ZEARLY (10%) ที่เหลืออยู่ในกระเป๋าแจกสำหรับรอบต่อไป

## สำหรับผู้ดูแล

1. **Deploy (ครั้งเดียว):** Actions › `early-token` › mode `deploy` แล้ว merge branch `rewards/early` ที่ระบบ push มา
   (เพิ่ม `early-testnet.json`) กุญแจ deployer (`ZETAPHY_DEPLOYER_KEY`) ถือเหรียญทั้งหมด คือกระเป๋าแจก
2. **บอกบอท:** ใน Vercel โปรเจกต์ `swd-amm-zetaphy-neuro` ตั้ง `AIRDROP_EARLY` = `10000` และ `EARLY_TOKEN` = ที่อยู่เหรียญ
   แล้ว redeploy หลังจากนั้น `/claim` จะบอกเรื่อง ZEARLY และที่อยู่สำหรับ import
3. **แจกหนึ่งรอบ:**
   - ในบอทพิมพ์ `/export` (แอดมิน) ได้ `airdrop.txt`
   - บน GitHub อัปโหลดเป็น `zetaphy-chain/rewards/early-airdrop.txt` (Add file › Upload ผ่าน pull request)
   - Actions › `early-token` › mode `airdrop` ไม่ติ๊ก `send`: ลองรัน (กี่คน เท่าไร ยอดคงเหลือ)
   - รันซ้ำโดยติ๊ก `send` กระเป๋าที่ได้แล้วถูกข้าม (อ่านจากเชน) รอบถัดไปจ่ายเฉพาะคนใหม่
   - ZETAPHY ทดสอบ 100 ของรายชื่อเดียวกัน: `gov.sh airdrop airdrop.txt 100` บนโหนดแรก (README.th.md ของ zetaphy-chain
     หัวข้อ "แอร์ดรอปบน testnet")

**ผู้ใช้เชนของเราก่อน:** Actions › `early-token` › mode `collect` (`max` 1000) รวบรวมกระเป๋าที่เคยใช้ ZETAPHY แล้ว
(faucet ขุด โอน แลก stake; ตัดสัญญา บัญชีระบบ และกองทุนใหญ่ออก) แล้ว push `early-users.txt` ไป branch `rewards/early-users`
merge แล้วใช้ mode `airdrop` โดยตั้ง list = `zetaphy-chain/rewards/early-users.txt`

สคริปต์: `node zetaphy-network/scripts/early.js deploy | airdrop --list <ไฟล์> [--each 10000] [--send] | collect [--max 1000]`
เทสต์: `zetaphy-network/test/early.test.js` (ตัวเหรียญ และ deploy + แจกครบวงจรด้วยธุรกรรมที่เซ็นจริง)
