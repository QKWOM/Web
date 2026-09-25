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
  // OpenReview API：dblp 还没收录的年份（通常是最近一两年）从这里补充
  openreview: [
    'openreview-proxy',
    'https://api2.openreview.net',
  ],
  minGapMs: 300, // 两次请求之间的最小间隔，避免给服务器造成压力
};

// 常用按钮；带 venue 的直接打开对应的 dblp 标识（避免同名，例如 RAM 期刊和 RAM 会议）
const POPULAR = {
  会议: [
    'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'ICML', 'ICLR', 'AAAI', 'IJCAI', 'ACL',
    'EMNLP', 'NAACL', 'KDD', 'WWW', 'SIGIR', 'SIGMOD', 'CHI', 'ICSE', 'CCS',
  ],
  期刊: ['TPAMI', 'IJCV', 'TIP', 'JMLR', 'TMLR', 'TKDE', 'TNNLS', 'TOG', 'PVLDB', 'TACL'],
  机器人: [
    { label: 'CoRL', venue: 'conf/corl' },
    { label: 'ICRA', venue: 'conf/icra' },
    { label: 'IROS', venue: 'conf/iros' },
    { label: 'RSS', venue: 'conf/rss' },
    { label: 'T-RO', venue: 'journals/trob' },
    { label: 'IJRR', venue: 'journals/ijrr' },
    { label: 'RA-L', venue: 'journals/ral' },
    { label: 'Science Robotics', venue: 'journals/scirobotics' },
    { label: 'RAM', venue: 'journals/ram' },
    { label: 'AURO', venue: 'journals/arobots' },
    { label: 'JFR', venue: 'journals/jfr' },
    { label: 'RAS', venue: 'journals/ras' },
  ],
};

// 每次加载的论文数，更多的点“加载更多”
const PAGE_SIZE = 1000;

// 常用名称和 dblp 内部标识不一致的会议（同一组里的名称视为同一个会议）
const ALIAS_GROUPS = [
  ['neurips', 'nips'],
  ['tpami', 'pami'],
  ['tnnls', 'tnn'],
  ['tcsvt', 'tcsv'],
  ['tro', 't-ro', 'trob'],
  ['ra-l', 'ral'],
  ['vldb', 'pvldb'],
  ['aij', 'ai'],
  ['auro', 'arobots'],
  ['science robotics', 'scirobotics'],
];

// 在 OpenReview 上发布论文的常见会议：主会场 ID 为“前缀/年份/Conference”
const OPENREVIEW_PREFIXES = {
  iclr: 'ICLR.cc',
  neurips: 'NeurIPS.cc',
  nips: 'NeurIPS.cc',
  icml: 'ICML.cc',
  corl: 'robot-learning.org/CoRL',
  colm: 'colmweb.org/COLM',
  aistats: 'aistats.org/AISTATS',
  uai: 'auai.org/UAI',
};

