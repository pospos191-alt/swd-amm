// Minimal stand-in for @solana/web3.js, used ONLY by test-ui/tests/smoke.mjs.
// The smoke test serves these instead of the real esm.sh modules so it can
// load the page with no network and no validator. It has just enough
// surface (base58 PublicKey, a Connection that returns empty results) for
// the page's startup code to run — it is not a Solana implementation.
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(bytes){let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let s="";while(n>0n){s=ALPH[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b===0)s="1"+s;else break;}return s||"1";}
function b58dec(str){let n=0n;for(const c of str){const i=ALPH.indexOf(c);if(i<0)throw new Error("Invalid public key input");n=n*58n+BigInt(i);}const out=[];while(n>0n){out.unshift(Number(n%256n));n/=256n;}for(const c of str){if(c==="1")out.unshift(0);else break;}while(out.length<32)out.unshift(0);return new Uint8Array(out.slice(-32));}
export class PublicKey {
  constructor(v){ if(v instanceof PublicKey){this._b=v._b;} else if(typeof v==="string"){ if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) throw new Error("Invalid public key input"); this._b=b58dec(v);} else if(v&&v.length!==undefined){this._b=Uint8Array.from(v);} else throw new Error("Invalid public key input"); }
  toBase58(){return b58enc(this._b);} toString(){return this.toBase58();} toJSON(){return this.toBase58();}
  toBytes(){return this._b;} toBuffer(){return this._b;} equals(o){return o&&o.toBase58&&o.toBase58()===this.toBase58();}
  static findProgramAddressSync(seeds, pid){ let h=0; for(const s of seeds){for(const b of (typeof s==="string"?new TextEncoder().encode(s):s)) h=(h*31+b)>>>0;} const b=new Uint8Array(32); for(let i=0;i<32;i++){h=(h*1103515245+12345)>>>0;b[i]=h&255;} return [new PublicKey(b),255]; }
  static async findProgramAddress(s,p){return PublicKey.findProgramAddressSync(s,p);}
  static get default(){return new PublicKey(new Uint8Array(32));}
  static isOnCurve(){return true;}
}
export class Keypair { constructor(){const b=new Uint8Array(32);crypto.getRandomValues(b);this.publicKey=new PublicKey(b);this.secretKey=new Uint8Array(64);} static generate(){return new Keypair();} static fromSecretKey(){return new Keypair();} static fromSeed(){return new Keypair();} }
export class Transaction { constructor(){this.instructions=[];this.signatures=[];} add(...i){this.instructions.push(...i);return this;} serialize(){return new Uint8Array(0);} partialSign(){} }
export class TransactionInstruction { constructor(o){Object.assign(this,o);} }
export const SystemProgram = { programId: new PublicKey(new Uint8Array(32)), createAccount:()=>({}), transfer:()=>({}) };
export const ComputeBudgetProgram = { setComputeUnitPrice:()=>({}), setComputeUnitLimit:()=>({}) };
export const LAMPORTS_PER_SOL = 1e9;
export const SYSVAR_RENT_PUBKEY = new PublicKey(new Uint8Array(32).fill(1));
export function clusterApiUrl(c){return "https://api."+c+".solana.com";}
export class Connection {
  constructor(url){this.rpcEndpoint=url;}
  async getAccountInfo(){return null;} async getMultipleAccountsInfo(k){return k.map(()=>null);} async getBalance(){return globalThis.__smokeLamports ?? 0;}
  async getSignaturesForAddress(){return [];} async getProgramAccounts(){return [];} async getParsedTokenAccountsByOwner(){return {value:[]};}
  async getLatestBlockhash(){return {blockhash:"1".repeat(32),lastValidBlockHeight:1};} async getTransaction(){return null;} async getTransactions(k){return k.map(()=>null);}
  async getParsedTransactions(k){return k.map(()=>null);} async getSlot(){return 1;} async getBlockTime(){return 0;} async getTokenAccountBalance(){return {value:{amount:"0",uiAmount:0,decimals:0}};}
  async getMinimumBalanceForRentExemption(){return 0;} async getVersion(){return {"solana-core":"x"};} async getEpochInfo(){return {};}
  onLogs(){return 1;} removeOnLogsListener(){} onAccountChange(){return 1;} removeAccountChangeListener(){}
}
