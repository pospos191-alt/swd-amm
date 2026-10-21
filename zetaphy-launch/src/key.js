// The deployer key. Never taken on the command line, never printed or logged.
//   --key-file <file>            a plain 0x… key (64 hex), or an Ethereum keystore JSON (ZETAPHY_PASSPHRASE)
//   ZETAPHY_DEPLOYER_KEY_FILE    the same, from the environment
//   ZETAPHY_DEPLOYER_KEY         the key itself in the environment (testnet only; CI should prefer a file)
//   default                      $ZETAPHY_HOME/worker.key (zetaphy-network/src/keys.js), ZETAPHY_HOME = ~/.zetaphy
// The tools this launcher runs (zetaphy-network/cli.js, zetaphy-nft/cli.js, zetaphy-dex)
// all read a key file, so the key is copied into one private temp folder (0700, file 0600),
// removed when the launcher exits.

import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Wallet } from 'ethers';

export const KEY_ENV = 'ZETAPHY_DEPLOYER_KEY';

function fromText(text, where) {
  const s = String(text).trim();
  if (s.startsWith('{')) {
    const pass = process.env.ZETAPHY_PASSPHRASE;
    if (!pass) throw new Error(`${where} is an encrypted keystore: set ZETAPHY_PASSPHRASE`);
    try { return Wallet.fromEncryptedJsonSync(s, pass).privateKey; } catch { throw new Error('wrong ZETAPHY_PASSPHRASE'); }
  }
  // Never echo the text: only say what shape was expected.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) throw new Error(`${where} does not hold a private key (0x + 64 hex digits, or a keystore JSON)`);
  return s.startsWith('0x') ? s : '0x' + s;
}

/** { privateKey, source } from the options and environment. `source` names where it came from, never the key. */
export function readDeployerKey(opt = {}, env = process.env) {
  const file = opt['key-file'] ?? env.ZETAPHY_DEPLOYER_KEY_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`no key file at ${file}`);
    const st = statSync(file);
    if (process.platform !== 'win32' && (st.mode & 0o077)) throw new Error(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
    return { privateKey: fromText(readFileSync(file, 'utf8'), file), source: file };
  }
  if (env[KEY_ENV]) return { privateKey: fromText(env[KEY_ENV], `env ${KEY_ENV}`), source: `env ${KEY_ENV}` };
  const def = join(env.ZETAPHY_HOME ?? join(homedir(), '.zetaphy'), 'worker.key');
  for (const f of [def, def + '.json']) if (existsSync(f)) return { privateKey: fromText(readFileSync(f, 'utf8'), f), source: f };
  throw new Error(`no deployer key: pass --key-file <file> (chmod 600), or set ${KEY_ENV}_FILE / ${KEY_ENV}; never on the command line`);
}

/**
 * A private temp folder for the child tools: <dir>/deployer.key (for zetaphy-dex / zetaphy-nft)
 * and <dir>/home/worker.key (ZETAPHY_HOME for zetaphy-network/cli.js). cleanup() removes it.
 */
export function keyFolder(privateKey) {
  const dir = mkdtempSync(join(tmpdir(), 'zetaphy-launch-'));
  chmodSync(dir, 0o700);
  const home = join(dir, 'home');
  writeFileSync(join(dir, 'deployer.key'), privateKey + '\n', { mode: 0o600 });
  // zetaphy-network keeps its config next to the key: ZETAPHY_HOME.
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'worker.key'), privateKey + '\n', { mode: 0o600 });
  let gone = false;
  const cleanup = () => { if (!gone) { gone = true; rmSync(dir, { recursive: true, force: true }); } };
  return { dir, keyFile: join(dir, 'deployer.key'), home, cleanup };
}
