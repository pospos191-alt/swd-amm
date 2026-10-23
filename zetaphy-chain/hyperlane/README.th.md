# Hyperlane บน ZETAPHY: ติดตั้ง agent บนเครื่อง Oracle

เครื่อง Oracle จะรัน Hyperlane 2 ตัว:

| ตัว | ทำอะไร | ต้องมีเหรียญไหม |
|---|---|---|
| validator | เซ็นรับรองข้อความที่ออกจาก ZETAPHY ไป Sepolia | 1 ZETAPHY ครั้งเดียว (ใช้ประกาศตัวบนเชน) |
| relayer | ส่งข้อความข้ามระหว่าง ZETAPHY กับ Sepolia | Sepolia ETH (ฟรีจาก faucet) สำหรับขาไป Sepolia |

## ขั้นตอน (ทำใน Cloud Shell ของ Oracle)

1. เข้าเครื่อง: `ssh ubuntu@<Public IP>`
2. โหลดสคริปต์แล้วติดตั้ง:
   ```
   curl -fsSLO https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/zetaphy-chain/hyperlane/setup-agents.sh
   sudo bash setup-agents.sh
   ```
   สคริปต์จะสร้างกุญแจไว้ในเครื่องเอง (`/etc/hyperlane` อ่านได้แค่ root) แล้วแสดงเฉพาะที่อยู่ 2 อัน ไม่แสดงกุญแจ
3. ส่ง 1 ZETAPHY ไปที่อยู่ **validator** แล้วส่งที่อยู่นี้ให้ Najaso (ที่อยู่เปิดเผยได้) ฝั่ง Sepolia จะตั้งให้เชื่อ validator ตัวนี้
4. ตรวจสถานะ: `sudo bash setup-agents.sh status` ต้องเห็น `announced  yes`
5. relayer เริ่มทีหลัง หลังจากติดตั้งสะพานแล้ว Najaso จะให้คำสั่ง `start-relayer` พร้อมที่อยู่สัญญา

คำสั่งอื่น: `addresses`, `logs validator`, `logs relayer`, `stop`

ห้ามส่งไฟล์ใน `/etc/hyperlane` หรือกุญแจให้ใคร
