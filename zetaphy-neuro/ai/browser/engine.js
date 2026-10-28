// The in-browser model engine: runs a model the verified loader
// (ai/browser/loader.js) delivered, entirely in this browser, in plain JS (no
// WASM, no eval: works under script-src 'self').
//
// What ships today, said plainly: the model is Neuro's learned risk score
// (ml/model.json, gradient-boosted trees, runtime "neuro-ml-gbdt/1"), not a
// language model. The engine scores the report with it and writes the analyst
// report from fixed templates in Neuro's 9 languages, citing only evidence ids
// that exist in the context (rule findings F<n>, on-chain records CHAIN<n>, the
// score itself ML). The answer goes through the same validator as any provider's
// (ai/schema.js). Free-form follow-up questions get a retrieval answer (the
// context records closest to the question), not generated text.
// A real small LLM (e.g. a 0.5-1.5B model through a vendored WASM/WebGPU
// runtime) can be added as another runtime here; see docs/future/browser-ai.md.

import { checkModel } from '../../ml/model.js';
import { scoreReport, RANK } from '../../ml/combine.js';
import { explain, LANGS } from '../../src/explain.js';

const K = {
  en: { found: '{n} rule finding(s) are listed below with their evidence.', ml: 'The learned model (checked against the on-chain registry and run in this browser) estimates the risk at {p}%.', mlTitle: 'Learned model score', mlDetail: 'Statistical estimate {p}%; strongest signals: {f}.', flagTitle: 'On-chain flag', flag: 'The ZETAPHY ThreatRegistry has a standing flag on this {key}: {reason}.', votes: 'Runner votes on this {key}: {n}, no standing flag.', same: 'Past network verdicts on this address match this report.', diffTitle: 'Past network verdict differs', diff: 'A past network verdict on this address differs from this report: the code or the rules may have changed since.', note: 'Written by a small in-browser model and fixed templates, not by a language model.', keys: { fingerprint: 'code fingerprint', address: 'address', code: 'exact code' }, should: ['Check who controls the owner or admin role before trusting this contract.', 'Approve only the amount you need, and revoke approvals you no longer use.', 'If you trade it, try a very small sell first.'], noAnswer: 'The in-browser model cannot answer free-form questions. These are the records in the context closest to your question.', nothing: 'The in-browser model found nothing in the context about that.' },
  th: { found: 'ข้อค้นพบจากกฎ {n} ข้อ แสดงด้านล่างพร้อมหลักฐาน', ml: 'โมเดลที่เรียนรู้ (ตรวจกับทะเบียนบนเชนแล้ว และรันในเบราว์เซอร์นี้) ประเมินความเสี่ยงไว้ที่ {p}%', mlTitle: 'คะแนนจากโมเดลที่เรียนรู้', mlDetail: 'ค่าประมาณทางสถิติ {p}% สัญญาณที่แรงที่สุด: {f}', flagTitle: 'มีธงบนเชน', flag: 'ThreatRegistry ของ ZETAPHY มีธงที่ยังมีผลกับ{key}นี้: {reason}', votes: 'มีโหวตของ runner เกี่ยวกับ{key}นี้ {n} ครั้ง แต่ยังไม่มีธง', same: 'ผลตัดสินของเครือข่ายในอดีตสำหรับที่อยู่นี้ตรงกับรายงานนี้', diffTitle: 'ผลตัดสินในอดีตต่างจากตอนนี้', diff: 'ผลตัดสินของเครือข่ายในอดีตสำหรับที่อยู่นี้ต่างจากรายงานนี้: โค้ดหรือกฎอาจเปลี่ยนไปแล้ว', note: 'เขียนโดยโมเดลขนาดเล็กในเบราว์เซอร์และแม่แบบตายตัว ไม่ใช่โมเดลภาษา', keys: { fingerprint: 'ลายนิ้วมือโค้ด', address: 'ที่อยู่', code: 'โค้ดชุดนี้' }, should: ['ตรวจว่าใครถือสิทธิ์เจ้าของหรือผู้ดูแลก่อนไว้ใจสัญญานี้', 'อนุมัติ (approve) เท่าที่ต้องใช้ และยกเลิกการอนุมัติที่ไม่ใช้แล้ว', 'ถ้าจะซื้อขาย ลองขายจำนวนน้อยมากก่อน'], noAnswer: 'โมเดลในเบราว์เซอร์ตอบคำถามแบบอิสระไม่ได้ นี่คือข้อมูลในบริบทที่ใกล้กับคำถามที่สุด', nothing: 'โมเดลในเบราว์เซอร์ไม่พบข้อมูลเรื่องนี้ในบริบท' },
  zh: { found: '下面列出 {n} 条规则发现及其证据。', ml: '学习模型(已对照链上注册表校验，并在本浏览器中运行)估计风险为 {p}%。', mlTitle: '学习模型评分', mlDetail: '统计估计 {p}%；最强信号：{f}。', flagTitle: '链上标记', flag: 'ZETAPHY ThreatRegistry 对此{key}有一个有效标记：{reason}。', votes: '节点对此{key}的投票：{n} 次，尚无有效标记。', same: '网络过去对该地址的裁定与本报告一致。', diffTitle: '过去的网络裁定不同', diff: '网络过去对该地址的裁定与本报告不同：代码或规则此后可能已改变。', note: '由浏览器内的小模型和固定模板生成，不是语言模型。', keys: { fingerprint: '代码指纹', address: '地址', code: '代码' }, should: ['在信任此合约前，先确认谁控制 owner 或管理员角色。', '只授权(approve)所需金额，并撤销不再使用的授权。', '如要交易，先试着卖出极少量。'], noAnswer: '浏览器内模型无法回答自由提问。以下是上下文中与问题最相关的记录。', nothing: '浏览器内模型在上下文中没有找到相关内容。' },
  es: { found: 'Abajo se listan {n} hallazgo(s) de las reglas con su evidencia.', ml: 'El modelo aprendido (verificado contra el registro on-chain y ejecutado en este navegador) estima el riesgo en {p}%.', mlTitle: 'Puntuación del modelo aprendido', mlDetail: 'Estimación estadística {p}%; señales más fuertes: {f}.', flagTitle: 'Marca on-chain', flag: 'El ThreatRegistry de ZETAPHY tiene una marca vigente sobre este/a {key}: {reason}.', votes: 'Votos de runners sobre este/a {key}: {n}, sin marca vigente.', same: 'Los veredictos anteriores de la red sobre esta dirección coinciden con este informe.', diffTitle: 'Un veredicto anterior difiere', diff: 'Un veredicto anterior de la red sobre esta dirección difiere de este informe: el código o las reglas pueden haber cambiado.', note: 'Escrito por un modelo pequeño en el navegador y plantillas fijas, no por un modelo de lenguaje.', keys: { fingerprint: 'huella del código', address: 'dirección', code: 'código exacto' }, should: ['Comprueba quién controla el rol de owner o admin antes de confiar en este contrato.', 'Aprueba solo la cantidad que necesitas y revoca las aprobaciones que ya no uses.', 'Si lo operas, prueba primero a vender una cantidad muy pequeña.'], noAnswer: 'El modelo del navegador no responde preguntas libres. Estos son los registros del contexto más cercanos a tu pregunta.', nothing: 'El modelo del navegador no encontró nada sobre eso en el contexto.' },
  ko: { found: '규칙 발견 {n}건이 증거와 함께 아래에 있습니다.', ml: '학습 모델(온체인 레지스트리와 대조 확인 후 이 브라우저에서 실행)은 위험을 {p}%로 추정합니다.', mlTitle: '학습 모델 점수', mlDetail: '통계적 추정 {p}%; 가장 강한 신호: {f}.', flagTitle: '온체인 플래그', flag: 'ZETAPHY ThreatRegistry에 이 {key}에 대한 유효한 플래그가 있습니다: {reason}.', votes: '이 {key}에 대한 러너 투표: {n}회, 유효한 플래그 없음.', same: '이 주소에 대한 네트워크의 과거 판정이 이 보고서와 같습니다.', diffTitle: '과거 네트워크 판정이 다름', diff: '이 주소에 대한 네트워크의 과거 판정이 이 보고서와 다릅니다: 그 뒤로 코드나 규칙이 바뀌었을 수 있습니다.', note: '언어 모델이 아니라 브라우저 안의 작은 모델과 고정 템플릿이 작성했습니다.', keys: { fingerprint: '코드 지문', address: '주소', code: '코드' }, should: ['이 컨트랙트를 믿기 전에 owner 또는 관리자 권한을 누가 가졌는지 확인하세요.', '필요한 만큼만 승인(approve)하고 쓰지 않는 승인은 취소하세요.', '거래한다면 먼저 아주 적은 양을 팔아 보세요.'], noAnswer: '브라우저 내 모델은 자유 질문에 답할 수 없습니다. 질문과 가장 가까운 컨텍스트 기록입니다.', nothing: '브라우저 내 모델이 컨텍스트에서 관련 내용을 찾지 못했습니다.' },
  ja: { found: 'ルールによる検出 {n} 件を証拠とともに下に示します。', ml: '学習モデル(オンチェーンのレジストリで検証し、このブラウザで実行)はリスクを {p}% と推定します。', mlTitle: '学習モデルのスコア', mlDetail: '統計的推定 {p}%。最も強いシグナル: {f}。', flagTitle: 'オンチェーンのフラグ', flag: 'ZETAPHY の ThreatRegistry にこの{key}への有効なフラグがあります: {reason}。', votes: 'この{key}へのランナーの投票: {n} 件、有効なフラグはありません。', same: 'このアドレスに対するネットワークの過去の判定はこのレポートと一致します。', diffTitle: '過去のネットワーク判定と異なる', diff: 'このアドレスに対するネットワークの過去の判定はこのレポートと異なります: その後コードやルールが変わった可能性があります。', note: '言語モデルではなく、ブラウザ内の小さなモデルと固定テンプレートで作成しました。', keys: { fingerprint: 'コード指紋', address: 'アドレス', code: 'コード' }, should: ['このコントラクトを信頼する前に、owner や管理者の権限を誰が持つか確認してください。', '必要な額だけ承認(approve)し、使わない承認は取り消してください。', '取引するなら、まずごく少額の売却を試してください。'], noAnswer: 'ブラウザ内モデルは自由な質問には答えられません。質問に最も近いコンテキストの記録です。', nothing: 'ブラウザ内モデルはコンテキストに関連する情報を見つけられませんでした。' },
  ru: { found: 'Ниже {n} находк(и) правил с доказательствами.', ml: 'Обученная модель (проверена по реестру в сети и запущена в этом браузере) оценивает риск в {p}%.', mlTitle: 'Оценка обученной модели', mlDetail: 'Статистическая оценка {p}%; самые сильные сигналы: {f}.', flagTitle: 'Отметка в сети', flag: 'В ThreatRegistry ZETAPHY есть действующая отметка на этот объект ({key}): {reason}.', votes: 'Голосов раннеров по этому объекту ({key}): {n}, действующей отметки нет.', same: 'Прошлые вердикты сети по этому адресу совпадают с этим отчётом.', diffTitle: 'Прошлый вердикт сети отличается', diff: 'Прошлый вердикт сети по этому адресу отличается от этого отчёта: код или правила могли измениться.', note: 'Написано небольшой моделью в браузере и фиксированными шаблонами, а не языковой моделью.', keys: { fingerprint: 'отпечаток кода', address: 'адрес', code: 'код' }, should: ['Прежде чем доверять контракту, проверьте, кто управляет ролью owner или admin.', 'Одобряйте (approve) только нужную сумму и отзывайте ненужные одобрения.', 'Если торгуете, сначала попробуйте продать очень малую сумму.'], noAnswer: 'Модель в браузере не отвечает на свободные вопросы. Вот записи контекста, ближайшие к вопросу.', nothing: 'Модель в браузере не нашла в контексте ничего об этом.' },
  vi: { found: 'Dưới đây là {n} phát hiện của quy tắc kèm bằng chứng.', ml: 'Mô hình đã học (đã đối chiếu với sổ đăng ký trên chuỗi và chạy trong trình duyệt này) ước tính rủi ro {p}%.', mlTitle: 'Điểm của mô hình đã học', mlDetail: 'Ước tính thống kê {p}%; tín hiệu mạnh nhất: {f}.', flagTitle: 'Cờ trên chuỗi', flag: 'ThreatRegistry của ZETAPHY có cờ còn hiệu lực với {key} này: {reason}.', votes: 'Số phiếu của runner về {key} này: {n}, chưa có cờ hiệu lực.', same: 'Các phán quyết trước đây của mạng về địa chỉ này khớp với báo cáo này.', diffTitle: 'Phán quyết trước đây khác', diff: 'Một phán quyết trước đây của mạng về địa chỉ này khác với báo cáo này: mã hoặc quy tắc có thể đã thay đổi.', note: 'Được viết bởi một mô hình nhỏ trong trình duyệt và mẫu cố định, không phải mô hình ngôn ngữ.', keys: { fingerprint: 'dấu vân tay mã', address: 'địa chỉ', code: 'mã' }, should: ['Kiểm tra ai nắm quyền owner hoặc admin trước khi tin hợp đồng này.', 'Chỉ approve số lượng cần dùng và thu hồi các approve không còn dùng.', 'Nếu giao dịch, hãy thử bán một lượng rất nhỏ trước.'], noAnswer: 'Mô hình trong trình duyệt không trả lời câu hỏi tự do. Đây là các bản ghi trong ngữ cảnh gần với câu hỏi nhất.', nothing: 'Mô hình trong trình duyệt không tìm thấy thông tin về điều đó trong ngữ cảnh.' },
  id: { found: '{n} temuan aturan tercantum di bawah beserta buktinya.', ml: 'Model terlatih (dicek terhadap registri on-chain dan dijalankan di peramban ini) memperkirakan risiko {p}%.', mlTitle: 'Skor model terlatih', mlDetail: 'Perkiraan statistik {p}%; sinyal terkuat: {f}.', flagTitle: 'Tanda on-chain', flag: 'ThreatRegistry ZETAPHY memiliki tanda aktif pada {key} ini: {reason}.', votes: 'Suara runner pada {key} ini: {n}, belum ada tanda aktif.', same: 'Putusan jaringan sebelumnya untuk alamat ini sama dengan laporan ini.', diffTitle: 'Putusan jaringan sebelumnya berbeda', diff: 'Putusan jaringan sebelumnya untuk alamat ini berbeda dari laporan ini: kode atau aturan mungkin sudah berubah.', note: 'Ditulis oleh model kecil di peramban dan templat tetap, bukan model bahasa.', keys: { fingerprint: 'sidik jari kode', address: 'alamat', code: 'kode' }, should: ['Periksa siapa yang memegang peran owner atau admin sebelum memercayai kontrak ini.', 'Setujui (approve) hanya jumlah yang perlu, dan cabut persetujuan yang tidak dipakai.', 'Jika berdagang, coba jual jumlah sangat kecil dulu.'], noAnswer: 'Model di peramban tidak dapat menjawab pertanyaan bebas. Ini catatan konteks yang paling dekat dengan pertanyaan Anda.', nothing: 'Model di peramban tidak menemukan apa pun tentang itu di konteks.' },
};
export const ENGINE_TEXT = K;
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/** Runtimes this engine can run, by the manifest's "runtime" field. */
export const RUNTIMES = ['neuro-ml-gbdt/1'];