// 搜不到时用来提示“你是不是要找”的常见缩写
const KNOWN_ACRONYMS = [
  ...Object.values(POPULAR).flat().map((chip) => (typeof chip === 'string' ? chip : chip.label)),
  'ICRA', 'IROS', 'RSS', 'CoRL', 'AISTATS', 'UAI', 'COLT', 'COLM', 'WACV', 'BMVC', 'MICCAI', 'ICASSP',
  'INTERSPEECH', 'ECAI', 'WSDM', 'CIKM', 'RecSys', 'ICDE', 'VLDB', 'EDBT', 'OSDI', 'SOSP', 'NSDI', 'EuroSys',
  'PLDI', 'POPL', 'OOPSLA', 'FSE', 'ASE', 'ISSTA', 'NDSS', 'CRYPTO', 'EUROCRYPT', 'STOC', 'FOCS', 'SODA',
  'ICALP', 'UIST', 'CSCW', 'MobiCom', 'SIGCOMM', 'INFOCOM', 'DAC', 'ISCA', 'MICRO', 'HPCA', 'ASPLOS',
  'ICDM', 'SDM', 'EACL', 'COLING', 'ICCAD', 'SIGGRAPH', 'ICLR', 'IJCV', 'TIP', 'TNNLS', 'TCSVT', 'TRO',
  'RAL', 'IJRR', 'TOIS', 'TKDD', 'TIST', 'AIJ', 'JAIR',
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

/* ---------------- 网络请求 ---------------- */

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

// 所有请求共用一个队列，并保持最小间隔
let lastRequestAt = 0;
let requestQueue = Promise.resolve();
function throttle() {
  const turn = requestQueue.then(async () => {
    const wait = lastRequestAt + CONFIG.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  requestQueue = turn;
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

// 创建一个数据源的客户端：按顺序尝试多个地址，记住能用的那个
function createClient({ name, bases, accept, isValid }) {
  const memo = new Map();
  let preferred = 0;
  // 相对地址是和网页同源的中转服务；没有中转服务（404）或直接打开文件时跳过
  const isLocal = (base) => !/^https?:\/\//i.test(base);
  const disabled = new Set();
  if (location.protocol === 'file:') {
    bases.forEach((base, i) => isLocal(base) && disabled.add(i));
  }

  async function request(url) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: accept } });
    } catch (e) {
      throw new ApiError(`无法连接 ${name}`, { network: true });
    }
    let body;
    try {
      body = await res.text();
    } catch (e) {
      throw new ApiError(`读取 ${name} 数据时连接中断`, { network: true });
    }
    let data = null;
    try {
      data = parseJson(body);
    } catch (e) {
      /* 下面统一处理 */
    }
    if (!res.ok) {
      // server.py 的错误放在 error 字段，SPARQL 服务（QLever）的放在 exception 字段，OpenReview 的放在 message 字段
      const detail = data && (data.error || (data.exception && `${name} 查询出错：${data.exception}`)
        || (data.message && `${name} 返回错误：${data.message}`));
      throw new ApiError(detail || `${name} 返回错误（HTTP ${res.status}）：${preview(body)}`, { status: res.status });
    }
    if (!isValid(data)) {
      console.error(`${name} 返回的内容无法解析：`, body.slice(0, 2000));
      throw new ApiError(`${name} 返回的数据无法解析（开头内容：${preview(body)}）`, { status: res.status });
    }
    return data;
  }

  // suffix 是地址后面的部分，例如 '?query=...' 或 '/notes?...'
  async function get(suffix) {
    if (memo.has(suffix)) return memo.get(suffix);

    let networkErr = new ApiError(`无法连接 ${name}`, { network: true });
    let serverErr = null; // 有状态码的错误比网络错误更能说明问题，优先报告第一个
    for (let attempt = 0; attempt < 3; attempt++) {
      let busy = false;
      for (let i = 0; i < bases.length; i++) {
        const index = (preferred + i) % bases.length;
        const base = bases[index];
        if (disabled.has(index)) continue;
        await throttle();
        try {
          const data = await request(base + suffix);
          preferred = index;
          memo.set(suffix, data);
          return data;
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
  const localProxyMissing = () => bases.some((base, i) => isLocal(base) && disabled.has(i));

  return { get, localProxyMissing };
}

const dblp = createClient({
  name: 'dblp',
  bases: CONFIG.endpoints,
  accept: 'application/sparql-results+json',
  isValid: (d) => !!(d && d.results && Array.isArray(d.results.bindings)),
});

const openreview = createClient({
  name: 'OpenReview',
  bases: CONFIG.openreview,
  accept: 'application/json',
  isValid: (d) => !!(d && (Array.isArray(d.notes) || Array.isArray(d.groups))),
});

async function sparql(query) {
  const data = await dblp.get(`?query=${encodeURIComponent(query)}`);
  return data.results.bindings;
}

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
  if (/^https:\/\/openreview\.net\/pdf\b/.test(u)) return 'PDF';
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

// 从开放获取站点的论文页地址推出 PDF 的直接下载地址；推不出来（例如需要订阅的出版社）返回空
const PDF_RULES = [
  // CVF（CVPR、ICCV、WACV）：…/html/xxx_paper.html → …/papers/xxx_paper.pdf
  [/^https:\/\/openaccess\.thecvf\.com\/(.+)\/html\/([^/]+)\.html$/i, (m) => `https://openaccess.thecvf.com/${m[1]}/papers/${m[2]}.pdf`],
  [/^https:\/\/arxiv\.org\/abs\/(.+)$/i, (m) => `https://arxiv.org/pdf/${m[1]}`],
  [/^https:\/\/openreview\.net\/forum\?id=([^&#]+)/i, (m) => `https://openreview.net/pdf?id=${m[1]}`],
  // ACL Anthology：2024.acl-long.1 或 P19-1001 这样的论文编号
  [/^https:\/\/(?:www\.)?(?:aclanthology\.org|aclweb\.org\/anthology)\/(\d{4}\.[\w-]+\.\d+|[A-Z]\d{2}-\d{4})\/?$/i,
    (m) => `https://aclanthology.org/${m[1]}.pdf`],
  // PMLR（ICML、CoRL、AISTATS 等）：v235/smith24a.html → v235/smith24a/smith24a.pdf
  [/^https:\/\/proceedings\.mlr\.press\/(v\d+)\/([^/]+)\.html$/i, (m) => `https://proceedings.mlr.press/${m[1]}/${m[2]}/${m[2]}.pdf`],
  // NeurIPS：…/hash/<id>-Abstract-Conference.html → …/file/<id>-Paper-Conference.pdf
  [/^https:\/\/((?:proceedings|papers)\.(?:neurips|nips)\.cc)\/(.+)\/hash\/([0-9a-f]+)-Abstract(-\w+)?\.html$/i,
    (m) => `https://${m[1]}/${m[2]}/file/${m[3]}-Paper${m[4] || ''}.pdf`],
  [/^https:\/\/(?:www\.)?ijcai\.org\/proceedings\/(\d{4})\/(\d+)$/i,
    (m) => `https://www.ijcai.org/proceedings/${m[1]}/${m[2].padStart(4, '0')}.pdf`],
  [/^https:\/\/(?:www\.)?jmlr\.org\/papers\/v(\d+)\/([^/]+)\.html$/i, (m) => `https://jmlr.org/papers/volume${m[1]}/${m[2]}/${m[2]}.pdf`],
  [/^https:\/\/(?:www\.)?isca-archive\.org\/(.+)\.html$/i, (m) => `https://www.isca-archive.org/${m[1]}.pdf`],
  // RSS（Robotics: Science and Systems）：rss20/p001.html → rss20/p001.pdf
  [/^https:\/\/(?:www\.)?roboticsproceedings\.org\/(rss\d+\/p\d+)\.html$/i, (m) => `https://www.roboticsproceedings.org/${m[1]}.pdf`],
];

function pdfLink(links) {
  for (const link of links) {
    const url = link.replace(/^http:\/\//i, 'https://');
    if (/\.pdf($|[?#])/i.test(url)) return url; // 本身就是 PDF（例如 PVLDB）
    for (const [pattern, build] of PDF_RULES) {
      const m = pattern.exec(url);
      if (m) return build(m);
    }
  }
  return '';
}

// 名称及其别名（小写）
function withAliases(names) {
  const all = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  for (const group of ALIAS_GROUPS) {
    if (group.some((n) => all.has(n))) group.forEach((n) => all.add(n));
  }
  return [...all];
}

function searchTerms(query) {
  return withAliases([query]);
}

/* ---------------- 查询 ---------------- */

const VENUE_SELECT = `SELECT ?stream (SAMPLE(?pt) AS ?primary) (SAMPLE(?t) AS ?title)
  (SAMPLE(?lb) AS ?label) (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)`;
const VENUE_PATTERNS = `?stream dblp:streamTitle ?t .
  ?stream rdf:type ?type .
  OPTIONAL { ?stream dblp:primaryStreamTitle ?pt }
  OPTIONAL { ?stream rdfs:label ?lb }`;

async function searchVenues(query) {
  const cacheKey = 'venue2:' + query.trim().toLowerCase();
  const cached = store.get(cacheKey);
  if (cached) return cached;

  const terms = searchTerms(query);
  const q = terms[0];

  // 1. 按 dblp 标识精确查找（例如 conf/cvpr、journals/pami），保证缩写一定能找到
  const keys = terms.filter((t) => /^[a-z0-9][\w.-]*$/.test(t));
  const iris = keys.flatMap((k) => ['conf', 'journals', 'series'].map((kind) => `<${STREAM_BASE}${kind}/${k}>`));
  const exactRows = iris.length
    ? await sparql(`${PREFIXES}${VENUE_SELECT}
WHERE {
  VALUES ?stream { ${iris.join(' ')} }
  ${VENUE_PATTERNS}
}
GROUP BY ?stream`)
    : [];

  // 2. 按名称模糊查找；很短的缩写（如 AI、TC）只匹配括号里的缩写，否则几乎所有标题都会匹配
  const titleCondition = q.length <= 3
    ? `CONTAINS(LCASE(STR(?t)), ${literal(`(${q})`)})`
    : `CONTAINS(LCASE(STR(?t)), ${literal(q)})`;
  const fuzzyRows = await sparql(`${PREFIXES}${VENUE_SELECT}
WHERE {
  ${VENUE_PATTERNS}
  FILTER(${titleCondition} || CONTAINS(LCASE(STR(?stream)), ${literal('/' + q)}))
}
GROUP BY ?stream
LIMIT 1000`);

  const venues = [];
  const seen = new Set();
  for (const row of [...exactRows, ...fuzzyRows]) {
    const iri = val(row, 'stream');
    const stream = iri.startsWith(STREAM_BASE) ? iri.slice(STREAM_BASE.length) : '';
    if (!STREAM_KEY.test(stream) || seen.has(stream)) continue;
    seen.add(stream);
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
  const rows = await sparql(`${PREFIXES}SELECT ?year (COUNT(DISTINCT ?publ) AS ?count)
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

// 加载某一年的一页论文（按标题排序），返回 { papers, proceedings, hasMore }
async function fetchPapers(venue, year, offset = 0) {
  const rows = await sparql(`${PREFIXES}SELECT ?publ (SAMPLE(?t) AS ?title) (SAMPLE(?d) AS ?doi)
  (GROUP_CONCAT(DISTINCT STR(?type); SEPARATOR=" ") AS ?types)
  (GROUP_CONCAT(DISTINCT STR(?page); SEPARATOR=" ") AS ?pages)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?ord), "|", STR(?name)); SEPARATOR="||") AS ?authors)
WHERE {
  {
    SELECT ?publ ?t WHERE {
      ?publ dblp:publishedInStream ${streamIri(venue.stream)} .
      ${YEAR_PATTERNS}
      FILTER(STR(COALESCE(?ye, ?yp)) = ${literal(String(year))})
      ?publ dblp:title ?t .
    }
    ORDER BY ?t ?publ
    LIMIT ${PAGE_SIZE}
    OFFSET ${offset}
  }
  ?publ rdf:type ?type .
  OPTIONAL { ?publ dblp:doi ?d }
  OPTIONAL { ?publ dblp:documentPage ?page }
  OPTIONAL { ?publ dblp:hasSignature ?sig . ?sig dblp:signatureOrdinal ?ord . ?sig dblp:signatureDblpName ?name }
}
GROUP BY ?publ
ORDER BY ?title`);

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
      id: val(row, 'publ'),
      title: latexToUnicode(val(row, 'title')).replace(/\s*\.$/, ''),
      authors,
      year: String(year),
      venue: venueLabel(venue),
      links,
      pdf: pdfLink(links),
      dblp: safeUrl(val(row, 'publ')),
    };
    (/#Editorship\b/.test(val(row, 'types')) ? proceedings : papers).push(paper);
  }
  return { papers, proceedings, hasMore: rows.length >= PAGE_SIZE };
}

/* ---------------- OpenReview（补充 dblp 尚未收录的年份） ---------------- */

// OpenReview 上所有会场的 ID，例如 robot-learning.org/CoRL/2025/Conference
async function openreviewVenueIds() {
  const cached = store.get('openreview-venues');
  if (cached) return cached;
  const data = await openreview.get('/groups?id=venues');
  const group = (data.groups || [])[0];
  const ids = (group && Array.isArray(group.members) ? group.members : []).filter((id) => typeof id === 'string');
  if (ids.length) store.set('openreview-venues', ids, DAY);
  return ids;
}

// 找出和这个会议对应的 OpenReview 主会场（每年一个），返回 [{ year, venueid }]
function matchOpenReviewVenues(venue, ids) {
  const names = new Set(withAliases([venue.acronym || '', venue.stream.split('/').pop()]));
  const byYear = new Map();
  for (const id of ids) {
    const parts = id.split('/');
    if (parts[parts.length - 1] !== 'Conference') continue; // 只要主会，不要 workshop 等
    const yi = parts.findIndex((part) => /^(19|20)\d\d$/.test(part));
    if (yi < 1) continue;
    const prefix = parts.slice(0, yi).map((part) => part.toLowerCase().replace(/\.cc$/, ''));
    if (!prefix.some((part) => names.has(part))) continue;
    const year = Number(parts[yi]);
    const current = byYear.get(year);
    if (!current || id.length < current.length) byYear.set(year, id);
  }
  return [...byYear].map(([year, venueid]) => ({ year, venueid }));
}

function openreviewPaper(note, venue, year) {
  const content = note.content || {};
  // API v2 的字段形如 { value: ... }，旧版直接是值
  const field = (key) => {
    const v = content[key];
    return v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v;
  };
  const id = encodeURIComponent(String(note.id || ''));
  const forum = encodeURIComponent(String(note.forum || note.id || ''));
  const links = [`https://openreview.net/forum?id=${forum}`];
  return {
    id: String(note.id || ''),
    title: latexToUnicode(String(field('title') || '').trim()).replace(/\s*\.$/, ''),
    authors: (Array.isArray(field('authors')) ? field('authors') : []).map(String),
    year: String(year),
    venue: venueLabel(venue),
    links,
    pdf: field('pdf') ? `https://openreview.net/pdf?id=${id}` : '',
    dblp: '',
  };
}

// 可能对应 dblp 所缺年份的 OpenReview 主会场
async function openreviewCandidates(venue) {
  const names = withAliases([venue.acronym || '', venue.stream.split('/').pop()]);
  const prefix = names.map((n) => OPENREVIEW_PREFIXES[n]).find(Boolean);
  if (prefix) {
    // 已知的会议直接试最近几年，不用下载完整的会场列表
    const now = new Date().getFullYear();
    return [now + 1, now, now - 1, now - 2].map((year) => ({ year, venueid: `${prefix}/${year}/Conference` }));
  }
  return matchOpenReviewVenues(venue, await openreviewVenueIds());
}

// 确认这一年在 OpenReview 上确实有已录用的论文（有的会议只用 OpenReview 审稿，论文不公开），顺便拿到篇数
async function openreviewAcceptedCount(venueid) {
  const params = new URLSearchParams({ 'content.venueid': venueid, limit: 1 });
  const data = await openreview.get(`/notes?${params}`);
  if (!(data.notes || []).length) return 0;
  return Number.isInteger(data.count) ? data.count : -1; // -1：有论文，但不知道具体数量
}

// 加载 OpenReview 上某一年的一页已录用论文，返回 { papers, proceedings, hasMore }
async function fetchOpenReviewPapers(venue, entry, offset = 0) {
  const params = new URLSearchParams({ 'content.venueid': entry.venueid, limit: PAGE_SIZE, offset });
  const data = await openreview.get(`/notes?${params}`);
  const notes = data.notes || [];
  const papers = notes.map((note) => openreviewPaper(note, venue, entry.year)).filter((p) => p.title);
  return { papers, proceedings: [], hasMore: notes.length >= PAGE_SIZE };
}

/* ---------------- 界面 ---------------- */

const state = {
  query: '',
  venues: [],
  venue: null, // { stream, name, acronym, type, url }
  years: [],
  year: null,
  rows: [],
  paging: null, // { load(offset), offset, total, hasMore, seen }
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
      return '当前是直接打开的 index.html 文件，浏览器会拦截对 dblp 等数据源的请求。'
        + '请在项目目录运行 python3 server.py，然后打开终端里显示的地址。';
    }
    if (dblp.localProxyMissing() && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      return `当前页面（${location.host}）不是由 server.py 提供的，可能是之前的 python3 -m http.server 还在运行。`
        + '请关掉它，重新运行 python3 server.py，然后打开终端里显示的地址（以 http://127.0.0.1 开头）。';
    }
    return `${err.message}（通常是浏览器的跨域限制）。本地使用请在项目目录运行 python3 server.py，`
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
  for (const [group, names] of Object.entries(POPULAR)) {
    const row = el('div', { class: 'chip-row' }, [el('span', { class: 'chip-label', text: group })]);
    for (const chip of names) {
      const { label, venue } = typeof chip === 'string' ? { label: chip } : chip;
      const restore = venue ? { venue, label } : {};
      row.append(el('button', { type: 'button', class: 'chip', text: label, onclick: () => runSearch(label, restore) }));
    }
    box.append(row);
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
  showSuggestions([]);
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
  if (!venues.length && restore.venue && STREAM_KEY.test(restore.venue)) {
    selectVenue(fallbackVenue(restore.venue, restore.label), restore);
    return;
  }
  if (!venues.length) {
    const guesses = didYouMean(query);
    setStatus(`没有找到名称包含“${query}”的会议或期刊，`
      + (guesses.length ? '是不是拼错了？' : '换个写法试试（例如用缩写 CVPR、TPAMI，或英文全称）。'), 'error');
    showSuggestions(guesses);
    return;
  }
  renderVenues();

  const wanted = restore.venue && venues.find((v) => v.stream === restore.venue);
  if (wanted) {
    selectVenue(restore.label ? { ...wanted, acronym: restore.label } : wanted, restore);
  } else if (restore.venue && STREAM_KEY.test(restore.venue)) {
    selectVenue(fallbackVenue(restore.venue, restore.label), restore);
  } else if (venues.length === 1 || venueScore(venues[0], query) >= 100) {
    selectVenue(venues[0]);
  } else {
    setStatus(`找到 ${venues.length} 个匹配项，请选择一个。`);
  }
}

// 编辑距离（允许相邻字母对调），用来猜测拼错的缩写，例如 ICRL → ICLR
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function sameLetters(a, b) {
  const key = (x) => [...x.toLowerCase()].sort().join('');
  return key(a) === key(b) ? 1 : 0;
}

function didYouMean(query) {
  const q = query.trim().toLowerCase();
  const limit = q.length <= 5 ? 1 : 2;
  const seen = new Set();
  return KNOWN_ACRONYMS
    .filter((name) => !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()))
    .map((name) => ({ name, d: editDistance(q, name.toLowerCase()) }))
    .filter((x) => x.d > 0 && x.d <= limit)
    // 距离相同时，字母完全相同（只是顺序不同）的排前面
    .sort((a, b) => a.d - b.d || sameLetters(q, b.name) - sameLetters(q, a.name))
    .slice(0, 5)
    .map((x) => x.name);
}

function showSuggestions(names) {
  const box = $('suggest');
  box.textContent = '';
  box.hidden = !names.length;
  if (!names.length) return;
  box.append(el('span', { class: 'chip-label', text: '你是不是要找：' }));
  for (const name of names) {
    box.append(el('button', { type: 'button', class: 'chip', text: name, onclick: () => runSearch(name) }));
  }
}

function fallbackVenue(stream, label) {
  const [kind, key] = stream.split('/');
  const name = label || key.toUpperCase();
  const type = kind === 'journals' ? 'Journal' : kind === 'conf' ? 'Conference or Workshop' : '';
  return { stream, name, acronym: name, type, url: `https://dblp.org/db/${stream}/` };
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

  const showAcronym = venue.acronym && venue.acronym !== venue.name && !venue.name.includes(`(${venue.acronym})`);
  $('venue-title').textContent = showAcronym ? `${venue.acronym} · ${venue.name}` : venue.name;
  $('venue-link').href = venue.url;
  $('years').textContent = '';
  showYearsNote('');
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
    state.years = years.map((y) => ({ ...y, source: 'dblp' }));
    renderYears();
  } catch (err) {
    if (isCurrent()) setStatus(errorMessage(err), 'error');
    return;
  }

  // dblp 通常要过几个月才收录新会议，用 OpenReview 补上缺的年份（只针对会议）
  const isConference = !venue.type || venue.type === 'Conference or Workshop';
  if (isConference && state.year === null) {
    setStatus(`正在检查 OpenReview 上有没有 dblp 尚未收录的年份…`, 'loading');
  }
  const extra = [];
  if (isConference) try {
    const known = new Set(state.years.map((y) => y.year));
    const candidates = (await openreviewCandidates(venue)).filter((y) => !known.has(y.year));
    for (const candidate of candidates) {
      if (!isCurrent()) return;
      const count = await openreviewAcceptedCount(candidate.venueid);
      if (count) extra.push({ ...candidate, count: Math.max(count, 0), source: 'openreview' });
    }
  } catch (err) {
    console.warn('OpenReview 暂时不可用：', err);
    if (isCurrent()) {
      showYearsNote(`OpenReview 查询失败，dblp 尚未收录的最新年份可能缺失。原因：${errorMessage(err)}`,
        err.status === 401 || err.status === 403 ? openreviewPageLinks(venue) : []);
    }
  }
  if (!isCurrent()) return;
  if (extra.length) {
    state.years = [...state.years, ...extra].sort((a, b) => b.year - a.year);
    renderYears();
  }

  if (!state.years.length) {
    setStatus(`dblp 中没有找到 ${venueLabel(venue)} 的论文。`, 'error');
    return;
  }
  const target = Number(restore.year) || null;
  if (target) {
    loadYear(target);
  } else if (state.year === null) {
    const note = extra.length
      ? `其中 ${extra.map((y) => y.year).join('、')} 年 dblp 尚未收录，论文来自 OpenReview。`
      : '';
    setStatus(`${venueLabel(venue)} 共有 ${state.years.length} 个年份，点击年份查看论文列表。${note}`);
  }
}

function showYearsNote(message, links = []) {
  const note = $('years-note');
  note.textContent = message;
  if (links.length) {
    note.append(el('br'), '也可以直接在 OpenReview 网站上查看：');
    links.forEach(({ text, href }, i) => {
      if (i) note.append(' · ');
      note.append(el('a', { href, target: '_blank', rel: 'noopener', text }));
    });
  }
  note.hidden = !message;
}

// 没登录 OpenReview 时，给出 dblp 尚未收录的最近几年在 OpenReview 网站上的会场页面（浏览器里可以正常访问）
function openreviewPageLinks(venue) {
  const names = withAliases([venue.acronym || '', venue.stream.split('/').pop()]);
  const prefix = names.map((n) => OPENREVIEW_PREFIXES[n]).find(Boolean);
  if (!prefix) return [];
  const known = new Set(state.years.map((y) => y.year));
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2]
    .filter((year) => !known.has(year) && year > Math.max(0, ...known))
    .map((year) => ({
      text: `${venueLabel(venue)} ${year}`,
      href: `https://openreview.net/group?id=${encodeURIComponent(`${prefix}/${year}/Conference`)}`,
    }));
}

function renderYears() {
  const box = $('years');
  box.textContent = '';
  for (const { year, count, source } of state.years) {
    const btn = el('button', {
      type: 'button',
      class: 'year-btn',
      'aria-pressed': String(state.year === year),
      onclick: () => loadYear(year),
    }, [
      el('span', { class: 'year-num', text: String(year) }),
      el('span', { class: 'year-count', text: count ? `${count} 篇` : '' }),
      source === 'openreview' ? el('span', { class: 'year-source', text: '来自 OpenReview' }) : null,
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

  const entry = state.years.find((y) => y.year === year);
  const fromOpenReview = !!entry && entry.source === 'openreview';
  state.paging = {
    load: (offset) => (fromOpenReview ? fetchOpenReviewPapers(venue, entry, offset) : fetchPapers(venue, year, offset)),
    offset: 0,
    total: entry && entry.count > 0 ? entry.count : null,
    hasMore: false,
    seen: new Set(),
  };
  try {
    const result = await state.paging.load(0);
    if (!isCurrent()) return;
    resetPapers(venue, year);
    addPapers(result);
    if (!state.rows.length) {
      setStatus(`${fromOpenReview ? 'OpenReview' : 'dblp'} 中没有 ${venueLabel(venue)} ${year} 的论文。`, 'error');
    } else if (fromOpenReview) {
      setStatus(`dblp 尚未收录 ${venueLabel(venue)} ${year}，以下是 OpenReview 上已录用的论文。`);
    } else {
      setStatus('');
    }
  } catch (err) {
    if (isCurrent()) setStatus(errorMessage(err), 'error');
  }
}

async function loadMore() {
  const paging = state.paging;
  if (!paging || !paging.hasMore) return;
  const token = state.tokens.year;
  const button = $('load-more');
  button.disabled = true;
  button.textContent = '正在加载…';
  try {
    const result = await paging.load(paging.offset);
    if (state.tokens.year !== token) return;
    addPapers(result);
  } catch (err) {
    if (state.tokens.year === token) setStatus(errorMessage(err), 'error');
  } finally {
    button.disabled = false;
    updateCount();
  }
}

function resetPapers(venue, year) {
  $('papers-title').textContent = `${venueLabel(venue)} ${year}`;
  $('filter').value = '';
  const proc = $('proceedings');
  proc.hidden = true;
  proc.open = false;
  proc.querySelector('ul').textContent = '';
  $('papers').textContent = '';
  state.rows = [];
  $('papers-section').hidden = false;
}

// 把一页论文追加到列表
function addPapers({ papers, proceedings, hasMore }) {
  const paging = state.paging;
  paging.offset += PAGE_SIZE;
  const fresh = (p) => {
    if (p.id && paging.seen.has(p.id)) return false; // 翻页边界上可能重复
    paging.seen.add(p.id);
    return true;
  };

  const proc = $('proceedings');
  const procList = proc.querySelector('ul');
  for (const p of proceedings.filter(fresh)) {
    const href = mainLink(p);
    procList.append(el('li', {}, [href
      ? el('a', { href, target: '_blank', rel: 'noopener', text: p.title })
      : document.createTextNode(p.title)]));
  }
  const volumes = procList.children.length;
  proc.hidden = !volumes;
  proc.querySelector('summary').textContent = `论文集（${volumes} 卷）`;

  const terms = filterTerms();
  const frag = document.createDocumentFragment();
  for (const p of papers.filter(fresh)) {
    const href = mainLink(p);
    const links = p.links.map((u) => el('a', { href: u, target: '_blank', rel: 'noopener', text: linkLabel(u) }));
    if (p.dblp) links.push(el('a', { href: p.dblp, target: '_blank', rel: 'noopener', text: 'dblp' }));
    const li = el('li', { class: 'paper' }, [
      el('div', { class: 'paper-head' }, [
        href
          ? el('a', { class: 'paper-title', href, target: '_blank', rel: 'noopener', text: p.title })
          : el('span', { class: 'paper-title nolink', text: p.title }),
        p.pdf ? pdfButton(p) : null,
      ]),
      p.authors.length ? el('div', { class: 'paper-authors', text: p.authors.join(', ') }) : null,
      links.length ? el('div', { class: 'paper-links' }, links) : null,
    ]);
    const row = { li, paper: p, haystack: `${p.title} ${p.authors.join(' ')}`.toLowerCase() };
    li.hidden = !matches(row, terms);
    state.rows.push(row);
    frag.append(li);
  }
  $('papers').append(frag);
  // 知道总数时按已加载数判断；一页是空的说明已经到底
  const pageEmpty = !papers.length && !proceedings.length;
  paging.hasMore = !pageEmpty && (paging.total ? state.rows.length < paging.total : hasMore);
  updateCount();
}

function pdfButton(p) {
  const button = el('a', {
    class: 'pdf-btn',
    href: p.pdf,
    target: '_blank',
    rel: 'noopener',
    title: '下载 PDF',
    'aria-label': `下载 PDF：${p.title}`,
  });
  button.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2v8m0 0L4.5 6.5M8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.append('PDF');
  return button;
}

function visibleRows() {
  return state.rows.filter((r) => !r.li.hidden);
}

function updateCount() {
  const shown = visibleRows().length;
  const loaded = state.rows.length;
  const paging = state.paging || {};
  const total = paging.total && paging.total > loaded ? paging.total : null;
  let text;
  if (shown !== loaded) text = `显示 ${shown} / 已加载 ${loaded} 篇`;
  else if (paging.hasMore) text = total ? `已加载 ${loaded} / ${total} 篇` : `已加载 ${loaded} 篇`;
  else text = `共 ${loaded} 篇`;
  $('papers-count').textContent = text;

  const button = $('load-more');
  button.hidden = !paging.hasMore;
  if (!button.disabled) {
    button.textContent = total ? `加载更多（还有 ${total - loaded} 篇）` : '加载更多';
  }
}

function filterTerms() {
  return $('filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(row, terms) {
  return terms.every((t) => row.haystack.includes(t));
}

function applyFilter() {
  const terms = filterTerms();
  for (const row of state.rows) row.li.hidden = !matches(row, terms);
  updateCount();
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const rows = visibleRows();
  if (!rows.length) return;
  const header = ['title', 'authors', 'year', 'venue', 'link', 'pdf', 'all_links', 'dblp'];
  const lines = [header.join(',')];
  for (const { paper: p } of rows) {
    lines.push([
      p.title, p.authors.join('; '), p.year, p.venue, mainLink(p), p.pdf, p.links.join(' '), p.dblp,
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
  $('load-more').addEventListener('click', loadMore);

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
