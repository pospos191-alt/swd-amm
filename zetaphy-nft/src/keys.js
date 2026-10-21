// The deployer's key, as zetaphy-network/src/keys.js keeps the runner's: a file
// on this machine, never sent anywhere and never printed.
//   --key-file <path> / ZETAPHY_KEY_FILE   a plain 0x… key file, or an Ethereum
//                                          keystore JSON (needs ZETAPHY_PASSPHRASE)
//   default: $ZETAPHY_HOME/deployer.key (or deployer.key.json), ZETAPHY_HOME = ~/.zetaphy
//   ZETAPHY_PRIVATE_KEY                     the key itself in the environment (CI, testnet only)
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { Wallet } from 'ethers';

export const HOME = process.env.ZETAPHY_HOME ?? join(os.homedir(), '.zetaphy');
export const defaultKeyFile = () => process.env.ZETAPHY_KEY_FILE || join(HOME, 'deployer.key');

/** lstat that answers null for a missing path (a dangling symlink still answers). */
const lstat = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

/** chmod 600 a key file we read; never through a symlink (that would change its target). */
function tighten(file) {
  const st = lstat(file);
  if (process.platform !== 'win32' && st && !st.isSymbolicLink() && (st.mode & 0o077)) chmodSync(file, 0o600);
}

function fromText(text, file) {
  const s = text.trim();
  if (s.startsWith('{')) {
    const pass = process.env.ZETAPHY_PASSPHRASE;
    if (!pass) throw new Error(`${file} is encrypted: set ZETAPHY_PASSPHRASE`);
    try { return Wallet.fromEncryptedJsonSync(s, pass); } catch { throw new Error('wrong ZETAPHY_PASSPHRASE'); }
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) throw new Error(`${file} is not a key file (0x + 64 hex digits, or a keystore JSON)`);
  return new Wallet(s.startsWith('0x') ? s : '0x' + s);
}

/** The deployer wallet (not connected). Throws with what to do when there is none. */
export function loadKey(file) {
  if (!file && process.env.ZETAPHY_PRIVATE_KEY) return { wallet: fromText(process.env.ZETAPHY_PRIVATE_KEY, 'ZETAPHY_PRIVATE_KEY'), source: 'env ZETAPHY_PRIVATE_KEY' };
  const f = file || defaultKeyFile();
  for (const candidate of [f, f + '.json']) {
    if (existsSync(candidate)) {
      tighten(candidate);
      return { wallet: fromText(readFileSync(candidate, 'utf8'), candidate), source: candidate };
    }
  }
  throw new Error(`no key at ${f}: create one with \`node cli.js key new\` (then fund its address), or pass --key-file`);
}

/** Makes a new key file (plain, or a keystore when ZETAPHY_PASSPHRASE is set). Refuses to overwrite. */
/** A symlink at the target (even a dangling one) is refused, and the file is created
 *  with O_CREAT|O_EXCL ('wx'): an existing path, or one swapped in meanwhile, makes it
 *  fail instead of writing the key wherever the link points. */
export function newKey(file) {
  const f = file || defaultKeyFile();
  const pass = process.env.ZETAPHY_PASSPHRASE;
  const target = pass ? f + '.json' : f;
  for (const p of [f, f + '.json']) {
    const st = lstat(p);
    if (st?.isSymbolicLink()) throw new Error(`${p} is a symbolic link: refusing to write a key through it`);
    if (st) throw new Error(`${p} already exists`);
  }
  const w = Wallet.createRandom();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(target, (pass ? w.encryptSync(pass) : w.privateKey) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${target} already exists (or is a link): not overwritten`);
    throw e;
  }
  return { address: w.address, file: target, encrypted: !!pass };
}
