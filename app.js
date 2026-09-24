'use strict';

const CONFIG = {
  // dblp SPARQL 查询服务的地址，按顺序尝试：
  // - 'dblp-proxy/sparql'：server.py 提供的本地中转，用 python3 server.py 启动时可用
  // - dblp 官方 SPARQL 服务，以及弗莱堡大学 QLever 上的 dblp 数据：浏览器直接访问，需要对方允许跨域
  // 在线部署时，可以把 proxy/cloudflare-worker.js 的地址（以 /sparql 结尾）放到最前面。
  endpoints: [
    'dblp-proxy/sparql',
    'https://sparql.dblp.org/sparql',
    'https://qlever.cs.uni-freiburg.de/api/dblp',
  ],
  minGapMs: 300, // 两次请求之间的最小间隔，避免给服务器造成压力
};

const POPULAR = [
  'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'ICML', 'ICLR', 'AAAI', 'IJCAI', 'ACL',
  'EMNLP', 'NAACL', 'KDD', 'WWW', 'SIGIR', 'SIGMOD', 'CHI', 'ICSE', 'CCS',
];

// 常用名称和 dblp 内部标识不一致的会议
const ALIASES = {
  neurips: ['nips'],
};

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

/* ---------------- dblp SPARQL 查询 ---------------- */

class ApiError extends Error {
  constructor(message, { status = 0, network = false } = {}) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

function preview(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 150) || '（空）';
}

const api = (() => {
  const memo = new Map();
  let preferred = 0;
  let lastAt = 0;
  let queue = Promise.resolve();
  // 相对地址是和网页同源的中转服务；没有中转服务（404）或直接打开文件时跳过
  const isLocal = (base) => !/^https?:\/\//i.test(base);
  const disabled = new Set();
  if (location.protocol === 'file:') {
    CONFIG.endpoints.forEach((base, i) => isLocal(base) && disabled.add(i));
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

  // 宽松解析：数据里偶尔有未转义的控制字符或无效的反斜杠转义
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

  async function request(url) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
    } catch (e) {
      throw new ApiError('无法连接 dblp', { network: true });
    }
    let body;
    try {
      body = await res.text();
    } catch (e) {
      throw new ApiError('读取 dblp 数据时连接中断', { network: true });
    }
    let data = null;
    try {
      data = parseJson(body);
    } catch (e) {
      /* 下面统一处理 */
    }
    if (!res.ok) {
      // server.py 的错误放在 error 字段，SPARQL 服务（QLever）的放在 exception 字段
      const detail = data && (data.error || (data.exception && `dblp 查询出错：${data.exception}`));
      throw new ApiError(detail || `dblp 返回错误（HTTP ${res.status}）：${preview(body)}`, { status: res.status });
    }
    if (!data || !data.results || !Array.isArray(data.results.bindings)) {
      console.error('dblp 返回的内容无法解析：', body.slice(0, 2000));
      throw new ApiError(`dblp 返回的数据无法解析（开头内容：${preview(body)}）`, { status: res.status });
    }
    return data.results.bindings;
  }

  async function query(sparql) {
    if (memo.has(sparql)) return memo.get(sparql);

    const bases = CONFIG.endpoints;
    let networkErr = new ApiError('无法连接 dblp', { network: true });
    let serverErr = null; // 有状态码的错误比网络错误更能说明问题，优先报告第一个
    for (let attempt = 0; attempt < 3; attempt++) {
      let busy = false;
      for (let i = 0; i < bases.length; i++) {
        const index = (preferred + i) % bases.length;
        const base = bases[index];
        if (disabled.has(index)) continue;
        await throttle();
        try {
          const rows = await request(`${base}?query=${encodeURIComponent(sparql)}`);
          preferred = index;
          memo.set(sparql, rows);
          return rows;
        } catch (err) {
          if (isLocal(base) && (err.status === 404 || err.status === 501 || err.network)) {
            disabled.add(index); // 网页不是用 server.py 启动的，没有本地中转
            continue;
          }
          if (err.network) networkErr = err;
          else serverErr = serverErr || err;
          if (err.status === 429) { busy = true; break; }
        }
      }
      if (!busy) break;
      await sleep(4000 * (attempt + 1)); // 被限流，稍后重试
    }
    throw serverErr || networkErr;
  }

  // 本地中转不可用：网页不是由 server.py 提供的
  const localProxyMissing = () => CONFIG.endpoints.some((base, i) => isLocal(base) && disabled.has(i));

  return { query, localProxyMissing };
})();

