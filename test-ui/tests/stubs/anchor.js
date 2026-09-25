// Minimal stand-in for @coral-xyz/anchor, used ONLY by test-ui/tests/smoke.mjs
// (see stubs/web3.js). Program accounts always come back empty and every
// .rpc() rejects, so the page behaves like a wallet-less visit to a
// cluster with no pools.
export class BN { constructor(v,base){ this.v = typeof v==="bigint"?v: (v&&v.v!==undefined? v.v : BigInt(typeof v==="string"&&base===16? "0x"+v : (v??0).toString())); }
  toString(b){return this.v.toString(b||10);} toNumber(){return Number(this.v);} add(o){return new BN(this.v+new BN(o).v);} sub(o){return new BN(this.v-new BN(o).v);} mul(o){return new BN(this.v*new BN(o).v);} div(o){return new BN(this.v/new BN(o).v);}
  cmp(o){const x=new BN(o).v;return this.v<x?-1:this.v>x?1:0;} lt(o){return this.cmp(o)<0;} gt(o){return this.cmp(o)>0;} lte(o){return this.cmp(o)<=0;} gte(o){return this.cmp(o)>=0;} eq(o){return this.cmp(o)===0;} isZero(){return this.v===0n;} isNeg(){return this.v<0n;}
  toArrayLike(T,e,len){return new Uint8Array(len||8);} toTwos(){return this;} fromTwos(){return this;} abs(){return new BN(this.v<0n?-this.v:this.v);} }
const acct = () => ({ all: async()=>[], fetch: async()=>{throw new Error("Account does not exist");}, fetchNullable: async()=>null, fetchMultiple: async(k)=>k.map(()=>null) });
export class AnchorProvider { constructor(c,w,o){this.connection=c;this.wallet=w;this.opts=o;} static defaultOptions(){return {};} }
export function setProvider(){} export function getProvider(){return null;}
export class BorshCoder { constructor(){ this.events={decode:()=>null}; this.accounts={decode:()=>null}; this.instruction={decode:()=>null}; } }
export class EventParser { constructor(){} *parseLogs(){} }
export class AnchorError { static parse(){return null;} }
export class Program { constructor(idl,provider){ this.idl=idl; this.provider=provider;
  this.programId = { toBase58:()=>idl.address, equals:()=>false, toBytes:()=>new Uint8Array(32), toBuffer:()=>new Uint8Array(32) };
  this.account = new Proxy({}, {get:()=>acct()}); this.coder = new BorshCoder(); 
  const chain = new Proxy(function(){}, {get:(t,p)=> p==="then"?undefined: (p==="rpc"||p==="instruction"||p==="transaction"||p==="simulate")? async()=>{throw new Error("stub")}: ()=>chain, apply:()=>chain});
  this.methods = new Proxy({}, {get:()=>()=>chain}); }
  addEventListener(){return 1;} removeEventListener(){} }
export const utils = { bytes: { utf8: { encode:(s)=>new TextEncoder().encode(s) }, bs58: {} } };
export const web3 = {};
