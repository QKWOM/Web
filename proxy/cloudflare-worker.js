// 可选：dblp 中转代理（Cloudflare Worker）。
// 只有当浏览器无法直接访问 dblp（例如跨域被拦截）时才需要。
// 部署后，把 Worker 地址加到 app.js 中 CONFIG.apiBases 的最前面。

const ALLOWED_PATHS = ['/search/venue/api', '/search/publ/api'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    if (request.method !== 'GET' || !ALLOWED_PATHS.includes(url.pathname)) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    const upstream = await fetch(`https://dblp.org${url.pathname}${url.search}`, {
      cf: { cacheTtl: 86400, cacheEverything: true }, // 相同查询缓存一天，减轻 dblp 压力
    });
    const response = new Response(upstream.body, upstream);
    for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
    return response;
  },
};