// 本地缓存（会议搜索和年份列表），失败时静默跳过
const store = {
  prefix: 'cpf2:',
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

const STREAM_BASE = 'https://dblp.org/streams/';
const STREAM_KEY = /^[a-z]+\/[\w.-]+$/i;
const PREFIXES = `PREFIX dblp: <https://dblp.org/rdf/schema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;

// SPARQL 字符串字面量
function literal(s) {
  return '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ') + '"';
}

function streamIri(stream) {
  if (!STREAM_KEY.test(stream)) throw new ApiError(`无效的会议标识：${stream}`);
  return `<${STREAM_BASE}${stream}>`;
}

// 读取 SPARQL 结果中某个变量的值
function val(row, name) {
  return row[name] ? String(row[name].value) : '';
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

function acronymFromName(name) {
  const m = /\(([^()]+)\)\s*$/.exec(name);
  return m ? m[1] : '';
}

function openRank(u) {
  const i = OPEN_HOSTS.indexOf(hostOf(u));
  if (i >= 0) return i;
  return hostOf(u) === 'doi.org' ? 100 : 200;
}

function mainLink(p) {
  return p.links[0] || p.dblp || '';
}

function searchTerms(query) {
  const q = query.trim().toLowerCase();
  return [q, ...(ALIASES[q] || [])];
}

/* ---------------- 查询 ---------------- */

async function searchVenues(query) {
  const cacheKey = 'venue:' + query.trim().toLowerCase();
  const cached = store.get(cacheKey);
  if (cached) return cached;

  const terms = searchTerms(query);
  const conditions = terms
    .map((t) => `CONTAINS(LCASE(STR(?t)), ${literal(t)}) || CONTAINS(LCASE(STR(?stream)), ${literal('/' + t)})`)
    .join(' || ');
  const rows = await api.query(`${PREFIXES}SELECT ?stream (SAMPLE(?pt) AS ?primary) (SAMPLE(?t) AS ?title)
  (SAMPLE(?lb) AS ?label) (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
WHERE {
  ?stream dblp:streamTitle ?t .
  ?stream rdf:type ?type .
  OPTIONAL { ?stream dblp:primaryStreamTitle ?pt }
  OPTIONAL { ?stream rdfs:label ?lb }
  FILTER(${conditions})
}
GROUP BY ?stream
LIMIT 1000`);

  const venues = [];
  for (const row of rows) {
    const iri = val(row, 'stream');
    const stream = iri.startsWith(STREAM_BASE) ? iri.slice(STREAM_BASE.length) : '';
    if (!STREAM_KEY.test(stream)) continue;
    const key = stream.split('/').pop();
    const name = val(row, 'primary') || val(row, 'title') || stream;
    const label = val(row, 'label');
    const types = val(row, 'types');
    const aliasHit = terms.slice(1).includes(key.toLowerCase());
    venues.push({
      stream,
      name,
      acronym: acronymFromName(name)
        || (label && label.length <= 24 && !/\s/.test(label) ? label : '')
        || (aliasHit ? query.trim() : key.toUpperCase()),
      type: /#Conference\b/.test(types) ? 'Conference or Workshop'
        : /#Journal\b/.test(types) ? 'Journal'
          : /#Series\b/.test(types) ? 'Series'
            : /#Repository\b/.test(types) ? 'Repository' : '',
      url: `https://dblp.org/db/${stream}/`,
    });
  }
  const ranked = rankVenues(venues, query);
  store.set(cacheKey, ranked, 7 * DAY);
  return ranked;
}

function venueScore(v, query) {
  const q = query.trim().toLowerCase();
  const key = v.stream.split('/').pop().toLowerCase();
  const acr = (v.acronym || '').toLowerCase();
  let s = 0;
  if (searchTerms(query).includes(key)) s += 100;
  if (acr === q) s += 60;
  else if (acr.startsWith(q)) s += 10;
  if (v.name.toLowerCase().includes(`(${q})`)) s += 20;
  if (v.type === 'Conference or Workshop') s += 30;
  if (/workshop/i.test(v.name) && !/workshop/i.test(q)) s -= 25;
  return s;
}

