// A stand-in for RTCPeerConnection in Node tests: offer/answer SDP strings
// carry an id; when the offerer sets the answer, both sides get connected
// in-memory data channels (ai/browser/p2p.js memoryPair). Enough for
// ai/browser/discovery.js (the real WebRTC path is tested in Chromium).
import { memoryPair } from '../../ai/browser/p2p.js';

export function fakeRTC() {
  const registry = new Map(); // sdp id -> pc
  let n = 0;
  class FakeChannel {
    constructor(label) { this.label = label; this.readyState = 'connecting'; this.binaryType = 'arraybuffer'; this.ls = { open: new Set(), close: new Set(), message: new Set(), error: new Set() }; this.inner = null; }
    addEventListener(t, f) { this.ls[t]?.add(f); }
    removeEventListener(t, f) { this.ls[t]?.delete(f); }
    get bufferedAmount() { return 0; }
    send(d) { if (this.readyState !== 'open') throw new Error('not open'); this.inner.send(d); }
    close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; for (const f of this.ls.close) f({}); }
    _attach(inner) {
      this.inner = inner;
      inner.addEventListener('message', (e) => { for (const f of this.ls.message) f(e); });
      this.readyState = 'open';
      for (const f of this.ls.open) f({});
    }
  }
  class FakePC {
    constructor() { this.id = `fake-${++n}`; this.ls = new Map(); this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.localDescription = null; this.remoteDescription = null; this.dc = null; registry.set(this.id, this); }
    addEventListener(t, f) { if (!this.ls.has(t)) this.ls.set(t, new Set()); this.ls.get(t).add(f); }
    emit(t, e) { for (const f of this.ls.get(t) ?? []) f(e); }
    createDataChannel(label) { this.dc = new FakeChannel(label); return this.dc; }
    async createOffer() { return { type: 'offer', sdp: `v=0 fake ${this.id}` }; }
    async createAnswer() { return { type: 'answer', sdp: `v=0 fake ${this.id}` }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) {
      this.remoteDescription = d;
      if (d.type !== 'answer') return;
      const other = registry.get(d.sdp.split(' ').pop());
      if (!other || this.connectionState === 'closed' || other.connectionState === 'closed') return;
      const [a, b] = memoryPair();
      const theirs = new FakeChannel(this.dc.label);
      this.peer = other; other.peer = this; other.dc = theirs;
      setTimeout(() => {
        if (this.connectionState === 'closed' || other.connectionState === 'closed') return;
        this.connectionState = other.connectionState = 'connected';
        this.dc._attach(a);
        theirs._attach(b);
        other.emit('datachannel', { channel: theirs });
      }, 0);
    }
    close() {
      if (this.connectionState === 'closed') return;
      this.connectionState = 'closed';
      this.dc?.close();
      this.emit('connectionstatechange', {});
      this.peer?.close(); // the other side notices, as with a real connection (after a delay there)
    }
  }
  return FakePC;
}
