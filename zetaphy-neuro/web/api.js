// Where this page's API is. On Neuro's own site: the same origin. Inside the ZETAPHY
// hub (served under /neuro/web/): Neuro's site directly, so each visitor is counted
// and rate-limited by their own address (server/http.js), not by the hub's proxy.
const HUB_HOSTS = ['app.sawasdeecoin.com', 'zetaphy-hub.vercel.app'];
const NEURO = 'https://neuro.sawasdeecoin.com';
export const api = (path) => (HUB_HOSTS.includes(location.host) ? NEURO : '') + path;
