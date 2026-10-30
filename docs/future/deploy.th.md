# Deploy สัญญาของแผนที่ AI (ปุ่มเดียว)

แผนที่ AI ในฮับมี 35 รายการ รายการที่สัญญายังไม่ขึ้น testnet จะขึ้นป้ายว่า "หน้าพร้อม ยังไม่ได้ deploy สัญญา" มี workflow เดียวที่ deploy ให้ครบทุกตัว

**วิธีกด:** Actions › ai-deploy › Run workflow
- ใช้ environment `testnet-deploy` เจ้าของต้องกดอนุมัติ
- RPC สาธารณะต้องเปิดอยู่

ทำตามลำดับนี้:

1. deploy สัญญา AI ทุกตัวที่ยังขาด (`zetaphy-network/src/aideploy.js`) แต่ละตัว **มี ZetaphyTimelock เป็นเจ้าของ** กุญแจที่ใช้ deploy ไม่ได้ถือสิทธิ์อะไรไว้เลย
   - Model registry (1)
   - NeuroScore (3)
   - ModelEpochs (35)
   - SignalBoard (2, 7)
   - ตัวตรวจ passkey และคณะผู้ร่วมเซ็น (9, 14)
   - ทะเบียนเอเจนต์ (23)
   - ป้ายคน/เอเจนต์ และการรับรอง (25)
   - Intent executor (24)
   - Foresight (29), การพยากรณ์ความเสี่ยง (15), ตัวตรวจจับที่วิวัฒน์ได้ (26), Data DAO (16), สนามแดง-น้ำเงิน (27)
   - NeuroAttest (19), NeuroAnchor (30)
2. Useful work (10, 34) ถ้ายังไม่มี จะ deploy ไว้ในสถานะหยุดชั่วคราว
3. FederatedRounds (6) ถ้ายังไม่มี จะ deploy ไว้ในสถานะปิด
4. ตั้งให้หน้า Neuro ค้นหา peer อัตโนมัติผ่าน SignalBoard

หลัง deploy ให้รัน `node scripts/ai-deploy.js check` เพื่ออ่านเจ้าของของทุกสัญญากลับมาตรวจ ถ้ามีตัวไหนไม่ใช่ timelock จะขึ้นว่าล้มเหลว

ที่อยู่สัญญาจะถูกบันทึกลง `zetaphy-network/deployments/ai-77390.json` บน branch `ai/testnet` ให้เปิด PR แล้ว merge จากนั้นฮับจะเปลี่ยนป้ายของรายการเหล่านั้นเป็น "ใช้ได้แล้ว" เอง (`statusOf` ใน `zetaphy-hub/flow.js`)

ถ้ารันแล้วหยุดกลางทาง กดรันใหม่ได้เลย ตัวที่ deploy แล้วจะถูกข้าม

**สิ่งที่ปุ่มนี้ไม่ได้ทำ:**
- สัญญาที่หยุดชั่วคราว (useful work) หรือปิดอยู่ (federated) ต้องเปิดผ่านข้อเสนอของ timelock ภายหลัง
- กระจกของภูมิคุ้มกันหมู่ (28) บนเชนอื่น deploy ผ่าน workflow `neuro-oracle`
