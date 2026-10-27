// "ZETAPHY chain this month" on the Neuro page: transaction counts by kind from
// /api/chain-stats (server/chainstats.js). Strings live here, not in src/lang,
// so they are not part of the skill id. Optional: hidden when unavailable.
const TEXT = {
  en: { title: 'ZETAPHY chain this month', all: 'Transactions', transfers: 'Transfers', staking: 'Staking', crossChain: 'Cross-chain', evm: 'EVM & contracts', governance: 'Governance', since: 'Since genesis', block: 'block', note: 'Updated daily from the chain. The PQ certificate in every block is not counted.' },
  zh: { title: '本月 ZETAPHY 链上', all: '交易', transfers: '转账', staking: '质押', crossChain: '跨链', evm: 'EVM 与合约', governance: '治理', since: '自创世以来', block: '区块', note: '每天从链上更新。不计入每个区块中的 PQ 证书。' },
  es: { title: 'Cadena ZETAPHY este mes', all: 'Transacciones', transfers: 'Transferencias', staking: 'Staking', crossChain: 'Entre cadenas', evm: 'EVM y contratos', governance: 'Gobernanza', since: 'Desde el génesis', block: 'bloque', note: 'Se actualiza a diario desde la cadena. No se cuenta el certificado PQ de cada bloque.' },
  ko: { title: '이번 달 ZETAPHY 체인', all: '거래', transfers: '전송', staking: '스테이킹', crossChain: '크로스체인', evm: 'EVM 및 컨트랙트', governance: '거버넌스', since: '제네시스 이후', block: '블록', note: '체인에서 매일 갱신됩니다. 모든 블록의 PQ 인증서는 세지 않습니다.' },
  ja: { title: '今月の ZETAPHY チェーン', all: '取引', transfers: '送金', staking: 'ステーキング', crossChain: 'クロスチェーン', evm: 'EVM とコントラクト', governance: 'ガバナンス', since: 'ジェネシス以降', block: 'ブロック', note: 'チェーンから毎日更新。各ブロックの PQ 証明書は数えません。' },
  ru: { title: 'Сеть ZETAPHY в этом месяце', all: 'Транзакции', transfers: 'Переводы', staking: 'Стейкинг', crossChain: 'Между сетями', evm: 'EVM и контракты', governance: 'Управление', since: 'С генезиса', block: 'блок', note: 'Обновляется ежедневно по данным сети. PQ-сертификат в каждом блоке не учитывается.' },
  vi: { title: 'Chuỗi ZETAPHY tháng này', all: 'Giao dịch', transfers: 'Chuyển tiền', staking: 'Staking', crossChain: 'Liên chuỗi', evm: 'EVM và hợp đồng', governance: 'Quản trị', since: 'Từ khối khởi tạo', block: 'khối', note: 'Cập nhật hằng ngày từ chuỗi. Không tính chứng chỉ PQ có trong mỗi khối.' },
  th: { title: 'บนเชน ZETAPHY เดือนนี้', all: 'ธุรกรรมทั้งหมด', transfers: 'การโอน', staking: 'Staking', crossChain: 'ข้ามเชน', evm: 'EVM และสัญญา', governance: 'การโหวต/ข้อเสนอ', since: 'ตั้งแต่เริ่มเชน', block: 'บล็อก', note: 'อัปเดตวันละครั้งจากเชน ไม่นับใบรับรอง PQ ที่มีในทุกบล็อก' },
  id: { title: 'Jaringan ZETAPHY bulan ini', all: 'Transaksi', transfers: 'Transfer', staking: 'Staking', crossChain: 'Lintas jaringan', evm: 'EVM & kontrak', governance: 'Tata kelola', since: 'Sejak genesis', block: 'blok', note: 'Diperbarui setiap hari dari jaringan. Sertifikat PQ di setiap blok tidak dihitung.' },
};
export const CHAIN_TEXT = TEXT;
const KINDS = ['all', 'transfers', 'staking', 'crossChain', 'evm', 'governance'];

let data = null;

export function renderChainStats(lang) {
  const box = document.getElementById('chainstats');
  if (!box || !data) return;
  const t = TEXT[lang] ?? TEXT.en;
  const n = new Intl.NumberFormat(lang);
  box.querySelector('h2').textContent = t.title;
  for (const k of KINDS) {
    const el = box.querySelector(`[data-cs="${k}"]`);
    el.querySelector('b').textContent = n.format(Number(data.thisMonth?.[k]) || 0);
    el.querySelector('span').textContent = t[k];
  }
  const parts = [`${t.since}: ${n.format(Number(data.total?.all) || 0)} ${t.all.toLowerCase()}`];
  if (data.height) parts.push(`${t.block} ${n.format(data.height)}`);
  if (data.updatedAt) parts.push(new Date(data.updatedAt).toLocaleString(lang));
  box.querySelector('p').textContent = `${parts.join(' · ')}. ${t.note}`;
  box.hidden = false;
}

export async function loadChainStats(getLang) {
  if (!/^https?:$/.test(location.protocol)) return;
  try {
    const r = await (await fetch('/api/chain-stats')).json();
    if (!r?.enabled || !r.updatedAt) return;
    data = r;
    renderChainStats(getLang());
  } catch { /* optional */ }
}
