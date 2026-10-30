// Neuro ML: fixed path checks next to the learned model ("rules + ML" ensemble on the ml/ side).
//
// A learned model only knows the traps it was trained on: a new kind of trap with no example in the data
// (the leave-one-family-out runs in ml/metrics.json) scores low however clear the code is. These checks
// read the per-function path features (ml/flow.js) and say plainly what an owner can do, the same powers
// Neuro's rules already rate when the functions carry their usual names (can-mint, can-change-fee,
// owner-renounced), but found by following the code, so renaming a function or hiding the owner does not
// hide them. Like the model they can only RAISE the shown level (ml/combine.js), and never past "low"
// for an official issuer or a registered template. They are not part of the network verdict, the
// reportHash or Neuro's skill id (ml/ is outside src/).

const L = (en, th) => ({ en, th });

/** Each check: a path feature that must be > 0, the level it raises to, and what to tell the user. */
export const CHECKS = Object.freeze([
  { id: 'owner-moves-tokens', feature: 'x_priv_xfer_free', level: 'medium', label: L('The owner can move or create tokens with no fixed limit (a function only the owner can call emits Transfer).', 'เจ้าของย้ายหรือสร้างเหรียญได้โดยไม่มีเพดานตายตัว (มีฟังก์ชันที่เจ้าของเท่านั้นเรียกได้และปล่อย Transfer)') },
  { id: 'owner-sets-any-fee', feature: 'x_fee_owner_free', level: 'medium', label: L('The owner can set the transfer fee to any value: there is no cap in the code.', 'เจ้าของตั้งค่าธรรมเนียมการโอนเป็นค่าใดก็ได้ ในโค้ดไม่มีเพดาน') },
  { id: 'hidden-owner', feature: 'x_fake_renounce', level: 'medium', label: L('owner() says nobody owns it, yet some functions still answer to one address only.', 'owner() บอกว่าไม่มีเจ้าของ แต่ยังมีฟังก์ชันที่ตอบเฉพาะที่อยู่เดียว') },
]);

const RANK = { info: 0, good: 0, low: 1, medium: 2, high: 3 };

/** Checks that fire on named features ({name: value}). */
export function runChecks(features, lang = 'en') {
  const out = [];
  for (const c of CHECKS) if ((features?.[c.feature] ?? 0) > 0) out.push({ id: c.id, level: c.level, label: c.label[lang] ?? c.label.en });
  return out;
}

/** Highest level among fired checks, as 0..3. */
export const checksRank = (features) => runChecks(features).reduce((m, c) => Math.max(m, RANK[c.level] ?? 0), 0);
