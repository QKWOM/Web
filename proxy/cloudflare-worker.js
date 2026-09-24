// 可选：数据源的中转代理（Cloudflare Worker）。
// 只有在线部署、且浏览器无法直接访问数据源（例如跨域被拦截）时才需要。
// 部署后，在 app.js 中：
//   - 把 "https://你的-worker.workers.dev/sparql" 加到 CONFIG.endpoints 的最前面
//   - 把 "https://你的-worker.workers.dev/openreview" 加到 CONFIG.openreview 的最前面

const ROUTES = [
  // [路径, 上游地址, Accept]
  ['/sparql', 'https://sparql.dblp.org/sparql', 'application/sparql-results+json'],
  ['/openreview/notes', 'https://api2.openreview.net/notes', 'application/json'],
  ['/openreview/groups', 'https://api2.openreview.net/groups', 'application/json'],
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const route = ROUTES.find(([path]) => url.pathname === path);
    if (request.method !== 'GET' || !route) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    const [, upstreamUrl, accept] = route;
    const upstream = await fetch(`${upstreamUrl}${url.search}`, {
      headers: { Accept: accept },
      cf: { cacheTtl: 86400, cacheEverything: true }, // 相同查询缓存一天，减轻数据源的压力
    });
    const response = new Response(upstream.body, upstream);
    for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
    return response;
  },
};
