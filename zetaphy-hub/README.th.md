# ZETAPHY hub

ทุกแอปของ ZETAPHY อยู่ในหน้าเดียว จอเดียว ที่ **https://app.sawasdeecoin.com** ([English](README.md))

| แท็บ | คืออะไร |
| --- | --- |
| ภาพรวม | ตัวเลขสดของเชน (บล็อก, เวลาต่อบล็อก, validator, ยอด stake), บล็อกล่าสุด, ปุ่มเพิ่มเครือข่าย (MetaMask / Keplr), faucet ของ testnet และ endpoint |
| กระเป๋า | กระเป๋าต้านควอนตัม (`zetaphy-wallet`) |
| แลกเปลี่ยน | DEX แบบ AMM + DLMM (`zetaphy-dex/web`) |
| Stake & โหวต | **ใหม่** รายชื่อ validator, ยอด stake และรางวัลของคุณ, ข้อเสนอ ทั้ง stake / ถอน / รับรางวัล / โหวต ส่งจาก MetaMask ไปที่ precompile ของเชน (staking `0x…0800`, distribution `0x…0801`, gov `0x…0805`) |
| รับเหรียญ | **ใหม่** ทุกวิธีที่ได้ ZETAPHY เรียงจากง่ายไปยาก พร้อมคำสั่งเทอร์มินัลที่คัดลอกได้: faucet, รันร่าง Neuro ("การขุด" แบบ ZETAPHY ไม่มี PoW รางวัลมาจากงานตรวจสัญญาที่มีประโยชน์), เป็น validator, stake, เพิ่มสภาพคล่อง ค่ามัดจำ จำนวนคนรันร่าง และกองรางวัลอ่านสดจาก NeuroJobs |
| NFT | ตลาด NFT (`zetaphy-nft/web`) |
| Explorer | Explorer ของเชน (`zetaphy-explorer`) |
| สถิติ | **ใหม่** ซัพพลาย เวลาต่อบล็อก ธุรกรรมต่อนาที สัดส่วน stake กราฟธุรกรรมต่อบล็อกและเวลาระหว่างบล็อก (60 บล็อกล่าสุด) การแบ่งเหรียญตอนเปิดเชน และพลังโหวตของ validator |
| DeFi | **ใหม่** พูลทั้งหมดบน DEX พร้อมสภาพคล่องและราคา (อ่านจากสัญญา) พูล DLMM และจำนวนงาน Neuro |
| อันดับ | **ใหม่** ผู้ถือ ZETAPHY สูงสุด (มีชื่อบัญชีของโมดูลระบบ) และ validator ตาม stake |
| นักพัฒนา | **ใหม่** endpoint พร้อมตัวอย่าง curl (EVM JSON-RPC, CometBFT, REST, faucet) ไฟล์ตั้งค่าเชน เครื่องมือบรรทัดคำสั่ง และที่อยู่สัญญาทั้งหมด |
| Neuro | Neuro ตรวจสัญญา (`zetaphy-neuro/web`) ส่วน `/api/*` ส่งต่อไปที่ neuro.sawasdeecoin.com |

## ทำงานอย่างไร

- `node build.mjs` คัดลอก hub และทุกแอปลง `dist/` (`/wallet/`, `/swap/`, `/nft/`, `/explorer/`, `/neuro/web/`) แอปแสดงใน **frame ของเว็บเดียวกัน** จึงใช้ที่เก็บกระเป๋าร่วมกัน และ hub ปรับหน้าตาให้ได้
- `embed.css` ทำให้ทุกแอปใช้สีเดียวกับ hub และซ่อนแถบชื่อ ปุ่มภาษา และ footer ของแอปเอง ส่วน `hub.js` พับคำอธิบายยาวๆ เป็นไอคอน "i" ที่แสดงข้อความเมื่อเอาเมาส์ไปชี้หรือกด Tab ไปที่ ลิงก์ไปเว็บของแอปอื่นจะเปิดแท็บของแอปนั้นแทน
- ตัวแอปไม่ได้เปลี่ยน: ถ้าเปิดที่เว็บของแอปเอง (wallet.sawasdeecoin.com และอื่นๆ) หน้าตาเหมือนเดิม
- ภาษา: มีปุ่มเดียว hub จะตั้งภาษาของแต่ละแอปแล้วโหลด frame ใหม่
- คำอธิบาย: ทุกตัวเลข ปุ่ม และขั้นตอน มีข้อความเด้งเมื่อชี้ (`data-tip` / `data-tip-key`) ตัวหน้าเว็บจึงมีข้อความสั้น
- ที่อยู่โหนดอ่านจาก `zetaphy-explorer/config.json` (launch เขียนไว้) แล้วบันทึกเป็น `dist/hub-config.json`

## ขึ้นเว็บ (Vercel ฟรี)

ตั้ง root ของโปรเจกต์เป็น `zetaphy-hub` framework เลือก "Other" ส่วน `vercel.json` กำหนดคำสั่ง build, header (frame ได้เฉพาะจากเว็บนี้ สคริปต์โหลดได้เฉพาะจากเว็บนี้) และการส่งต่อ Neuro API โดเมน: `app.sawasdeecoin.com` (Cloudflare: CNAME `app` → `cname.vercel-dns.com` แบบ DNS only)

## เทสต์

```
npm ci
npm test            # calldata เทียบ ethers, bech32, จำนวนเหรียญ, ไฟล์ใน dist/, header
npm run test:e2e    # Chromium: ทุกแท็บกับโหนดจำลอง, จอเดียว, ข้อความเด้ง, stake/โหวต, มือถือ
```
