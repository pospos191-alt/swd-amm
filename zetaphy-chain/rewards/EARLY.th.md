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

สคริปต์: `node zetaphy-network/scripts/early.js deploy | airdrop --list <ไฟล์> [--each 10000] [--send]`
เทสต์: `zetaphy-network/test/early.test.js` (ตัวเหรียญ และ deploy + แจกครบวงจรด้วยธุรกรรมที่เซ็นจริง)
