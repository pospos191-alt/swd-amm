[English](README.md) | **ภาษาไทย**

# zetaphy-verify: Verify สัญญา ZETAPHY อัตโนมัติทุกเชน

ทุก 6 ชั่วโมง GitHub Actions จะทำสิ่งเหล่านี้ให้เอง:

1. อ่านเหตุการณ์ `TokenDeployed` ล่าสุดจาก factory ของ ZETAPHY บนทุกเชนที่ตั้งไว้
2. ส่งซอร์สโค้ดของ factory และของเหรียญใหม่ทุกเหรียญไป Verify บน explorer
3. ข้ามสัญญาที่ Verify แล้ว จึงรันซ้ำได้โดยไม่เกิดปัญหา

ระบบจะส่งซอร์สก็ต่อเมื่อโค้ดบนเชนตรงกับสัญญาใน `build-info/` เท่านั้น
โดยเทียบด้วยลายนิ้วมือโค้ดแบบเดียวกับที่ Neuro ใช้ จึงส่งซอร์สผิดตัวไม่ได้

## ใช้ฟรีทั้งหมด

| ที่ | ทำอย่างไร | ค่าใช้จ่าย |
|---|---|---|
| Sourcify (ทุกเชน) | อัตโนมัติ ไม่ต้องตั้งค่า | ฟรี |
| Etherscan, Arbiscan | อัตโนมัติ เมื่อใส่ API key ฟรีของ etherscan.io | ฟรี |
| BscScan, BaseScan | กรอกฟอร์มบนเว็บเองครั้งเดียว (ดูหัวข้อด้านล่าง) | ฟรี |
| GitHub Actions | รันทุก 6 ชั่วโมง ใช้ราว 120 จาก 2,000 นาทีฟรีต่อเดือน | ฟรี |

API ของ Etherscan แบบฟรีไม่รองรับ BNB Chain และ Base ระบบจึงขึ้นสถานะ `plan-required`
สำหรับสองเชนนี้ ซึ่งไม่ถือว่ารันล้มเหลว ไม่ต้องซื้อแพ็กเกจ เพราะฟอร์มบนเว็บ BscScan ใช้ฟรี

## BscScan / BaseScan แบบฟรี (ฟอร์มบนเว็บ)

1. สร้างไฟล์สำหรับฟอร์ม:
   `node zetaphy-verify/cli.js export ZETAPHYModularToken`
   - คำสั่งนี้เขียนไฟล์ `zetaphy-verify/out/ZETAPHYModularToken.standard-input.json`
   - และพิมพ์ค่าที่ต้องเลือกในฟอร์มออกมาให้
2. เปิดหน้าสัญญาบน BscScan → แท็บ Contract → **Verify and Publish**
3. เลือกค่าตามที่คำสั่งพิมพ์ไว้ แล้วอัปโหลดไฟล์ `.json`
4. ทำแบบเดียวกันกับ factory
5. เหรียญอื่นที่มีโค้ดเหมือนกันมักจะขึ้น "Similar Match" ให้เอง ถ้าเหรียญไหนยังไม่ขึ้น ก็ทำซ้ำกับเหรียญนั้น

## ตั้งค่าครั้งแรก

1. คัดลอกไฟล์ build-info ของโปรเจกต์ launcher มาไว้ใน `zetaphy-verify/build-info/`
   - Hardhat: `artifacts/build-info/*.json` (Hardhat 3 ต้องคัดลอกไฟล์ `*.output.json` ที่อยู่คู่กันมาด้วย)
   - Foundry: `out/build-info/*.json`
2. (ไม่บังคับ) สมัคร API key ฟรีที่ etherscan.io แล้วเพิ่มเป็น `ETHERSCAN_API_KEY` ที่ GitHub → Settings → Secrets and variables → Actions
   - ห้ามวาง key ลงในโค้ดหรือในแชต
3. ถ้า launcher อยู่บนเชนอื่นด้วย ให้เพิ่มที่อยู่ factory ใน `src/config.js` ใต้เชนนั้น
   - ระบบลองที่อยู่ factory เดียวกันบนทุกเชนให้อยู่แล้ว แต่จะใช้ก็ต่อเมื่อโค้ดตรงกับ build-info

เมื่อ push ไฟล์ใน `build-info/` เข้า `main` ระบบจะรันทันที

## Verify เหรียญเก่าย้อนหลัง หรือ Verify ทีละที่อยู่

ไปที่ Actions → **ZETAPHY verify** → Run workflow:

- **ย้อนหลัง:** ใส่ `from_block` เป็นบล็อกที่สร้าง factory
- **ทีละที่อยู่:** เลือกเชน แล้วใส่ `address`

## รันเองบนเครื่อง (ไม่จำเป็น)

```
node zetaphy-verify/cli.js watch [--chain bsc] [--from-block N] [--to-block N]
node zetaphy-verify/cli.js verify bsc 0x... [--tx 0x...]
node zetaphy-verify/cli.js export ZETAPHYModularToken
```

## ทดสอบ

```
cd zetaphy-verify && npm ci && npm test
```

ชุดทดสอบคอมไพล์ launcher ตัวอย่าง (factory + token) ด้วย solc
แล้วจำลองเชน, Sourcify และ Etherscan เพื่อตรวจว่าระบบส่งซอร์สถูกตัว
และส่งค่า constructor arguments ถูกต้อง
