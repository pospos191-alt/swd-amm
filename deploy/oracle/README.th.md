# ZETAPHY บน Oracle Cloud (ฟรี)

กดปุ่มเดียว ได้เครื่อง Always Free 1 เครื่อง ติดตั้ง ZETAPHY ให้อัตโนมัติ ไม่ต้องพิมพ์คำสั่ง ไม่เสียเงิน

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/pospos191-alt/swd-amm/releases/download/oracle-stack/zetaphy-oracle-stack.zip)

## ทำแค่ 4 ขั้น

1. กดปุ่ม **Deploy to Oracle Cloud** ด้านบน แล้วล็อกอิน Oracle
2. ติ๊ก **I have reviewed and accept the Oracle Terms of Use** แล้วกด **Next**
3. เลือก **Machine size / ขนาดเครื่อง** (แนะนำ `VM.Standard.A1.Flex`) แล้วกด **Next**
4. ติ๊ก **Run apply** แล้วกด **Create**

รอประมาณ 5 นาที ระบบจะติดตั้งเสร็จเอง

## ดูที่อยู่ runner

- เปิดหน้า Stack > Job ล่าสุด > **Outputs** จะเห็น `public_ip`
- ไปที่ Compute > Instances > `zetaphy-node` > **Run command** > สร้างคำสั่ง `sudo zetaphy-runner address` แล้วดูผลลัพธ์

## ถ้าขึ้น "Out of host capacity"

แปลว่าตอนนี้ Oracle ไม่มีเครื่องฟรีว่าง **ไม่ได้มีอะไรเสีย และไม่เสียเงิน**
ให้กด **Apply** ใหม่อีกครั้งภายหลัง (เช่น อีกไม่กี่ชั่วโมง) หรือกด **Edit** แล้วเลือกขนาด `VM.Standard.E2.1.Micro` แทน

## ลบทิ้ง

หน้า Stack > กด **Destroy** > ยืนยัน ระบบจะลบเครื่องและเครือข่ายทั้งหมด (จากนั้นกด **Delete stack** ได้ถ้าต้องการ)

ทุกอย่างอยู่ในโควต้า Always Free จึงไม่มีค่าใช้จ่าย
