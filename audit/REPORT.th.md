# รายงานตรวจสอบอัตโนมัติ ZETAPHY (สรุปภาษาไทย)

> ตรวจ commit `444516057bc8892889265dbbe7780fc29dc7af95` ระดับ ละเอียด (deep, รายสัปดาห์) เมื่อ 2026-11-01T09:40:27Z
> รายงานนี้สร้างโดยเครื่องมือฟรีโอเพนซอร์สและสคริปต์ของเราเอง **ไม่ใช่การ audit อิสระ และใช้แทนการ audit โดยผู้เชี่ยวชาญภายนอกไม่ได้** รายละเอียดเต็มอยู่ใน [REPORT.md](REPORT.md)

## สรุปจำนวนสิ่งที่พบ

| ระดับ | ทั้งหมด | ยังเปิดอยู่ | เปิดอยู่และเป็นของใหม่ |
|---|---:|---:|---:|
| วิกฤต (Critical) | 0 | 0 | 0 |
| สูง (High) | 341 | 39 | 39 |
| กลาง (Medium) | 321 | 321 | - |
| ต่ำ (Low) | 1929 | 1929 | - |
| ข้อมูล (Info) | 600 | 600 | - |

- **ด่านตรวจ PR:** ไม่ผ่าน — มีสิ่งที่พบระดับสูง/วิกฤตใหม่ที่ยังไม่ได้ตัดสิน 39 รายการ
- **ชุดทดสอบ invariant / property:** ผ่าน null · ไม่ผ่าน null · ยังไม่ได้รัน null
- **คะแนน mutation testing:** ไม่ได้วัดในรอบนี้ (วัดในรอบ deep รายสัปดาห์)
- **สัญญาที่คอมไพล์:** 0 ตัว · artifacts ที่ commit ไว้ตรงกับซอร์ส 0 ตัว ไม่ตรง 0 ตัว

## รายการระดับสูง/วิกฤตที่ยังเปิดอยู่

(ตัดสินแล้ว 302 รายการ ในจำนวนนี้รอเจ้าของยืนยัน 0 รายการ — ดูเหตุผลใน REPORT.md / triage.yml)

