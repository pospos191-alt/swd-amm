// What MetaMask shows under "ZETAPHY Post-Quantum" before the user confirms an
// EVM transaction (Thai and English together: an insight has no language setting).
//   enforced flag  -> severity 'critical' (MetaMask asks for an extra confirmation)
//   flag not enforced yet -> a visible warning, not critical
//   nothing flagged -> a short "checked by ZETAPHY Neuro"
//   check failed   -> "couldn't check" (and why)
//   every flag    -> the code fact (a neutral reason), its evidence (reportHash, URI,
//                    how to reproduce), the owner's response if any, and the disclaimer
import { Banner, Box, Row, Text, Address } from '@metamask/snaps-sdk/jsx';
import { reasonText, DISCLAIMER, REPRODUCE } from '../../zetaphy-network/src/vaccine.js';
const WHAT = {
  address: ['ที่อยู่นี้ติดธง', 'this address is flagged'],
  code: ['โค้ดตรงกับโค้ดที่ติดธงทุกไบต์', 'its code is byte-for-byte flagged code'],
  fingerprint: ['ลายนิ้วมือโค้ด (fp1) ตรงกับโค้ดที่ติดธง', 'its code fingerprint (fp1) matches flagged code'],
};
const ROLE = {
  to: ['ปลายทาง', 'Destination'], spender: ['ผู้ได้สิทธิ์ใช้เหรียญ (approve)', 'Spender (approve)'],
  operator: ['ผู้ได้สิทธิ์ทั้งหมด (setApprovalForAll)', 'Operator (setApprovalForAll)'], recipient: ['ผู้รับเหรียญ', 'Token recipient'],
};

function Details({ f }) {
  const ev = f.evidence?.reportHash;
  return (
    <Box>
      {ev ? <Text size="sm">{`หลักฐาน / evidence: reportHash ${ev}${f.evidence.uri ? ` (${f.evidence.uri})` : ''}`}</Text>
        : <Text size="sm">หลักฐาน / evidence: {f.detailsError ? 'อ่านไม่ได้ / could not be read' : 'ไม่มีบันทึกไว้ / none stored'}</Text>}
      {ev ? <Text size="sm">{`${REPRODUCE.th} / ${REPRODUCE.en}`}</Text> : null}
      {f.response ? <Text size="sm">{`คำชี้แจงของเจ้าของ / owner's response (${f.response.by}): "${f.response.text}"`}</Text>
        : <Text size="sm">เจ้าของยังไม่ได้ชี้แจง / no response from the owner yet</Text>}
    </Box>
  );
}

function Finding({ f }) {
  const [roleTh, roleEn] = ROLE[f.role] ?? ROLE.to;
  const [whatTh, whatEn] = WHAT[f.what] ?? [f.what, f.what];
  return (
    <Box>
      <Row label={`${roleTh} / ${roleEn}`}>
        <Address address={f.address} />
      </Row>
      {f.behind ? <Text size="sm">โค้ดจริงหลัง proxy {f.behind} / the code behind proxy {f.behind}</Text> : null}
      <Text size="sm">{whatTh} · เหตุผล: {reasonText(f.reason).th}</Text>
      <Text size="sm">{whatEn} · reason: {reasonText(f.reason).en}</Text>
      <Details f={f} />
    </Box>
  );
}

/** { content, severity? } for onTransaction. */
export function insight(result) {
  const { state, findings = [], error } = result;
  if (state === 'enforced') {
    return {
      severity: 'critical',
      content: (
        <Box>
          <Banner title="ธงบังคับใช้แล้ว: ZETAPHY Neuro / Enforced flag: ZETAPHY Neuro" severity="danger">
            <Text>นักรัน Neuro ติดธงข้อเท็จจริงของโค้ดปลายทางนี้ และธงบังคับใช้แล้ว ดูหลักฐานและคำชี้แจงด้านล่าง อย่ายืนยัน เว้นแต่คุณแน่ใจจริง ๆ</Text>
            <Text>Neuro runners flagged a code fact about this destination, and the flag is enforced. See the evidence and any response below. Do not confirm unless you are certain.</Text>
          </Banner>
          {findings.filter((f) => f.enforced).map((f) => <Finding f={f} />)}
          <Text size="sm" color="alternative">{`${DISCLAIMER.th} / ${DISCLAIMER.en}`}</Text>
        </Box>
      ),
    };
  }
  if (state === 'warned') {
    return {
      content: (
        <Box>
          <Banner title="คำเตือนจาก ZETAPHY Neuro / Warning from ZETAPHY Neuro" severity="warning">
            <Text>นักรัน Neuro ติดธงข้อเท็จจริงของโค้ดปลายทางนี้แล้ว แต่ธงยังไม่บังคับใช้ (governance ยังตรวจทานได้) ตรวจให้ดีก่อนยืนยัน</Text>
            <Text>Neuro runners flagged a code fact about this destination, but the flag is not enforced yet (governance can still review it). Check carefully before you confirm.</Text>
          </Banner>
          {findings.map((f) => <Finding f={f} />)}
          <Text size="sm" color="alternative">{`${DISCLAIMER.th} / ${DISCLAIMER.en}`}</Text>
          {error ? <Text size="sm" color="alternative">ตรวจได้ไม่ครบ / not fully checked: {error}</Text> : null}
        </Box>
      ),
    };
  }
  if (state === 'clean') {
    return {
      content: (
        <Box>
          <Text color="success">ตรวจโดย ZETAPHY Neuro แล้ว: ไม่ติดธง / Checked by ZETAPHY Neuro: not flagged</Text>
          <Text size="sm" color="alternative">ที่อยู่ โค้ด และโค้ดหลัง proxy (EIP-1167 / EIP-1967 / beacon) · the address, its code and the code behind a proxy</Text>
        </Box>
      ),
    };
  }
  if (state === 'none') {
    return { content: <Text color="alternative">ZETAPHY Neuro: สร้างสัญญา ไม่มีปลายทางให้ตรวจ / a contract creation has no destination to check</Text> };
  }
  return {
    content: (
      <Box>
        <Text color="warning">ZETAPHY Neuro ตรวจไม่ได้ / ZETAPHY Neuro couldn't check this transaction</Text>
        <Text size="sm" color="alternative">{error ?? 'unknown error'}</Text>
      </Box>
    ),
  };
}
