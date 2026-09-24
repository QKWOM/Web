'use strict';

const CONFIG = {
  // dblp API 地址，按顺序尝试：
  // - 'dblp-proxy'：server.py 提供的本地中转，用 python3 server.py 启动时可用
  // - dblp 官网和官方镜像：浏览器直接访问，可能被跨域限制拦截
  // 在线部署时，可以把 proxy/cloudflare-worker.js 的地址放到最前面，
  // 例如 'https://dblp-proxy.xxx.workers.dev'。
  apiBases: ['dblp-proxy', 'https://dblp.org', 'https://dblp.uni-trier.de'],
  pageSize: 1000, // dblp 单次最多返回 1000 条
  maxOffset: 10000, // dblp 搜索结果最多翻到第 10000 条
  minGapMs: 400, // 两次请求之间的最小间隔，避免给 dblp 造成压力
};

const POPULAR = [
  'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'ICML', 'ICLR', 'AAAI', 'IJCAI', 'ACL',
  'EMNLP', 'NAACL', 'KDD', 'WWW', 'SIGIR', 'SIGMOD', 'CHI', 'ICSE', 'CCS',
];

// 优先作为论文主链接的站点（通常可以直接看到 PDF）
const OPEN_HOSTS = [
  'openaccess.thecvf.com', 'openreview.net', 'aclanthology.org', 'proceedings.mlr.press',
  'proceedings.neurips.cc', 'papers.nips.cc', 'papers.neurips.cc', 'ojs.aaai.org', 'ijcai.org',
  'www.ijcai.org', 'www.usenix.org', 'arxiv.org', 'www.ecva.net', 'www.isca-archive.org',
  'www.ndss-symposium.org', 'www.vldb.org',
];

const HOST_LABELS = {
  'doi.org': 'DOI',
  'openaccess.thecvf.com': 'CVF',
  'openreview.net': 'OpenReview',
  'aclanthology.org': 'ACL Anthology',
  'proceedings.mlr.press': 'PMLR',
  'proceedings.neurips.cc': 'NeurIPS',
  'papers.nips.cc': 'NeurIPS',
  'papers.neurips.cc': 'NeurIPS',
  'ojs.aaai.org': 'AAAI',
  'ijcai.org': 'IJCAI',
  'arxiv.org': 'arXiv',
  'ieeexplore.ieee.org': 'IEEE',
  'dl.acm.org': 'ACM',
  'link.springer.com': 'Springer',
  'www.ecva.net': 'ECVA',
  'www.usenix.org': 'USENIX',
  'dblp.org': 'dblp',
};