function rankVenues(venues, query) {
  return venues
    .map((v, i) => ({ v, i, s: venueScore(v, query) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.v);
}

// 论文所属年份：优先用会议举办年份，没有时用出版年份
const YEAR_PATTERNS = `?publ dblp:yearOfPublication ?yp .
    OPTIONAL { ?publ dblp:yearOfEvent ?ye }`;

async function listYears(stream) {
  const rows = await api.query(`${PREFIXES}SELECT ?year (COUNT(DISTINCT ?publ) AS ?count)
WHERE {
  ?publ dblp:publishedInStream ${streamIri(stream)} .
  ${YEAR_PATTERNS}
  BIND(STR(COALESCE(?ye, ?yp)) AS ?year)
  MINUS { ?publ rdf:type dblp:Editorship }
}
GROUP BY ?year
ORDER BY DESC(?year)`);
  return rows
    .map((row) => ({ year: parseInt(val(row, 'year'), 10), count: parseInt(val(row, 'count'), 10) || 0 }))
    .filter((y) => y.year >= 1900 && y.year <= 2100)
    .sort((a, b) => b.year - a.year);
}

async function fetchPapers(venue, year) {
  const rows = await api.query(`${PREFIXES}SELECT ?publ (SAMPLE(?t) AS ?title) (SAMPLE(?d) AS ?doi)
  (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
  (GROUP_CONCAT(DISTINCT STR(?page); SEPARATOR=" ") AS ?pages)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?ord), "|", STR(?name)); SEPARATOR="||") AS ?authors)
WHERE {
  {
    SELECT DISTINCT ?publ WHERE {
      ?publ dblp:publishedInStream ${streamIri(venue.stream)} .
      ${YEAR_PATTERNS}
      FILTER(STR(COALESCE(?ye, ?yp)) = ${literal(String(year))})
    }
  }
  ?publ dblp:title ?t .
  ?publ rdf:type ?type .
  OPTIONAL { ?publ dblp:doi ?d }
  OPTIONAL { ?publ dblp:documentPage ?page }
  OPTIONAL { ?publ dblp:hasSignature ?sig . ?sig dblp:signatureOrdinal ?ord . ?sig dblp:signatureDblpName ?name }
}
GROUP BY ?publ`);

  const papers = [];
  const proceedings = [];
  for (const row of rows) {
    const links = [];
    const seen = new Set();
    const addLink = (u) => {
      const key = u.replace(/^https?:\/\//i, '').toLowerCase();
      if (safeUrl(u) && !seen.has(key)) {
        seen.add(key);
        links.push(u);
      }
    };
    val(row, 'pages').split(/\s+/).forEach(addLink);
    const doi = val(row, 'doi');
    if (doi) addLink(/^https?:/i.test(doi) ? doi : `https://doi.org/${doi}`);
    links.sort((a, b) => openRank(a) - openRank(b)); // 开放获取的链接排在前面

    // 作者格式为“序号|姓名”，按序号排列；去掉 dblp 区分同名作者的编号（如 0001）
    const authors = val(row, 'authors').split('||')
      .map((s) => /^(\d+)\|(.+)$/.exec(s.trim()))
      .filter(Boolean)
      .map((m) => ({ ord: Number(m[1]), name: m[2].replace(/\s+\d{4}$/, '') }))
      .sort((a, b) => a.ord - b.ord)
      .map((a) => a.name);

    const paper = {
      title: val(row, 'title').replace(/\s*\.$/, ''),
      authors,
      year: String(year),
      venue: venueLabel(venue),
      links,
      dblp: safeUrl(val(row, 'publ')),
    };
    (/#Editorship\b/.test(val(row, 'types')) ? proceedings : papers).push(paper);
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  return { papers: papers.sort(byTitle), proceedings: proceedings.sort(byTitle) };
}

/* ---------------- 界面 ---------------- */

const state = {
  query: '',
  venues: [],
  venue: null, // { stream, name, acronym, type, url }
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
    return '浏览器无法直接访问 dblp 的查询服务（通常是跨域限制）。本地使用请在项目目录运行 python3 server.py，'
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
  } else if (restore.venue && STREAM_KEY.test(restore.venue)) {
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
  state.venue = venue;
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
    const cacheKey = 'years:' + venue.stream;
    let years = store.get(cacheKey);
    if (!years) {
      years = await listYears(venue.stream);
      if (years.length) store.set(cacheKey, years, DAY);
    }
    if (!isCurrent()) return;

    state.years = years;
    renderYears();
    if (!years.length) {
      setStatus(`dblp 中没有找到 ${venueLabel(venue)} 的论文。`, 'error');
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
  if (!venue) return;
  state.year = year;
  const isCurrent = nextToken('year');
  markYear();
  syncUrl();
  $('papers-section').hidden = true;
  setStatus(`正在加载 ${venueLabel(venue)} ${year} 的论文…`, 'loading');

  try {
    const result = await fetchPapers(venue, year);
    if (!isCurrent()) return;
    renderPapers(result, venue, year);
    if (!result.papers.length) {
      setStatus(`dblp 中没有 ${venueLabel(venue)} ${year} 的论文。`, 'error');
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
  } else if (venue && STREAM_KEY.test(venue)) {
    selectVenue(fallbackVenue(venue), { year });
  } else {
    $('q').focus();
  }
}

init();
