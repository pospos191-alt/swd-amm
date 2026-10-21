// What MetaMask shows under "ZETAPHY Post-Quantum" before the user confirms an
// EVM transaction or signs typed data (Thai and English together: an insight has
// no language setting).
//   enforced flag  -> severity 'critical' (MetaMask asks for an extra confirmation)
//   flag not enforced yet -> a visible warning, not critical
//   nothing flagged -> "no flag on what was checked", listing exactly what was checked
//                    (and what was not, e.g. inner calls of a batch)
//   check failed   -> "couldn't check" (and why)
//   every flag    -> the code fact (a neutral reason), its evidence (reportHash, URI,
//                    how to reproduce), the responses of the parties behind it (each
//                    with its author), and the disclaimer
//   a custom threat source (zetaphy_setThreatSource) -> said in every insight
import { Banner, Box, Row, Text, Address } from '@metamask/snaps-sdk/jsx';
import { reasonText, DISCLAIMER, REPRODUCE } from '../../zetaphy-network/src/vaccine.js';
const WHAT = {
  address: ['ที่อยู่นี้ติดธง', 'this address is flagged'],
  code: ['โค้ดตรงกับโค้ดที่ติดธงทุกไบต์', 'its code is byte-for-byte flagged code'],
  fingerprint: ['ลายนิ้วมือโค้ด (fp1) ตรงกับโค้ดที่ติดธง', 'its code fingerprint (fp1) matches flagged code'],
};
const ROLE = {
  to: ['ปลายทาง', 'Destination'], spender: ['ผู้ได้สิทธิ์ใช้เหรียญ (approve / permit)', 'Spender (approve / permit)'],
  operator: ['ผู้ได้สิทธิ์ทั้งหมด (setApprovalForAll)', 'Operator (setApprovalForAll)'], recipient: ['ผู้รับเหรียญ', 'Token recipient'],
  inner: ['ปลายทางของคำสั่งย่อย (multicall)', 'Inner call target (multicall)'], verifying: ['สัญญาที่ลายเซ็นนี้ใช้กับ', 'Contract this signature is for'],
  zone: ['zone ของคำสั่งซื้อขาย', 'Order zone'],
};
const KIND = {
  transaction: { th: 'ธุรกรรมนี้', en: 'this transaction' },
  signature: { th: 'ลายเซ็นนี้', en: 'this signature' },
};

function Responses({ f }) {
  const rs = f.responses ?? [];
  if (!rs.length) return <Text size="sm">ยังไม่มีคำชี้แจง / no response yet</Text>;
  return (
    <Box>
      {rs.map((r) => (
        <Text size="sm">{r.assigned
          ? `คำชี้แจงจากผู้ชี้แจงที่ governance แต่งตั้ง / response from the governance-assigned responder (${r.by}): "${r.text}"`
          : `คำชี้แจงจาก / response from ${r.by}${r.account && r.account !== '0x0000000000000000000000000000000000000000' ? ` (สำหรับ / for ${r.chainId}:${r.account})` : ''}: "${r.text}"`}</Text>
      ))}
    </Box>
  );
}

