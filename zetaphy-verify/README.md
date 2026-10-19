# zetaphy-verify: Verify สัญญา ZETAPHY อัตโนมัติทุกเชน

ทุก 3 ชั่วโมง GitHub Actions จะทำสิ่งเหล่านี้ให้เอง:

1. อ่านเหตุการณ์ `TokenDeployed` ล่าสุดจาก factory ของ ZETAPHY บนทุกเชนที่ตั้งไว้
2. ส่งซอร์สโค้ดของ factory และของเหรียญใหม่ทุกเหรียญไป Verify บน explorer
3. ข้ามสัญญาที่ Verify แล้ว จึงรันซ้ำได้โดยไม่เกิดปัญหา

ระบบจะส่งซอร์สก็ต่อเมื่อโค้ดบนเชนตรงกับสัญญาใน `build-info/` เท่านั้น
โดยเทียบด้วยลายนิ้วมือโค้ดแบบเดียวกับที่ Neuro ใช้ จึงส่งซอร์สผิดตัวไม่ได้

## Explorer ที่รองรับ

| Explorer | ค่าใช้จ่าย | เงื่อนไข |
|---|---|---|
| Sourcify | ฟรี ทุกเชน | ไม่ต้องตั้งค่าอะไร |
| Etherscan family (bscscan, basescan, arbiscan, etherscan) | ใช้ key เดียวครอบคลุมทุกเชน | ต้องมี repository secret `ETHERSCAN_API_KEY` |

ข้อจำกัดของ Etherscan:
- แพ็กเกจฟรีของ Etherscan ไม่รองรับ BNB Chain และ Base (ข้อมูล ณ ตอนที่เขียน)
- เชนที่ไม่รองรับจะขึ้นสถานะ `plan-required` และไม่ทำให้การรันล้มเหลว
- ถ้าต้องการให้ BscScan แสดง ✅ ต้องใช้แพ็กเกจที่ครอบคลุม BNB Chain

## ตั้งค่าครั้งแรก

1. คัดลอกไฟล์ build-info ของโปรเจกต์ launcher มาไว้ใน `zetaphy-verify/build-info/`
   - Hardhat: `artifacts/build-info/*.json` (Hardhat 3 ต้องคัดลอกไฟล์ `*.output.json` ที่อยู่คู่กันมาด้วย)
   - Foundry: `out/build-info/*.json`
2. (ไม่บังคับ) เพิ่ม `ETHERSCAN_API_KEY` ที่ GitHub → Settings → Secrets and variables → Actions
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
```

## ทดสอบ

```
cd zetaphy-verify && npm ci && npm test
```

ชุดทดสอบคอมไพล์ launcher ตัวอย่าง (factory + token) ด้วย solc
แล้วจำลองเชน, Sourcify และ Etherscan เพื่อตรวจว่าระบบส่งซอร์สถูกตัว
และส่งค่า constructor arguments ถูกต้อง
