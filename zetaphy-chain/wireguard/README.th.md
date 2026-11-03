[English](README.md) | **ภาษาไทย**

# ลิงก์ validator ↔ sentry ด้วยกุญแจร่วมล่วงหน้าแบบทนควอนตัม (เลือกใช้ได้)

CometBFT เชื่อม peer ด้วย SecretConnection คือแลกกุญแจ X25519 และใช้กุญแจโหนด Ed25519 ทั้งสองอย่างแพ้คอมพิวเตอร์ควอนตัมขนาดใหญ่
และทราฟฟิกที่ถูกอัดเก็บไว้วันนี้อาจถูกถอดรหัสได้ในวันนั้น ("เก็บวันนี้ ถอดรหัสทีหลัง") บนเครือข่ายสาธารณะทราฟฟิกส่วนใหญ่คือบล็อกที่เปิดเผยอยู่แล้ว
แต่ลิงก์จาก validator ไป sentry ยังบอกได้ว่า validator เซ็นอะไรเมื่อไร และเห็นธุรกรรมไหนก่อน ตอนนี้ CometBFT ยังไม่มีการจับมือแบบทนควอนตัม

`pq-link.sh` ย้ายลิงก์ validator ↔ sentry ไปไว้ใน **WireGuard ที่มีกุญแจร่วมล่วงหน้า (PSK)** WireGuard ผสม PSK ขนาด 32 ไบต์เข้าไปในการจับมือ จึงได้ว่า

- ทราฟฟิกในอุโมงค์ที่ถูกอัดเก็บไว้ยังเป็นความลับ แม้ผู้โจมตีจะเจาะ X25519 ได้ในภายหลัง ตราบใดที่ PSK ยังเป็นความลับ
- ไม่มีใครปลอมเป็น validator หรือ sentry บนอุโมงค์ได้โดยไม่มี PSK

PSK เป็นค่าสุ่ม (`wg genpsk` 256 บิต) และถูกคัดลอกไปอีกเครื่อง **ผ่าน SSH ที่บังคับให้แลกกุญแจแบบไฮบริดทนควอนตัมเท่านั้น**
(`mlkem768x25519-sha256` ตั้งแต่ OpenSSH 9.9 หรือ `sntrup761x25519-sha512` ตั้งแต่ OpenSSH 8.5 ซึ่ง Ubuntu 24.04 มี)
ถ้าสองเครื่องตกลงกันด้วยวิธีเหล่านี้ไม่ได้ จะไม่มีอะไรถูกส่งออกไป SecretConnection ของ CometBFT ยังทำงานข้างในอุโมงค์เหมือนเดิม

**สิ่งที่ยังไม่ได้**

- ไม่มี forward secrecy ถ้าผู้โจมตีที่มีควอนตัมขโมย PSK ได้ภายหลัง (จากดิสก์ของเครื่อง) ให้หมุน PSK เป็นระยะ (ด้านล่าง)
  หรือใช้ [Rosenpass](https://rosenpass.eu) ซึ่งใส่ PSK ทนควอนตัมอันใหม่ให้ WireGuard ตัวเดิมทุกสองนาที
- ลิงก์ของ sentry ไปยังเครือข่ายสาธารณะยังเป็น SecretConnection ธรรมดา
- กุญแจโฮสต์ SSH ที่ยืนยันตัวตนตอนส่ง PSK ยังเป็นแบบเดิม ให้ส่ง PSK ก่อน Q-day จากเครื่องที่ไว้ใจ ไปยังกุญแจโฮสต์ที่ตรวจแล้ว
- ปิดไว้เป็นค่าเริ่มต้น โหนดที่ไม่ได้รันสคริปต์นี้จะไม่มีอะไรเปลี่ยน

## ขั้นตอน

ตัวอย่าง: validator `10.77.0.1`, sentry `10.77.0.2` เปิด UDP 51820 **เฉพาะ** ระหว่างสองเครื่องนี้ ทำในฐานะ root:

```bash
apt-get install -y wireguard-tools
S=zetaphy-chain/wireguard/pq-link.sh

# ทั้งสองเครื่อง
$S init 10.77.0.1/24          # บน validator (แสดงกุญแจสาธารณะของเครื่อง)
$S init 10.77.0.2/24          # บน sentry

# บน validator: สร้าง PSK ของลิงก์ แล้วส่งให้ sentry ผ่าน SSH แบบทนควอนตัม
$S psk sentry-1
$S send-psk sentry-1 root@<ที่อยู่ sentry> validator-0
$S peer sentry-1 <กุญแจสาธารณะของ sentry> 10.77.0.2 <ที่อยู่ sentry>:51820
$S up

# บน sentry (PSK มาถึงเป็นไฟล์ zetaphy-pq-validator-0.psk)
$S peer validator-0 <กุญแจสาธารณะของ validator> 10.77.0.1
$S up
$S status                      # ดู "latest handshake" และ "preshared key: (hidden)"

# ให้ CometBFT วิ่งผ่านอุโมงค์ (สำรอง config.toml ก่อน) แล้วรีสตาร์ต zetaphyd ทั้งสองเครื่อง
$S comet-validator <node id ของ sentry>@10.77.0.2   # บน validator: คุยกับ peer นี้เท่านั้น ไม่มี PEX ไม่มี seed
$S comet-sentry <node id ของ validator>             # บน sentry: ซ่อน validator และต่อไว้ตลอด
```

node id ดูได้ด้วย `zetaphyd comet show-node-id --home /home/zetaphy/.zetaphy` หลังรีสตาร์ตแล้วให้ปิดพอร์ต 26656 ของ validator
ยกเว้นจากอุโมงค์ `send-psk` ใช้ `sudo` ที่อีกฝั่ง ให้ใช้ `root@` หรือบัญชีที่ sudo ได้โดยไม่ต้องใส่รหัสผ่าน
ถ้ามีหลาย sentry ให้ทำ `psk` / `send-psk` / `peer` ซ้ำด้วยชื่อและที่อยู่ในอุโมงค์อื่น

**หมุน PSK:** บน validator `psk sentry-1`, `send-psk sentry-1 root@<sentry> validator-0`, `peer sentry-1 …` (อาร์กิวเมนต์เดิม), `up`
บน sentry `peer validator-0 …`, `up` คำสั่ง `up` โหลดอุโมงค์ที่รันอยู่ใหม่ (`wg syncconf`) โดยไม่ตัดการเชื่อมต่อ ระหว่างที่สองฝั่งยังมีกุญแจไม่ตรงกัน
การจับมือจะล้มเหลวและ CometBFT จะต่อใหม่เอง

ตั้งค่าได้: `WG_DIR` (ค่าเริ่มต้น `/etc/wireguard`), `IFACE` (`zetaphy-pq`), `NODE_HOME` (`/home/zetaphy/.zetaphy`)
ทดสอบ: `zetaphy-network/test/pqlink.test.js` แถวในบัญชีรายการ: `p2p-transport` ใน
[`docs/future/quantum-safe-settlement.th.md`](../../docs/future/quantum-safe-settlement.th.md)