/**
 * Bytes delivered by the verified loader -> an engine.
 * engine.report({ctx, report, lang, code}) -> analyst report object (REPORT_SCHEMA)
 * engine.answer({ctx, report, lang, question}) -> {answer, confidence, evidence}
 */
export function loadEngine(bytes, manifest) {
  if (!RUNTIMES.includes(manifest?.runtime)) throw new Error(`unknown runtime ${String(manifest?.runtime).slice(0, 40)}`);
  const model = checkModel(JSON.parse(new TextDecoder().decode(bytes)));
  const id = `${manifest.name}@${manifest.version} (${manifest.runtime}, in this browser)`;

  function report({ ctx, report: r, lang = 'en', code = null }) {
    const t = K[lang] ?? K.en;
    const L = LANGS[lang] ?? LANGS.en;
    const rulesLevel = r?.analysis?.rulesLevel ?? r?.analysis?.level ?? 'info';
    const lines = r?.analysis?.findings ? explain(r, lang).lines : [];
    const byId = new Map(lines.map((l) => [l.id, l.text]));
    // F<n> in the context follows the report's findings order
    const risks = (ctx.facts.findings ?? []).filter((f) => f.severity && !['info', 'good'].includes(f.severity)).slice(0, 6)
      .map((f) => ({ title: f.id, detail: byId.get(f.id) ?? f.id, evidence: [f.ev] }));
    const secondLook = [];
    const summary = [L.LEVEL?.[rulesLevel] ?? rulesLevel, fill(t.found, { n: risks.length })];
    let agreement = 'agrees';
    let s = null;
    try { s = r?.analysis ? scoreReport(model, r, { code, lang: lang === 'th' ? 'th' : 'en', top: 3 }) : null; } catch { s = null; }
    if (s) {
      ctx.evidence.add('ML'); // computed here, from the verified model
      const p = Math.round(s.p * 1000) / 10;
      summary.push(fill(t.ml, { p }));
      if (s.level && RANK[s.level] > RANK[rulesLevel]) agreement = 'more-concerned';
      secondLook.push({ title: t.mlTitle, detail: fill(t.mlDetail, { p, f: s.top.map((x) => x.label).join('; ') }), confidence: p >= 70 ? 'medium' : 'low', evidence: ['ML'] });
    }
    const oc = ctx.facts.onchain;
    for (const x of oc?.threatRegistry ?? []) {
      const key = t.keys[x.key] ?? x.key;
      if (x.flagged) {
        risks.push({ title: t.flagTitle, detail: fill(t.flag, { key, reason: L.REASON?.[x.reason] ?? x.reason }), evidence: [x.ev] });
        if (RANK[rulesLevel] < RANK.medium) agreement = 'more-concerned';
      } else if (x.votes) secondLook.push({ title: t.flagTitle, detail: fill(t.votes, { key, n: x.votes }), confidence: 'low', evidence: [x.ev] });
    }
    const pv = oc?.pastVerdicts ?? [];
    const diff = pv.filter((v) => v.sameAsThisReport === false);
    if (diff.length) secondLook.push({ title: t.diffTitle, detail: t.diff, confidence: 'low', evidence: diff.map((v) => v.ev) });
    else if (pv.some((v) => v.sameAsThisReport)) summary.push(t.same);
    summary.push(t.note);
    return { summary: summary.join(' '), agreement, risks, attackerCan: [], userShould: t.should, secondLook };
  }

  function answer({ ctx, lang = 'en', question = '' }) {
    const t = K[lang] ?? K.en;
    const words = String(question).toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 2);
    const hits = [];
    for (const f of ctx.facts.findings ?? []) if (words.some((w) => f.id.includes(w))) hits.push(f.ev);
    for (const x of ctx.facts.onchain?.threatRegistry ?? []) if (words.some((w) => /flag|threat|chain|registry|ธง|เชน/.test(w))) hits.push(x.ev);
    if (!hits.length) return { answer: t.nothing, confidence: 'low', evidence: [] };
    return { answer: t.noAnswer, confidence: 'low', evidence: [...new Set(hits)].slice(0, 6) };
  }

  return { id, runtime: manifest.runtime, report, answer };
}