function Details({ f }) {
  const ev = f.evidence?.reportHash;
  return (
    <Box>
      {ev ? <Text size="sm">{`หลักฐาน / evidence: reportHash ${ev}${f.evidence.uri ? ` (${f.evidence.uri})` : ''}`}</Text>
        : <Text size="sm">หลักฐาน / evidence: {f.detailsError ? 'อ่านไม่ได้ / could not be read' : 'ไม่มีบันทึกไว้ / none stored'}</Text>}
      {ev ? <Text size="sm">{`${REPRODUCE.th} / ${REPRODUCE.en}`}</Text> : null}
      <Responses f={f} />
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

/** What was checked: one row per address (first level), the code behind proxies, and what was not. */
function Coverage({ result, kind }) {
  const { checked = [], innerUnchecked, capped } = result;
  return (
    <Box>
      {checked.filter((c) => !c.behind).map((c) => {
        const [th, en] = ROLE[c.role] ?? ROLE.to;
        return <Row label={`ตรวจแล้ว / checked: ${th} / ${en}`}><Address address={c.address} /></Row>;
      })}
      {kind === 'signature'
        ? <Text size="sm" color="alternative">ตรวจเฉพาะ: สัญญาที่ลายเซ็นนี้ใช้กับ และ spender / operator / zone / ผู้รับ ที่ข้อมูลระบุ รวมโค้ดและโค้ดหลัง proxy · Only checked: the contract this signature is for and the spender, operator, zone or recipients it names, their code and the code behind a proxy. No flag is not a guarantee.</Text>
        : <Text size="sm" color="alternative">ตรวจเฉพาะ: ปลายทาง (to) และผู้ได้สิทธิ์ / ผู้รับที่คำสั่งระบุ (อาร์กิวเมนต์แรก หรืออาร์กิวเมนต์ที่สองของ transferFrom และ Permit2 approve) รวมโค้ดและโค้ดหลัง proxy · Only checked: the destination (to) plus the spender or recipient the call names (its first argument; the second for transferFrom and Permit2 approve), their code and the code behind a proxy. Nothing else in the call data; no flag is not a guarantee.</Text>}
      {innerUnchecked ? <Text size="sm" color="warning">ไม่ได้ตรวจคำสั่งย่อยข้างใน (batch / execute) / inner calls not checked</Text> : null}
      {capped ? <Text size="sm" color="warning">มีที่อยู่มากกว่าที่ตรวจได้ บางที่อยู่ไม่ได้ตรวจ / more addresses than were checked: some were not</Text> : null}
    </Box>
  );
}

/** Said in every insight while the wallet's custom threat source is in use. */
function SourceNote({ source }) {
  if (!source?.overridden) return null;
  return <Text size="sm" color="warning">{`ใช้แหล่งตรวจที่เว็บกระเป๋าตั้งไว้ / custom threat source in use (zetaphy_setThreatSource): RPC ${source.rpc}, ThreatRegistry ${source.registry}`}</Text>;
}

/** { content, severity? } for onTransaction / onSignature. */
export function insight(result, { kind = 'transaction', source = null } = {}) {
  const { state, findings = [], error } = result;
  const k = KIND[kind] ?? KIND.transaction;
  if (state === 'enforced') {
    return {
      severity: 'critical',
      content: (
        <Box>
          <Banner title="ธงบังคับใช้แล้ว: ZETAPHY Neuro / Enforced flag: ZETAPHY Neuro" severity="danger">
            <Text>{`นักรัน Neuro ติดธงข้อเท็จจริงของโค้ดที่${k.th}เกี่ยวข้อง และธงบังคับใช้แล้ว ดูหลักฐานและคำชี้แจงด้านล่าง อย่ายืนยัน เว้นแต่คุณแน่ใจจริง ๆ`}</Text>
            <Text>{`Neuro runners flagged a code fact about an address ${k.en} involves, and the flag is enforced. See the evidence and any response below. Do not confirm unless you are certain.`}</Text>
          </Banner>
          {findings.filter((f) => f.enforced).map((f) => <Finding f={f} />)}
          <Text size="sm" color="alternative">{`${DISCLAIMER.th} / ${DISCLAIMER.en}`}</Text>
          <SourceNote source={source} />
        </Box>
      ),
    };
  }
  if (state === 'warned') {
    return {
      content: (
        <Box>
          <Banner title="คำเตือนจาก ZETAPHY Neuro / Warning from ZETAPHY Neuro" severity="warning">
            <Text>{`นักรัน Neuro ติดธงข้อเท็จจริงของโค้ดที่${k.th}เกี่ยวข้องแล้ว แต่ธงยังไม่บังคับใช้ (governance ยังตรวจทานได้) ตรวจให้ดีก่อนยืนยัน`}</Text>
            <Text>{`Neuro runners flagged a code fact about an address ${k.en} involves, but the flag is not enforced yet (governance can still review it). Check carefully before you confirm.`}</Text>
          </Banner>
          {findings.map((f) => <Finding f={f} />)}
          <Text size="sm" color="alternative">{`${DISCLAIMER.th} / ${DISCLAIMER.en}`}</Text>
          {error ? <Text size="sm" color="alternative">ตรวจได้ไม่ครบ / not fully checked: {error}</Text> : null}
          {result.innerUnchecked ? <Text size="sm" color="warning">ไม่ได้ตรวจคำสั่งย่อยข้างใน (batch / execute) / inner calls not checked</Text> : null}
          <SourceNote source={source} />
        </Box>
      ),
    };
  }
  if (state === 'clean') {
    return {
      content: (
        <Box>
          <Text color="success">ZETAPHY Neuro: ไม่พบธงในสิ่งที่ตรวจ / no flag on what was checked</Text>
          <Coverage result={result} kind={kind} />
          <SourceNote source={source} />
        </Box>
      ),
    };
  }
  if (state === 'none') {
    return {
      content: (
        <Box>
          <Text color="alternative">{kind === 'signature'
            ? 'ZETAPHY Neuro: ลายเซ็นนี้ไม่ระบุสัญญาหรือผู้ได้สิทธิ์ให้ตรวจ / this signature names no contract or spender to check'
            : 'ZETAPHY Neuro: สร้างสัญญา ไม่มีปลายทางให้ตรวจ / a contract creation has no destination to check'}</Text>
          <SourceNote source={source} />
        </Box>
      ),
    };
  }
  return {
    content: (
      <Box>
        <Text color="warning">{`ZETAPHY Neuro ตรวจ${k.th}ไม่ได้ / ZETAPHY Neuro couldn't check ${k.en}`}</Text>
        <Text size="sm" color="alternative">{error ?? 'unknown error'}</Text>
        {result.innerUnchecked ? <Text size="sm" color="warning">ไม่ได้ตรวจคำสั่งย่อยข้างใน (batch / execute) / inner calls not checked</Text> : null}
        <SourceNote source={source} />
      </Box>
    ),
  };
}
