// 可选：dblp SPARQL 查询服务的中转代理（Cloudflare Worker）。
// 只有在线部署、且浏览器无法直接访问 dblp 查询服务（例如跨域被拦截）时才需要。
// 部署后，把 "https://你的-worker.workers.dev/sparql" 加到 app.js 中 CONFIG.endpoints 的最前面。

const UPSTREAM = 'https://sparql.dblp.org/sparql';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/sparql') {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    const upstream = await fetch(`${UPSTREAM}${url.search}`, {
      headers: { Accept: 'application/sparql-results+json' },
      cf: { cacheTtl: 86400, cacheEverything: true }, // 相同查询缓存一天，减轻 dblp 压力
    });
    const response = new Response(upstream.body, upstream);
    for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
    return response;
  },
};