const VENUE_TYPES = {
  'Conference or Workshop': '会议/研讨会',
  'Journal': '期刊',
  'Series': '丛书',
  'Repository': '数据库',
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/* ---------------- dblp API ---------------- */

class ApiError extends Error {
  constructor(message, { status = 0, network = false } = {}) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

const api = (() => {
  const memo = new Map();
  let transport = 'fetch'; // 'fetch'，跨域失败时改用 'jsonp'
  let preferred = 0;
  let lastAt = 0;
  let queue = Promise.resolve();
  let jsonpSeq = 0;
  // 相对地址是和网页同源的中转服务；没有中转服务（404）或直接打开文件时跳过
  const isLocal = (base) => !/^https?:\/\//i.test(base);
  const disabled = new Set();
  if (location.protocol === 'file:') {
    CONFIG.apiBases.forEach((base, i) => isLocal(base) && disabled.add(i));
  }

  // 让所有请求排队，并保持最小间隔
  function throttle() {
    const turn = queue.then(async () => {
      const wait = lastAt + CONFIG.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
    });
    queue = turn;
    return turn;
  }

  function buildUrl(base, path, params) {
    return base.replace(/\/+$/, '') + path + '?' + new URLSearchParams(params);
  }

  async function viaFetch(url) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ApiError('无法连接 dblp', { network: true });
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || ''; // server.py 会返回具体原因
      } catch (e) {
        /* 不是 JSON */
      }
      throw new ApiError(detail || `dblp 返回错误（HTTP ${res.status}）`, { status: res.status });
    }
    let body;
    try {
      body = await res.text();
    } catch (e) {
      throw new ApiError('读取 dblp 数据时连接中断', { network: true });
    }
    try {
      return parseJson(body);
    } catch (e) {
      console.error('dblp 返回的内容无法解析：', body.slice(0, 2000));
      const head = body.replace(/\s+/g, ' ').trim().slice(0, 150) || '（空）';
      throw new ApiError(`dblp 返回的数据无法解析（开头内容：${head}）`, { status: res.status });
    }
  }

  // 宽松解析：dblp 数据里偶尔有未转义的控制字符或无效的反斜杠转义
  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      const repaired = text
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/\\(.)/g, (m, c) => ('"\\/bfnrtu'.includes(c) ? m : '\\\\' + c));
      return JSON.parse(repaired);
    }
  }

  function viaJsonp(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const name = `__dblpCallback${jsonpSeq++}`;
      const script = document.createElement('script');
      const finish = () => {
        clearTimeout(timer);
        window[name] = () => {}; // 超时后脚本才返回时不报错
        script.remove();
      };
      const timer = setTimeout(() => {
        finish();
        reject(new ApiError('连接 dblp 超时', { network: true }));
      }, timeoutMs);
      window[name] = (data) => {
        finish();
        resolve(data);
      };
      script.onerror = () => {
        finish();
        reject(new ApiError('无法连接 dblp', { network: true }));
      };
      script.src = url + '&callback=' + encodeURIComponent(name);
      document.head.appendChild(script);
    });
  }

  function checkResult(data) {
    const result = data && data.result;
    if (!result) throw new ApiError('dblp 返回了无法识别的数据');
    const code = result.status && result.status['@code'];
    if (code && String(code) !== '200') {
      throw new ApiError(`dblp 查询出错：${result.status.text || code}`, { status: Number(code) || 0 });
    }
    return result;
  }

  async function get(path, params) {
    const key = path + '?' + new URLSearchParams(params);
    if (memo.has(key)) return memo.get(key);

    const bases = CONFIG.apiBases;
    let networkErr = new ApiError('无法连接 dblp', { network: true });
    let serverErr = null; // 有状态码的错误比网络错误更能说明问题，优先报告
    for (let attempt = 0; attempt < 3; attempt++) {
      let allNetwork = true;
      let busy = false;
      for (let i = 0; i < bases.length; i++) {
        const index = (preferred + i) % bases.length;
        const base = bases[index];
        if (disabled.has(index) || (transport === 'jsonp' && isLocal(base))) continue;
        await throttle();
        try {
          const data = transport === 'jsonp'
            ? await viaJsonp(buildUrl(base, path, { ...params, format: 'jsonp' }))
            : await viaFetch(buildUrl(base, path, { ...params, format: 'json' }));
          const result = checkResult(data);
          preferred = index;
          memo.set(key, result);
          return result;
        } catch (err) {
          if (isLocal(base) && (err.status === 404 || err.status === 501 || err.network)) {
            disabled.add(index); // 网页不是用 server.py 启动的，没有本地中转
            continue;
          }
          if (err.network) {
            networkErr = err;
          } else {
            allNetwork = false;
            serverErr = err;
          }
          if (err.status === 429) { busy = true; break; }
        }
      }
      if (busy) {
        await sleep(4000 * (attempt + 1)); // 被限流，稍后重试
      } else if (allNetwork && transport === 'fetch') {
        transport = 'jsonp'; // 很可能是跨域被拦截，改用 JSONP
      } else if (serverErr && (serverErr.status === 500 || serverErr.status === 503)) {
        await sleep(1500 * (attempt + 1));
      } else {
        break;
      }
    }
    if (transport === 'jsonp') transport = 'fetch';
    throw serverErr || networkErr;
  }

  // 本地中转不可用：网页不是由 server.py 提供的
  const localProxyMissing = () => CONFIG.apiBases.some((base, i) => isLocal(base) && disabled.has(i));

  return { get, localProxyMissing };
})();

