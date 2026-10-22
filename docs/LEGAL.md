**English** | [ภาษาไทย](LEGAL.th.md)

This is a translation. If it differs from the Thai version, the Thai version prevails.

# Neuro ZETAPHY: wording, replies/correction requests, and questions to ask a lawyer

> **This document is not legal advice.** The author is not a lawyer. This document explains how the system is designed to reduce risk
> and prepares questions so that a lawyer can be consulted faster and more cheaply. Before opening it to general use, a lawyer licensed in Thailand should review this document,
> the text on the web pages, and the wording in all 7 languages
>
> English summary at the end.

Fields that the project owner must fill in themselves are marked `[ ... ]`. Do not publish while they are still blank

---

## 1. Why this document is needed

Neuro reads token contracts and states what rights the contract owner has. The results are shown on the web page, in the CLI, and runners
can vote to flag code in `ThreatRegistry`. If the wording were to judge that a project is "deceptive" or a "scam", that project's owner might sue for defamation,
for example under the Criminal Code, sections 326 and 328 (defamation by publication), and the Computer Crimes Act, section 14
(the exceptions to the offence and the main defences, such as expressing an opinion in good faith (section 329) and proving that a statement is true and in the public interest (section 330),
need a lawyer to explain how far they apply in this case)

Neuro's approach is therefore: **state only facts about code that anyone can re-check, and do not judge anyone's intent or wrongdoing**

## 2. What Neuro states, and what it does not

**Neuro states (facts about code, re-checkable):**
- What rights the code or the on-chain settings give, e.g. "the owner can mint unlimited new tokens", "can block certain wallets", "can upgrade the code"
- Results of simulated trading, e.g. "in a simulated buy/sell, the token could be bought but not sold", together with the limitations of the test
- Code similarity, e.g. "this code is 85% similar to code that Neuro runners have flagged (fingerprint fp1:…)"
- Whether this address is the registered address of an official token
- Third-party labels (e.g. tonapi.io), stating clearly that they are that party's labels and not Neuro's findings
- A risk level (high/medium/low), which means the **risk to users** who hold or will buy the token, not the degree of anyone's wrongdoing

**Neuro does not state:**
- The intent, good faith, or wrongdoing of any person, team, or project
- Who the real owner of an on-chain address is
- Whether to buy or sell (it is not investment advice)
- Token names and symbols are text written by the contract's creator; Neuro shows them "as written in the contract" and does not endorse them
  (names are filtered of control characters and shown as plain text, not HTML)

**In practice (already done in the code):**
- The text in all 7 languages (`zetaphy-neuro/src/lang/*.js`) does not use the words scam, deceptive, fraud, rug, drainer, phishing, honeypot
  as labels for projects. `test/i18n.test.js` checks every message in every language
- `ThreatRegistry` categories (Drainer, Honeypot, HiddenMint, FakeToken, Phishing, Other) are shown as descriptions of code behaviour,
  e.g. "can be bought but not sold", "can move funds out of a wallet" (`REASON` in each language file)
- Every report (web and CLI) has a disclaimer in 7 languages:
  "This information is the result of automated, re-checkable code analysis. It is not an accusation against any person or project, and it is not investment advice. The contract owner may reply or request a correction."
  with a link to the reply procedure (`zetaphy-neuro/web/legal.html`)
- Every report has evidence for re-checking: a report ID (`reportHash`), a verdict ID (verdict; only what the rules decide), and the command
  `node cli.js <chain> <address> --lang <language>`, which anyone can run and compare the IDs

## 3. Reply and correction policy (right of reply)

### Who may request
The owner or administrator of the contract (provable by signing a message from the owner/administrator address on chain), or anyone who believes that a finding is factually wrong

### Channels
1. **Off-chain (available now):** email `[insert the project owner's contact email]` or open an issue in the project's code repository
2. **On-chain (coming):** a reply and appeal channel in `ThreatRegistry` that lets contract owners record a reply alongside a flag
   and ask runners to re-check. It is not in the current contract yet; it will be announced when ready
   (for now, a flag can be cleared by a vote of runners under the rules of `ThreatRegistry`; see `zetaphy-network/README.md`)

### What to send
- The chain, the contract address, and the report ID or verdict ID you saw
- The point you believe is incorrect, and why
- Evidence, e.g. verified source code, a transaction renouncing ownership, settings that have been changed
- Contact details for the reply

