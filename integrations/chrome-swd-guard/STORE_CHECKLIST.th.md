# เช็กลิสต์ส่ง SWD Guard ขึ้น Chrome Web Store

ใช้เวลาประมาณ 1–2 ชั่วโมงสำหรับการกรอกครั้งแรก การตรวจของ Google ปกติใช้ 1–3 วัน (บางครั้งนานถึง 2–3 สัปดาห์)

## ก่อนเริ่ม (ครั้งเดียว)

- [ ] มีบัญชี Google ที่จะใช้เป็นเจ้าของถาวร (แนะนำบัญชีขององค์กร ไม่ใช่บัญชีส่วนตัวของพนักงาน)
- [ ] เปิดการยืนยันตัวตน 2 ขั้น (2-Step Verification) ในบัญชี Google นั้น — Store บังคับ
- [ ] สมัครที่ https://chrome.google.com/webstore/devconsole และจ่ายค่าธรรมเนียม **US$5** (ครั้งเดียว)
- [ ] กรอกข้อมูลผู้เผยแพร่ (Publisher name เช่น "SAWASDEE COIN (SWD)") และยืนยันอีเมลติดต่อ
- [ ] (ถ้าต้องการให้ขึ้นชื่อเว็บ) ยืนยันโดเมน sawasdeecoin.com ใน Google Search Console เพื่อแสดงเป็นเว็บทางการ

## เตรียมไฟล์ (ให้นักพัฒนาทำ)

- [ ] ตรวจรายชื่อเว็บหลอกใน `data/phishing-domains.json` ให้ทีมยืนยันแล้ว
- [ ] แก้ `version` ใน `manifest.json` ถ้าเคยอัปโหลดแล้ว (ต้องสูงกว่าเดิมทุกครั้ง)
- [ ] รัน `npm test` ผ่าน
- [ ] รัน `sh scripts/zip.sh` ได้ไฟล์ `dist/swd-guard-<version>.zip`
- [ ] ทดลอง Load unpacked ใน Chrome ของจริงหนึ่งรอบ (ดูขั้นตอนใน README.th.md)
- [ ] เว็บ swd-zetaphy.sawasdeecoin.com ต้อง **ออนไลน์** ตอนส่งตรวจ (ผู้ตรวจของ Google จะลองใช้จริง)

## หน้า Store listing

- [ ] ชื่อ: SWD Guard (มาจาก `_locales` อัตโนมัติ)
- [ ] คำอธิบายสั้น: มาจาก `_locales` อัตโนมัติ (8 ภาษา)
- [ ] คำอธิบายยาว (ภาษาอังกฤษ + ไทย): อธิบาย 3 ฟีเจอร์ (ป้ายบนหน้าเหรียญ, ปุ่มตรวจ, เตือนเว็บหลอก) และย้ำว่า "ไม่ใช่คำแนะนำการลงทุน"
- [ ] หมวดหมู่ (Category): **Productivity** หรือ **Tools**
- [ ] ไอคอน 128×128: `icons/icon128.png`
- [ ] ภาพหน้าจออย่างน้อย 1 ภาพ ขนาด **1280×800** หรือ 640×400 (แนะนำ 3–5 ภาพ: ป้ายบน Solscan, ป๊อปอัปตรวจ, หน้าจอเตือนเว็บหลอก, หน้าตั้งค่า)
- [ ] (ไม่บังคับ) ภาพโปรโมตเล็ก 440×280
- [ ] ภาษา: เพิ่มคำอธิบายภาษาไทยด้วย

## แท็บ Privacy practices (สำคัญ — ถ้ากรอกไม่ครบจะถูกปฏิเสธ)

- [ ] **Single purpose**: "Warn users about risky crypto tokens and phishing sites by showing SWD Audit results."
- [ ] เหตุผลของแต่ละสิทธิ์ (คัดลอกได้):
  - `storage`: "Saves the user's settings, the optional phishing list and a short cache of audit results."
  - `activeTab`: "When the user clicks the icon, reads the current tab's address to check it against the phishing list and to audit the token on that page."
  - `scripting`: "Shows the phishing warning on domains from the updated list, only after the user grants the optional all-sites permission."
  - `alarms`: "Updates the optional phishing list once a day."
  - Host permission (swd-zetaphy.sawasdeecoin.com + เว็บ DEX/Explorer): "Calls the SWD Audit API and shows the audit badge on token pages of these sites."
- [ ] **Remote code**: เลือก **"No, I am not using remote code"**
- [ ] **Data usage**: ไม่ได้เก็บข้อมูลประเภทใดใน list (ไม่ติ๊กอะไร) และติ๊กยืนยันทั้ง 3 ข้อ (ไม่ขาย, ไม่ใช้นอกวัตถุประสงค์, ไม่ใช้ประเมินเครดิต)
- [ ] **Privacy policy URL**: นำเนื้อหา `PRIVACY.md` ไปวางบนเว็บ เช่น `https://swd-zetaphy.sawasdeecoin.com/privacy/swd-guard`
      (หรือใช้ลิงก์ GitHub ของไฟล์ `integrations/chrome-swd-guard/PRIVACY.md` ชั่วคราว)

## ส่งตรวจ

- [ ] Package → Upload new package → เลือกไฟล์ zip
- [ ] Distribution: Public, ทุกประเทศ
- [ ] กด **Submit for review**
- [ ] ถ้าถูกปฏิเสธ อีเมลจะบอกเหตุผล (ที่พบบ่อย: เหตุผลการขอสิทธิ์ไม่ชัด, ไม่มีนโยบายความเป็นส่วนตัว, เว็บ API ใช้งานไม่ได้ตอนตรวจ) แก้แล้วส่งใหม่ได้

## หลังได้รับอนุมัติ

- [ ] ใส่ลิงก์ Store บนเว็บ SWD และในโซเชียล
- [ ] ทุกครั้งที่ออกเวอร์ชันใหม่: เพิ่ม `version` → `npm test` → `sh scripts/zip.sh` → อัปโหลด
- [ ] ตอบรีวิวผู้ใช้ และรับแจ้งเว็บหลอกใหม่ (เพิ่มลงรายชื่อหลังตรวจสอบ)