// 本地缓存（venue 搜索和年份列表），失败时静默跳过
const store = {
  prefix: 'cpf:',
  get(key) {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      if (!raw) return null;
      const { e, v } = JSON.parse(raw);
      if (Date.now() > e) {
        localStorage.removeItem(this.prefix + key);
        return null;
      }
      return v;
    } catch (err) {
      return null;
    }
  },
  set(key, value, ttlMs) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify({ e: Date.now() + ttlMs, v: value }));
    } catch (err) {
      /* 隐私模式或容量不足时忽略 */
    }
  },
};

const DAY = 24 * 3600 * 1000;

/* ---------------- 数据整理 ---------------- */

const entityDecoder = document.createElement('textarea');
function decodeEntities(s) {
  if (!/&[#a-z0-9]+;/i.test(s)) return s;
  entityDecoder.innerHTML = s;
  return entityDecoder.value;
}

function text(x) {
  if (x == null) return '';
  if (typeof x === 'object') return decodeEntities(String(x.text ?? ''));
  return decodeEntities(String(x));
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : '';
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function linkLabel(u) {
  const host = hostOf(u);
  return HOST_LABELS[host] || host.replace(/^www\./, '') || '链接';
}

function streamFromUrl(url) {
  const m = /\/(?:db|streams)\/([a-z]+\/[^/?#]+)/i.exec(url || '');
  return m ? m[1] : null;
}

function acronymFromName(name) {
  const m = /\(([^()]+)\)\s*$/.exec(name);
  return m ? m[1] : '';
}

function normalizePaper(info) {
  const ee = [];
  for (const e of toArray(info.ee)) {
    const u = safeUrl(text(e));
    if (u && !ee.includes(u)) ee.push(u);
  }
  const doi = text(info.doi);
  const doiUrl = doi ? `https://doi.org/${doi}` : '';
  if (doiUrl && !ee.some((u) => hostOf(u) === 'doi.org')) ee.push(doiUrl);
  // 开放获取的链接排在前面
  ee.sort((a, b) => openRank(a) - openRank(b));
  return {
    key: text(info.key),
    title: text(info.title).replace(/\s*\.$/, ''),
    authors: toArray(info.authors && info.authors.author)
      .map((a) => text(a).replace(/\s+\d{4}$/, ''))
      .filter(Boolean),
    year: text(info.year),
    type: text(info.type),
    venue: toArray(info.venue).map(text).join(', '),
    links: ee,
    dblp: safeUrl(text(info.url)),
  };
}

function openRank(u) {
  const i = OPEN_HOSTS.indexOf(hostOf(u));
  if (i >= 0) return i;
  return hostOf(u) === 'doi.org' ? 100 : 200;
}

function mainLink(p) {
  return p.links[0] || p.dblp || '';
}

/* ---------------- 查询 ---------------- */

async function searchVenues(query) {
  const cacheKey = 'venue:' + query.toLowerCase();
  const cached = store.get(cacheKey);
  if (cached) return cached;

  const result = await api.get('/search/venue/api', { q: query, h: 100 });
  const venues = [];
  for (const hit of toArray(result.hits && result.hits.hit)) {
    const info = hit.info || {};
    const stream = streamFromUrl(text(info.url));
    if (!stream) continue;
    const name = text(info.venue) || stream;
    venues.push({
      stream,
      name,
      acronym: text(info.acronym) || acronymFromName(name),
      type: text(info.type),
      url: safeUrl(text(info.url)) || `https://dblp.org/db/${stream}/`,
    });
  }
  // 同一个 dblp 页面可能对应多个名称（如 CVPR 和 CVPR Workshops），保留最匹配的那个
  const seen = new Set();
  const ranked = rankVenues(venues, query).filter((v) => !seen.has(v.stream) && seen.add(v.stream));
  store.set(cacheKey, ranked, 7 * DAY);
  return ranked;
}

function venueScore(v, query) {
  const q = query.trim().toLowerCase();
  const acr = (v.acronym || '').toLowerCase();
  let s = 0;
  if (acr === q) s += 100;
  else if (acr.startsWith(q)) s += 20;
  if (v.stream.split('/')[1] === q) s += 40;
  if (/conference/i.test(v.type)) s += 30;
  if (/workshop/i.test(v.name + ' ' + v.acronym) && !/workshop/i.test(q)) s -= 25;
  return s;
}

function rankVenues(venues, query) {
  return venues
    .map((v, i) => ({ v, i, s: venueScore(v, query) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.v);
}

async function countHits(q) {
  const result = await api.get('/search/publ/api', { q, h: 1 });
  return parseInt(result.hits && result.hits['@total'], 10) || 0;
}

// 找到 dblp 中能筛选出这个会议论文的查询条件
async function resolveFilter(venue) {
  const byStream = `streamid:${venue.stream}:`;
  if (await countHits(byStream) > 0) return byStream;
  if (venue.acronym) {
    const byVenue = `venue:${venue.acronym.replace(/\s+/g, '_')}:`;
    if (await countHits(byVenue) > 0) return byVenue;
  }
  return null;
}

// 利用 dblp 搜索的前缀补全，一次拿到所有年份及论文数
async function yearsFromCompletions(filter) {
  const result = await api.get('/search/publ/api', { q: `${filter} year:`, h: 1, c: 1000 });
  const maxYear = new Date().getFullYear() + 2;
  const years = new Map();
  for (const c of toArray(result.completions && result.completions.c)) {
    const m = /^(?:year:)?((?:19|20)\d\d):?$/i.exec(text(c).trim());
    if (!m) continue;
    const year = Number(m[1]);
    if (year > maxYear) continue;
    const count = parseInt(c['@dc'] ?? c['@sc'], 10) || 0;
    years.set(year, Math.max(years.get(year) || 0, count));
  }
  return [...years].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
}

// 备用方案：逐年查询论文数
async function probeYears(filter, isCurrent, onProgress) {
  const now = new Date().getFullYear();
  const found = [];
  let emptyStreak = 0;
  for (let year = now + 1; year >= 1950; year--) {
    if (!isCurrent()) return null;
    const count = await countHits(`${filter} year:${year}`);
    if (count > 0) {
      found.push({ year, count });
      emptyStreak = 0;
    } else if (found.length && ++emptyStreak >= 12) {
      break;
    }
    onProgress(found, year);
  }
  return found;
}

async function fetchPapers(filter, year, isCurrent, onProgress) {
  const q = `${filter} year:${year}`;
  const items = [];
  const seen = new Set();
  let total = null;
  let offset = 0;
  while (total === null || offset < total) {
    if (offset >= CONFIG.maxOffset) break;
    const h = Math.min(CONFIG.pageSize, CONFIG.maxOffset - offset);
    const result = await api.get('/search/publ/api', { q, h, f: offset });
    if (!isCurrent()) return null;
    total = parseInt(result.hits && result.hits['@total'], 10) || 0;
    const batch = toArray(result.hits && result.hits.hit);
    if (!batch.length) break;
    for (const hit of batch) {
      const p = normalizePaper(hit.info || {});
      const id = p.key || p.dblp || p.title;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!p.year || p.year === String(year)) items.push(p);
    }
    offset += batch.length;
    onProgress(Math.min(offset, total), total);
  }
  return {
    papers: items.filter((p) => p.type !== 'Editorship'),
    proceedings: items.filter((p) => p.type === 'Editorship'),
    incomplete: total !== null && offset < total,
  };
}

/* ---------------- 界面 ---------------- */

const state = {
  query: '',
  venues: [],
  venue: null, // { stream, name, acronym, type, url, filter }
  years: [],
  year: null,
  rows: [],
  tokens: { search: 0, venue: 0, year: 0 },
};

// 每次新操作都让同级及下级的旧请求失效，返回判断“本次操作是否仍有效”的函数
function nextToken(kind, ...alsoReset) {
  for (const k of [kind, ...alsoReset]) state.tokens[k]++;
  const value = state.tokens[kind];
  return () => state.tokens[kind] === value;
}

function setStatus(message, kind = 'info') {
  const el = $('status');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.textContent = message;
}

function errorMessage(err) {
  if (err && err.network) {
    if (location.protocol === 'file:') {
      return '当前是直接打开的 index.html 文件，浏览器会拦截对 dblp 的请求。'
        + '请在项目目录运行 python3 server.py，然后打开终端里显示的地址。';
    }
    if (api.localProxyMissing() && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      return `当前页面（${location.host}）不是由 server.py 提供的，可能是之前的 python3 -m http.server 还在运行。`
        + '请关掉它，重新运行 python3 server.py，然后打开终端里显示的地址（以 http://127.0.0.1 开头）。';
    }
    return '浏览器无法直接访问 dblp（通常是跨域限制）。本地使用请在项目目录运行 python3 server.py，'
      + '然后打开它显示的地址；在线部署请参考 README 配置代理。';
  }
  if (err && err.status === 429) return 'dblp 暂时限制了访问频率，请稍等一会儿再试。';
  return (err && err.message) || '出错了，请稍后重试。';
}

function venueLabel(v) {
  return v.acronym || v.name;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.venue) params.set('venue', state.venue.stream);
  if (state.year) params.set('year', state.year);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function renderPopular() {
  const box = $('popular');
  for (const name of POPULAR) {
    box.append(el('button', { type: 'button', class: 'chip', text: name, onclick: () => runSearch(name) }));
  }
}

function hideFrom(section) {
  const order = ['venues-section', 'years-section', 'papers-section'];
  for (const id of order.slice(order.indexOf(section))) $(id).hidden = true;
}

async function runSearch(query, restore = {}) {
  query = query.trim();
  if (!query) return;
  $('q').value = query;
  state.query = query;
  state.venue = null;
  state.year = null;
  const isCurrent = nextToken('search', 'venue', 'year');
  hideFrom('venues-section');
  syncUrl();
  setStatus(`正在 dblp 中搜索“${query}”…`, 'loading');

  let venues;
  try {
    venues = await searchVenues(query);
  } catch (err) {
    if (isCurrent()) setStatus(errorMessage(err), 'error');
    return;
  }
  if (!isCurrent()) return;

  state.venues = venues;
  if (!venues.length) {
    setStatus(`没有找到名称包含“${query}”的会议，换个写法试试（例如用缩写 CVPR，或英文全称）。`, 'error');
    return;
  }
  renderVenues();

  const wanted = restore.venue && venues.find((v) => v.stream === restore.venue);
  if (wanted) {
    selectVenue(wanted, restore);
  } else if (restore.venue) {
    selectVenue(fallbackVenue(restore.venue), restore);
  } else if (venues.length === 1 || venueScore(venues[0], query) >= 100) {
    selectVenue(venues[0]);
  } else {
    setStatus(`找到 ${venues.length} 个匹配项，请选择一个。`);
  }
}

function fallbackVenue(stream) {
  const key = stream.split('/').pop();
  return { stream, name: key.toUpperCase(), acronym: key.toUpperCase(), type: '', url: `https://dblp.org/db/${stream}/` };
}

function renderVenues() {
  const list = $('venues');
  list.textContent = '';
  for (const v of state.venues.slice(0, 30)) {
    const btn = el('button', {
      type: 'button',
      class: 'venue-btn',
      'aria-pressed': String(state.venue ? state.venue.stream === v.stream : false),
      onclick: () => selectVenue(v),
    }, [
      el('span', { class: 'venue-acr', text: v.acronym || v.stream.split('/').pop() }),
      el('span', { class: 'venue-name', text: v.name }),
      el('span', { class: 'venue-type', text: VENUE_TYPES[v.type] || v.type }),
    ]);
    btn.dataset.stream = v.stream;
    list.append(el('li', {}, [btn]));
  }
  $('venues-section').hidden = false;
}

function markVenue() {
  for (const btn of document.querySelectorAll('.venue-btn')) {
    btn.setAttribute('aria-pressed', String(!!state.venue && btn.dataset.stream === state.venue.stream));
  }
}

async function selectVenue(venue, restore = {}) {
  state.venue = { ...venue, filter: null };
  state.year = null;
  state.years = [];
  const isCurrent = nextToken('venue', 'year');
  markVenue();
  hideFrom('years-section');
  syncUrl();

  const showAcronym = venue.acronym && !venue.name.includes(`(${venue.acronym})`);
  $('venue-title').textContent = showAcronym ? `${venue.acronym} · ${venue.name}` : venue.name;
  $('venue-link').href = venue.url;
  $('years').textContent = '';
  $('years-section').hidden = false;
  setStatus(`正在获取 ${venueLabel(venue)} 的年份列表…`, 'loading');

  try {
    const filter = await resolveFilter(venue);
    if (!isCurrent()) return;
    if (!filter) {
      setStatus(`dblp 中没有找到 ${venueLabel(venue)} 的论文。`, 'error');
      return;
    }
    state.venue.filter = filter;

    const cacheKey = 'years:' + filter;
    let years = store.get(cacheKey);
    if (!years) {
      years = await yearsFromCompletions(filter).catch(() => []);
      if (!isCurrent()) return;
      if (!years.length) {
        years = await probeYears(filter, isCurrent, (found, year) => {
          state.years = found;
          renderYears();
          if (state.year === null) {
            setStatus(`正在逐年查询 ${venueLabel(venue)} 的论文（已查到 ${year} 年）…`, 'loading');
          }
        });
        if (!years) return;
      }
      if (years.length) store.set(cacheKey, years, DAY);
    }
    if (!isCurrent()) return;

    state.years = years;
    renderYears();
    if (!years.length) {
      setStatus(`没有找到 ${venueLabel(venue)} 的年份信息，可以在下方手动输入年份。`, 'error');
      return;
    }
    const target = Number(restore.year) || null;
    if (target) {
      loadYear(target);
    } else if (state.year === null) {
      setStatus(`${venueLabel(venue)} 共有 ${years.length} 个年份，点击年份查看论文列表。`);
    }
  } catch (err) {
    if (isCurrent()) setStatus(errorMessage(err), 'error');
  }
}

function renderYears() {
  const box = $('years');
  box.textContent = '';
  for (const { year, count } of state.years) {
    const btn = el('button', {
      type: 'button',
      class: 'year-btn',
      'aria-pressed': String(state.year === year),
      onclick: () => loadYear(year),
    }, [
      el('span', { class: 'year-num', text: String(year) }),
      el('span', { class: 'year-count', text: count ? `${count} 篇` : '' }),
    ]);
    btn.dataset.year = year;
    box.append(btn);
  }
}

function markYear() {
  for (const btn of document.querySelectorAll('.year-btn')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.year) === state.year));
  }
}

async function loadYear(year) {
  const venue = state.venue;
  if (!venue || !venue.filter) return;
  state.year = year;
  const isCurrent = nextToken('year');
  markYear();
  syncUrl();
  $('papers-section').hidden = true;
  setStatus(`正在加载 ${venueLabel(venue)} ${year} 的论文…`, 'loading');

  try {
    const result = await fetchPapers(venue.filter, year, isCurrent, (done, total) => {
      setStatus(`正在加载 ${venueLabel(venue)} ${year} 的论文（${done} / ${total}）…`, 'loading');
    });
    if (!result) return;
    renderPapers(result, venue, year);
    if (!result.papers.length) {
      setStatus(`dblp 中没有 ${venueLabel(venue)} ${year} 的论文。`, 'error');
    } else if (result.incomplete) {
      setStatus('这一年的论文太多，只加载了一部分（dblp 最多返回 10000 条结果）。', 'error');
    } else {
      setStatus('');
    }
  } catch (err) {
    if (isCurrent()) setStatus(errorMessage(err), 'error');
  }
}

function renderPapers({ papers, proceedings }, venue, year) {
  $('papers-title').textContent = `${venueLabel(venue)} ${year}`;
  $('filter').value = '';

  const proc = $('proceedings');
  proc.hidden = !proceedings.length;
  proc.open = false;
  proc.querySelector('summary').textContent = `论文集（${proceedings.length} 卷）`;
  const procList = proc.querySelector('ul');
  procList.textContent = '';
  for (const p of proceedings) {
    const href = mainLink(p);
    procList.append(el('li', {}, [href
      ? el('a', { href, target: '_blank', rel: 'noopener', text: p.title })
      : document.createTextNode(p.title)]));
  }

  const list = $('papers');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  state.rows = papers.map((p) => {
    const href = mainLink(p);
    const links = p.links.map((u) => el('a', { href: u, target: '_blank', rel: 'noopener', text: linkLabel(u) }));
    if (p.dblp) links.push(el('a', { href: p.dblp, target: '_blank', rel: 'noopener', text: 'dblp' }));
    const li = el('li', { class: 'paper' }, [
      href
        ? el('a', { class: 'paper-title', href, target: '_blank', rel: 'noopener', text: p.title })
        : el('span', { class: 'paper-title nolink', text: p.title }),
      p.authors.length ? el('div', { class: 'paper-authors', text: p.authors.join(', ') }) : null,
      links.length ? el('div', { class: 'paper-links' }, links) : null,
    ]);
    frag.append(li);
    return { li, paper: p, haystack: `${p.title} ${p.authors.join(' ')}`.toLowerCase() };
  });
  list.append(frag);
  updateCount();
  $('papers-section').hidden = false;
}

function visibleRows() {
  return state.rows.filter((r) => !r.li.hidden);
}

function updateCount() {
  const shown = visibleRows().length;
  const total = state.rows.length;
  $('papers-count').textContent = shown === total ? `共 ${total} 篇` : `显示 ${shown} / ${total} 篇`;
}

function applyFilter() {
  const terms = $('filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const row of state.rows) {
    row.li.hidden = !terms.every((t) => row.haystack.includes(t));
  }
  updateCount();
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const rows = visibleRows();
  if (!rows.length) return;
  const header = ['title', 'authors', 'year', 'venue', 'link', 'all_links', 'dblp'];
  const lines = [header.join(',')];
  for (const { paper: p } of rows) {
    lines.push([
      p.title, p.authors.join('; '), p.year, p.venue, mainLink(p), p.links.join(' '), p.dblp,
    ].map(csvCell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const name = `${venueLabel(state.venue)}-${state.year}`.replace(/[^\w.-]+/g, '_');
  const a = el('a', { href: url, download: `${name}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLinks() {
  const links = visibleRows().map((r) => mainLink(r.paper)).filter(Boolean);
  if (!links.length) return;
  const content = links.join('\n');
  try {
    await navigator.clipboard.writeText(content);
  } catch (e) {
    const ta = el('textarea', { value: content });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  setStatus(`已复制 ${links.length} 个论文链接。`);
}

function init() {
  renderPopular();

  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch($('q').value);
  });

  $('year-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const year = parseInt($('year-input').value, 10);
    if (year >= 1950 && year <= 2100) loadYear(year);
  });

  let filterTimer;
  $('filter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 120);
  });
  $('export-csv').addEventListener('click', exportCsv);
  $('copy-links').addEventListener('click', copyLinks);

  // 支持分享链接：?q=CVPR&venue=conf/cvpr&year=2024
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  const venue = params.get('venue');
  const year = params.get('year');
  if (q) {
    runSearch(q, { venue, year });
  } else if (venue && /^[a-z]+\/[^/]+$/i.test(venue)) {
    selectVenue(fallbackVenue(venue), { year });
  } else {
    $('q').focus();
  }
}

init();