### Timeframes (recommended defaults; the project owner may adjust them; have a lawyer review them before announcing)

| Stage | Within | What is done |
|---|---|---|
| Acknowledge | 3 business days | Confirm receipt and give a case number |
| Re-check | 14 days | Re-run the check with the same command, read the evidence, and give the result in writing |
| Correct | As soon as an error is confirmed | Wrong rule: fix the rule (as a new skill that runners must vote in) / code changed: a new report reflects it by itself when re-checked / wrong flag: propose that runners vote to clear the flag |
| Notify | Once corrected | Notify the requester and record it in the project's change history |

If a letter arrives from a lawyer or a government agency, forward it to the project's lawyer immediately. Do not reply yourself without consulting them

### Keeping records
Keep the requests, evidence, re-check results, and what was corrected, for at least the period the lawyer recommends. These records help show that things were done in good faith and that there is a correction process

## 4. Data handling

- **Neuro (web and CLI):** reads only public blockchain data through public RPCs. The user's browser calls the RPC itself.
  The contract addresses checked are not sent to the project's servers. It does not ask to connect a wallet and does not send transactions
- **Usage counter (`zetaphy-neuro/api/usage.js`):** does not store IPs, browsers, or contract addresses. It stores an HMAC of (month, IP, browser)
  in a HyperLogLog, which stores only an approximate count. It does not count when the browser sets Do Not Track or Global Privacy Control
- **On the ZETAPHY chain (`ThreatRegistry`, `ThreatReports`):** code fingerprints, code hashes, flagged addresses, voters' addresses, and the `note`
  of reports (no more than 280 bytes) are public data and **cannot be deleted**. Do not put people's names, emails, phone numbers, or personal data in a `note`.
  Clearing a flag can change its status, but the on-chain history remains
- Wallet addresses may count as personal data under the PDPA if they can be linked to a person (see question 5 below)
- Reply/correction requests by email: used only to handle the matter, and kept only as much as necessary

## 5. Questions to ask a lawyer (specific to this project)

Bring this document, 2–3 sample reports (web page and CLI), and the list of wording in `zetaphy-neuro/src/lang/th.js`;
the consultation will take less time

**Defamation and wording**
1. Do automated findings that state facts about code (e.g. "in a simulated buy/sell, the token could be bought but not sold") risk defamation under Criminal Code ss.326/328?
   What happens if a simulation result is wrong because of the limitations of the test?
2. How far do the defences under s.329 and s.330 apply to automated, re-checkable findings, and what evidence should we keep to show good faith?
3. Are the 7-language disclaimer and the existing reply procedure sufficient? Which wording should be changed? (have the lawyer read the whole of `th.js`)
4. Does showing third-party labels (tonapi.io) and stating "this is not the registered address of the USDT/USDC token" (naming the issuer)
   carry defamation or trademark risk?

**Computer Crimes Act and platform liability**

5. Do findings shown by Neuro, or flags published by runners, fall under s.14? Is the project, as a service provider, liable under s.15?
   What kind of notice-and-takedown procedure is required, given that on-chain data cannot be deleted?
6. Are flags voted by runners/the DAO in `ThreatRegistry` considered acts of the project owner? Who is liable if a flag is wrong?
7. The bridge monitor (the marker key) places on-chain marks on addresses that call contracts the monitor watches (the list is kept secret), causing that address's bridge transfers to be held until governance clears them,
   and `ThreatReports` lets anyone report with a public `note`.
   What risks does this carry (both defamation and personal data)?

**Terms of use and jurisdiction**

8. Are terms of use and a privacy policy required on the web pages? What should they contain?
9. Users are in many countries (text in 7 languages). Which country's law applies? How should jurisdiction be specified?
10. How far do an open-source licence and a "no warranty" statement help? Should it operate as an individual, a company, or a foundation?

**Personal data (PDPA)**

11. Are wallet addresses personal data under the Personal Data Protection Act B.E. 2562 (2019)? When they are stored permanently on a chain where they cannot be deleted,
    what must be done (legal basis, notice, right to erasure)?
12. Does a usage counter that uses an HMAC of the IP count as collecting personal data?

**The ZETAPHY token, rewards, and the SEC**

13. Do the ZETAPHY token, runner rewards, job fees (NeuroJobs), and deposits count as digital assets or digital tokens under
    the Emergency Decree on Digital Asset Businesses B.E. 2561 (2018)? Is a licence or any filing with the Office of the SEC required?