- `zetaphy-dex/audit/invariants` — forge/property-violated: forge: ZetaphyPairInvariants.invariant_shareValueNonDecreasing() fails — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6165: GO-2026-6165 in github.com/pion/dtls/v3@v3.1.2 (called: github.com/pion/dtls/v3/pkg/protocol/handshake.Unmarshal) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6508: GO-2026-6508 in go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc@v0.19.0 (called: go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc/internal/observ.init$2) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6061: GO-2026-6061 in google.golang.org/grpc@v1.80.0 (called: google.golang.org/grpc/internal/transport.Close) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6348: GO-2026-6348 in google.golang.org/grpc@v1.80.0 (called: google.golang.org/grpc/internal/transport.Read) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6443: GO-2026-6443 in google.golang.org/grpc@v1.80.0 (called: google.golang.org/grpc/internal/transport.HandleStreams) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6603: GO-2026-6603 in golang.org/x/net@v0.57.0 (called: golang.org/x/net/http2.WriteSettings) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6610: GO-2026-6610 in golang.org/x/net@v0.57.0 (called: golang.org/x/net/http2.RoundTrip) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6611: GO-2026-6611 in golang.org/x/net@v0.57.0 (called: golang.org/x/net/http2.Read) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6612: GO-2026-6612 in stdlib@v1.25.9 (called: net/http.Close) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6617: GO-2026-6617 in golang.org/x/net@v0.57.0 (called: golang.org/x/net/http2.Error) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6505: GO-2026-6505 in go.opentelemetry.io/otel/sdk@v1.43.0 (called: go.opentelemetry.io/otel/sdk/trace.AddEvent) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5158: GO-2026-5158 in go.opentelemetry.io/otel@v1.43.0 (called: go.opentelemetry.io/otel/propagation.Extract) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6615: GO-2026-6615 in go.opentelemetry.io/otel/sdk/log@v0.19.0 (called: go.opentelemetry.io/otel/sdk/log.init$6) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-4918: GO-2026-4918 in stdlib@v1.25.9 (called: net/http.PostForm) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-4971: GO-2026-4971 in stdlib@v1.25.9 (called: net.LookupHost) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-4976: GO-2026-4976 in stdlib@v1.25.9 (called: net/http/httputil.ServeHTTP) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-4980: GO-2026-4980 in stdlib@v1.25.9 (called: html/template.Execute) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-4982: GO-2026-4982 in stdlib@v1.25.9 (called: html/template.Execute) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5026: GO-2026-5026 in stdlib@v1.25.9 (called: net/http.PostForm) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5037: GO-2026-5037 in stdlib@v1.25.9 (called: crypto/x509.Verify) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5039: GO-2026-5039 in stdlib@v1.25.9 (called: net/textproto.ReadMIMEHeader) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5856: GO-2026-5856 in stdlib@v1.25.9 (called: crypto/tls.HandshakeContext) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5972: GO-2026-5972 in stdlib@v1.25.9 (called: encoding/asn1.Unmarshal) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6088: GO-2026-6088 in stdlib@v1.25.9 (called: encoding/xml.Token) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6089: GO-2026-6089 in stdlib@v1.25.9 (called: net/http.Serve) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6090: GO-2026-6090 in stdlib@v1.25.9 (called: crypto/tls.Read) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6091: GO-2026-6091 in stdlib@v1.25.9 (called: html/template.ExecuteTemplate) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6218: GO-2026-6218 in stdlib@v1.25.9 (called: net/url.ResolveReference) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6599: GO-2026-6599 in stdlib@v1.25.9 (called: html/template.Execute) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6600: GO-2026-6600 in stdlib@v1.25.9 (called: html/template.ExecuteTemplate) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6605: GO-2026-6605 in stdlib@v1.25.9 (called: net/http.CloseIdleConnections) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6607: GO-2026-6607 in stdlib@v1.25.9 (called: crypto/tls.HandshakeContext) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6608: GO-2026-6608 in stdlib@v1.25.9 (called: mime/multipart.ReadForm) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6609: GO-2026-6609 in stdlib@v1.25.9 (called: net/http.ServeHTTP) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6613: GO-2026-6613 in stdlib@v1.25.9 (called: net/http.Get) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-6809: GO-2026-6809 in stdlib@v1.25.9 (called: crypto/x509.Verify) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-4479: GO-2026-4479 in github.com/pion/dtls/v2@v2.2.12 (called: github.com/pion/dtls/v2/internal/ciphersuite.NewTLSEcdheEcdsaWithAes128Ccm) — สถานะ: **เปิดอยู่ (ใหม่)**
- `zetaphy-chain:go.mod` — govulncheck/GO-2026-5932: GO-2026-5932 in golang.org/x/crypto@v0.54.0 (called: golang.org/x/crypto/openpgp/armor.Write) — สถานะ: **เปิดอยู่ (ใหม่)**

## วิธีอ่านและจัดการ

1. ดูรายการระดับสูง/วิกฤตก่อน อ่านโค้ดตรงบรรทัดที่ระบุ แล้วตัดสินว่าเป็นปัญหาจริงหรือไม่
2. ถ้าจริง: แก้โค้ดใน PR แยก แล้วเพิ่มใน `audit/triage.yml` เป็น `fixed` (เมื่อแก้แล้วเครื่องมือจะไม่พบอีก)
3. ถ้าไม่จริง: เพิ่มเป็น `false-positive` พร้อมเหตุผลที่ตรวจสอบได้ และชื่อผู้ตัดสิน (`decided_by`)
4. ถ้ายอมรับความเสี่ยง: `accepted-risk` พร้อมเหตุผล — ระบบไม่เคยใส่สถานะเหล่านี้เอง มีแต่คนเท่านั้นที่แก้ไฟล์นี้

## สิ่งที่รายงานนี้พิสูจน์ไม่ได้ (ณ 2026-11-01)

- ไม่พบปัญหา ≠ ปลอดภัย: เครื่องมือรู้จักแค่รูปแบบที่เคยเห็น พลาดบั๊กเชิงตรรกะธุรกิจได้ง่าย
- ไม่ได้จำลองการโจมตีเชิงเศรษฐศาสตร์ (flash loan, ปั่นราคา oracle, MEV, ยึด governance)
- SMTChecker พิสูจน์ได้เฉพาะที่รายงานว่าพิสูจน์แล้ว ภายในเวลาที่กำหนด
- fuzzing/invariant ทดสอบเฉพาะคุณสมบัติที่มีคนเขียนไว้ ชุดที่ยังไม่มีนับเป็น "ยังไม่ได้รัน" ไม่ใช่ "ผ่าน"
- ไม่ครอบคลุมการ deploy และการดูแลกุญแจ owner/admin, multisig, timelock ที่ใช้จริง
- **ก่อนใช้ mainnet กับเงินจริง ยังต้องมีการ audit อิสระโดยคน** (ดู SECURITY.md)

