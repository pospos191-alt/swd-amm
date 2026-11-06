# เว็บ ZETAPHY บน Cloudflare Pages

English: [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md)

**ทำไม:** วันที่ 2026-11-06 Vercel หยุดทั้งทีม (ทุกเว็บ) เพราะใช้ CPU ของฟังก์ชันเกินโควตาฟรีของแผน Hobby (4 ชั่วโมงต่อ 30 วัน) และจะเปิดคืนวันที่ 2026-12-06
- เว็บ ZETAPHY ทั้ง 6 ตัวเป็นไฟล์ static ไม่ต้องใช้ฟังก์ชัน จึงย้ายไป Cloudflare Pages ได้
- แผนฟรีของ Cloudflare Pages ไม่นับโควตาคำขอไฟล์ static
- โดเมนอยู่ที่ Cloudflare อยู่แล้ว DNS จึงไม่ต้องย้าย

| เว็บ | โปรเจกต์บน Cloudflare Pages | โดเมน |
|---|---|---|
| Hub | `zetaphy-hub` | app.sawasdeecoin.com |
| Wallet | `zetaphy-wallet` | wallet.sawasdeecoin.com |
| Swap | `zetaphy-swap` | swap.sawasdeecoin.com |
| NFT | `zetaphy-nft` | nft.sawasdeecoin.com |
| Explorer | `zetaphy-explorer` | explorer.sawasdeecoin.com |
| Neuro (หน้าเว็บ) | `zetaphy-neuro` | neuro.sawasdeecoin.com |

**ทำงานอย่างไร:** `.github/workflows/cf-pages.yml` deploy จาก GitHub Actions ทุกครั้งที่มี push เข้า `main` ที่แก้ไฟล์ของเว็บใดเว็บหนึ่ง หรือกดรันเองจากแท็บ Actions ก็ได้
- `vercel.json` ของแต่ละเว็บยังเป็นต้นฉบับเหมือนเดิม
- `cloudflare/pages.mjs` แปลง `vercel.json` เป็นไฟล์ `_headers` และ `_redirects` ของ Cloudflare
- ก่อน deploy ทุกครั้ง workflow ตรวจ CSP และ security headers บนเอนจินของ Cloudflare เอง (`wrangler pages dev`, `cloudflare/pages.e2e.mjs`) ขั้นนี้สำคัญ เพราะ Cloudflare นำค่าที่สองกฎตั้งไว้มาต่อกัน ส่วน Vercel ใช้ค่าหลังแทนค่าแรก

## ตั้งค่าครั้งเดียว (เจ้าของทำ ไม่เสียเงิน)

1. **สร้าง API token:** ใน Cloudflare ไปที่ My Profile → API Tokens → Create Token → Custom token
   - สิทธิ์: *Account → Cloudflare Pages → Edit* และเลือกบัญชีของคุณ
   - สร้างแล้วคัดลอก token ไว้
   - ห้ามวาง token ในแชทหรือใน issue
2. **หา Account ID:** ใน Cloudflare เปิดหน้า Workers & Pages จะเห็น Account ID ในคอลัมน์ขวา
3. **ตั้งค่าใน GitHub:** ใน repo ไปที่ Settings → Secrets and variables → Actions
   - Secret ชื่อ `CLOUDFLARE_API_TOKEN` ใส่ token
   - Variable ชื่อ `CLOUDFLARE_ACCOUNT_ID` ใส่ account id
4. **Deploy ครั้งแรก:** ในแท็บ Actions เปิด *Cloudflare Pages* แล้วกด *Run workflow* รอบแรกจะสร้างโปรเจกต์ทั้ง 6 ให้เอง
5. **ผูกโดเมน:** ใน Workers & Pages เปิดทีละโปรเจกต์ → Custom domains → Set up a custom domain แล้วใส่โดเมนตามตาราง
   - Cloudflare จะถามว่าจะแทน DNS record เดิมที่ชี้ไป Vercel หรือไม่ ให้ตอบตกลง
   - เปิดเว็บดูให้แน่ใจว่าใช้ได้ก่อน แล้วค่อยทำเว็บถัดไป
6. **(ทำหรือไม่ก็ได้) หลังย้ายเสร็จ:** ลบโดเมนเดียวกันออกจากโปรเจกต์บน Vercel เพื่อไม่ให้สองที่ขัดกัน

## สิ่งที่ไม่ได้ย้าย

- **`/api` ของ Neuro** (ตัวนับผู้ใช้, early warning, บอท Telegram) เป็นฟังก์ชัน ย้ายแบบไฟล์ static ไม่ได้
  - ระหว่างที่ Vercel ถูกหยุด ส่วนนี้ปิดอยู่แล้ว หน้าเว็บยังใช้ได้โดยไม่มีมัน
  - เมื่อชี้ neuro.sawasdeecoin.com ไป Cloudflare แล้ว `/api` บนโดเมนนั้นจะตอบ 404
  - ถ้าจะเปิดใช้อีก ต้องให้ API มีที่อยู่ของตัวเอง เช่น subdomain แยกสำหรับ API บน Vercel หลัง 2026-12-06 หรือย้ายไป Cloudflare Pages Functions ซึ่งเป็นงานแยก
- **swd-claim-site** (swd-zetaphy.sawasdeecoin.com, Next.js) และ **test-ui** ยังอยู่บน Vercel

## จุดที่ต่างจาก Vercel (จัดการให้แล้ว)

- **Cloudflare เสิร์ฟ `/x.html` ที่ `/x`:** กฎ header ของไฟล์ `.html` จึงตั้งให้ที่อยู่แบบสั้นด้วย
- **path ที่ไม่มีอยู่:** ถ้าไม่มี `404.html` Cloudflare จะตอบทุก path ที่ไม่รู้จักด้วย `index.html` ตอน stage จึงใส่ `404.html` เล็ก ๆ ให้ ผลคือ path ที่ไม่มีจะได้ 404 เหมือนบน Vercel
- **rewrite `/api/*` ของ hub:** กลายเป็น redirect แบบ 307 ไปที่เว็บ Neuro ซึ่งปกติหน้าเว็บเรียก Neuro ตรงอยู่แล้ว (`zetaphy-neuro/web/api.js`)