14. What issues arise from distributing or selling the token, and from sharing report fees with voters (`ThreatReports`), including tax?

**Running validator nodes and the bridge**

15. What duties or liabilities come with running validators/nodes and letting others run Neuro as runners?
16. The bridge feature that **holds** transfers from flagged senders or contracts (`BridgeAirlock`, `ThreatHeld`): if it holds the funds of someone who has done nothing wrong,
    who is liable? What procedure and timeframe for releasing funds are needed?
17. If a government agency requests data or asks for funds to be held/released, what must be done?

## 6. Free or low-cost legal help in Thailand

Below are real, well-known organisations. **No phone numbers or websites are included; look up the current contact details from official sources yourself**
and check their intake conditions (some accept only people on low incomes, or give only initial advice)

- **The Legal Aid Office for the People, Lawyers Council of Thailand under the Royal Patronage** gives legal advice and assistance with cases.
  It has a central office and offices in the provinces
- **Legal clinics or legal advice centres of university law faculties**: many universities offer advice to the public.
  Ask a nearby law faculty whether it currently offers the service
- **The Rights and Liberties Protection Department, Ministry of Justice** gives legal advice and assistance to the public
  (the Ministry of Justice also has provincial justice offices in many provinces)

Tips to get the most out of a consultation: send this document in advance, pick the 3–5 most important questions from section 5, ask about one issue at a time,
and ask the lawyer to say which issues need a specialist lawyer (e.g. securities/digital assets, or PDPA)

---

# English summary

**This is not legal advice.** The authors are not lawyers. This document explains how Neuro is designed to reduce
defamation risk and prepares the project owner to consult a licensed Thai lawyer quickly and cheaply. Have a lawyer
review it, the web page text and all 7 languages before wide public use. Placeholders in `[ ... ]` must be filled
in by the owner before publishing.

- **What Neuro states:** verifiable facts about code and on-chain settings ("the owner can mint unlimited new tokens",
  "in a simulated buy/sell, the token could be bought but not sold", "this code is X% similar to code that Neuro
  runners flagged (fingerprint fp1:…)"), each with a report ID, a rules-only verdict ID and the CLI command that
  reproduces it. Risk levels mean risk to the user. Token names and symbols are shown as written in the contract.
- **What Neuro does not state:** intent, guilt or wrongdoing of any person or project; who owns an address;
  investment advice. User-facing text in all 7 languages avoids "scam", "fraud", "rug", "drainer", "phishing",
  "honeypot" as labels (enforced by `zetaphy-neuro/test/i18n.test.js`). ThreatRegistry categories are shown as neutral
  descriptions of code behaviour.
- **Disclaimer** on every web report and CLI output, in 7 languages, linking to the correction process
  (`zetaphy-neuro/web/legal.html`).
- **Right of reply / correction:** off-chain contact `[project owner's contact email]` or a repository issue now;
  an on-chain response and appeal in the ThreatRegistry is coming. Suggested timeline: acknowledge within 3 business
  days, re-check within 14 days, fix as soon as an error is confirmed (rule fix = new skill id voted in by runners;
  wrong flag = runner vote to clear), and keep records.
- **Data:** Neuro reads public chain data only; the web page calls public RPCs from the user's browser; the usage
  counter stores no IPs (HMAC into HyperLogLog). On-chain flags, voter addresses and report notes are public and
  permanent: never put personal data in a report note.
- **Questions for a lawyer** (section 5): defamation exposure of automated findings (Criminal Code ss.326, 328, and
  the defences in ss.329, 330); Computer Crimes Act s.14 and s.15 platform liability for runner-published flags;
  whether DAO/runner flags are attributed to the project owner; terms of use, disclaimers and jurisdiction; PDPA
  (wallet addresses as personal data, permanent on-chain records); SEC Thailand / digital asset rules for the
  ZETAPHY token, runner rewards and report fees; running validators and nodes; liability for the bridge "hold"
  feature; the bridge monitor's marker key marking (on-chain, public) the callers of contracts it watches from a private list,
  which holds their bridge transfers until governance lifts the mark.
- **Free and low-cost legal help in Thailand** (verify current contact details yourself; none are given here):
  the Lawyers Council of Thailand's legal aid office; legal clinics at university law faculties; the Ministry of
  Justice's Rights and Liberties Protection Department.
