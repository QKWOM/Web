# 会议期刊论文速查

输入会议或期刊名称（如 `CVPR`、`NeurIPS`、`TPAMI`），按年份列出每篇论文的链接。数据来自 [dblp](https://dblp.org)；dblp 尚未收录的年份（通常是最近一两年），会自动从 [OpenReview](https://openreview.net) 补充。

网页本身是纯静态的（HTML + CSS + JavaScript）。本地使用时，自带的 `server.py` 负责提供网页并代为查询 dblp 和 OpenReview，只用到 Python 标准库，不需要安装任何依赖。

## 功能

- 按会议或期刊的名称、缩写搜索，同名的会议、workshop 和期刊会列出来供选择；TPAMI、TNNLS 这类和 dblp 标识不一致的常用缩写也能直接搜
- 列出所有年份及每年的论文数量，点击年份加载论文；每次加载 1000 篇，更多的点“加载更多”
- 会议中 dblp 还没收录的年份从 OpenReview 补充（例如刚开完的 CoRL、ICLR、NeurIPS、ICML），年份按钮上会标注“来自 OpenReview”
- 每篇论文显示标题、作者和链接：开放获取页面（CVF、OpenReview、ACL Anthology、PMLR 等）优先，另附 DOI 和 dblp 链接
- 能直接下载 PDF 的论文，标题右侧有“PDF”按钮（CVF、OpenReview、arXiv、ACL Anthology、PMLR、NeurIPS、IJCAI、JMLR、ISCA 等开放获取来源；IEEE、Springer 等需要订阅的不显示）
- 标题里的 LaTeX 公式（如 `$\beta$-DARTS`、`${\text{CA}^{2}\text{ST}}$`）会转成普通文字显示（β-DARTS、CA²ST）
- 按标题或作者筛选
- 导出 CSV（Excel 可直接打开，含 PDF 地址），或一键复制所有论文链接
- 地址栏会记住当前查询，例如 `?q=CVPR&venue=conf/cvpr&year=2024`，可以直接分享

## 本地运行

```bash
python3 server.py
```

会自动打开浏览器，地址以终端里显示的为准（默认 <http://127.0.0.1:8000>，端口被占用时会自动换一个）。终端里还会显示 dblp 查询服务和 OpenReview 是否连接正常。按 `Ctrl + C` 停止。

> 请不要用 `python3 -m http.server` 或直接双击 `index.html` 打开：浏览器通常会因为跨域限制拦截对 dblp 的请求，`server.py` 会在本机代为请求 dblp，从而绕过这个限制。

## 部署到 GitHub Pages

1. 打开仓库的 **Settings → Pages**
2. **Source** 选择 **Deploy from a branch**
3. 选择要发布的分支和 `/ (root)` 目录，保存
4. 等一两分钟后，访问页面上显示的网址

GitHub Pages 只能放静态文件，没法运行 `server.py`。如果在线访问时提示“浏览器无法直接访问 dblp 的查询服务”，需要按下文部署一个 Cloudflare Worker 做中转。

## 工作原理

数据来自 dblp 官方的 [SPARQL 查询服务](https://sparql.dblp.org/)（`https://sparql.dblp.org/sparql`），这是 dblp 专门提供给程序查询数据的接口。官方服务不可用时，改用弗莱堡大学 QLever 上的 dblp 数据（`https://qlever.cs.uni-freiburg.de/api/dblp`）。本地使用时，请求经 `server.py` 转发。

> dblp 的搜索 API（`dblp.org/search/...`）已加上 Anubis 人机验证，程序请求只会拿到“Making sure you're not a bot!”验证页，所以这里不再使用它。

一共三种查询：

| 步骤 | 查询内容 |
| --- | --- |
| 搜索会议和期刊 | 按 dblp 标识精确查找（如 `conf/cvpr`、`journals/pami`，含常用缩写的别名），再按名称模糊查找；三个字母以内的缩写只匹配名称括号里的缩写，避免 AI、TC 这类缩写匹配到几乎所有名称 |
| 获取年份和每年论文数 | 按年份统计该会议的论文数（不含论文集本身） |
| 获取某一年的论文 | 按标题排序，每次 1000 篇：标题、作者（按署名顺序）、DOI 和全部论文链接 |

### OpenReview 补充

dblp 通常要在会议结束几个月后才收录论文集。选中一个会议（期刊不需要）后，网页会在 OpenReview 的会场列表（`https://api2.openreview.net/groups?id=venues`）里找同名会议的主会场，例如 `robot-learning.org/CoRL/2025/Conference`、`ICLR.cc/2025/Conference`，把 dblp 缺少的年份补上。点这些年份时，列出 OpenReview 上该会场已录用的论文（`/notes?content.venueid=…`），每篇附论文页和 PDF 链接。

- 只使用主会场，不包括 workshop、Datasets and Benchmarks 等分会场。
- 有的会议只用 OpenReview 审稿，不公开论文（例如 CVPR）。这类会场查不到已录用的论文，不会显示。
- OpenReview 连不上时不影响 dblp 的数据，只是少了补充的年份。

### 年份的计算

论文所属年份优先按会议举办年份计算（例如 ECCV 2024 的论文集 2025 年才出版，仍算在 2024 年），没有举办年份时用出版年份。请求会自动排队，两次请求至少间隔 0.3 秒；遇到限流（HTTP 429）会等待后重试。

## 连接 dblp 失败时

网页会依次尝试：

1. `server.py` 提供的本地中转（`/dblp-proxy/sparql`，只在用 `server.py` 启动时存在）
2. 浏览器直接请求 dblp 的 SPARQL 服务，再试 QLever 上的备用数据

`server.py` 启动时会先查询一次，终端里显示“✓ dblp 查询服务连接正常”或具体原因。常见提示：

- **“当前页面不是由 server.py 提供的”**：打开的页面来自别的服务（例如之前的 `python3 -m http.server`）。关掉它，重新运行 `python3 server.py`，打开终端里显示的地址。
- **“本地服务器也无法连接 dblp 查询服务”**：本机网络访问不了 dblp。如果需要代理才能访问，`server.py` 会使用系统代理设置，也可以在启动前设置 `HTTPS_PROXY` 环境变量。
- **“返回的不是查询结果……开头内容：……”**：服务返回了网页（比如人机验证页）而不是数据，开头内容能看出具体原因。

在线部署时的中转：部署 [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js)。

1. 在 Cloudflare 控制台新建一个 Worker，把该文件内容粘贴进去并部署
2. 把 Worker 地址分别加到 `app.js` 里 `CONFIG.endpoints`（以 `/sparql` 结尾）和 `CONFIG.openreview`（以 `/openreview` 结尾）的最前面：

   ```js
   endpoints: [
     'https://你的-worker.workers.dev/sparql',
     'dblp-proxy/sparql',
     'https://sparql.dblp.org/sparql',
     'https://qlever.cs.uni-freiburg.de/api/dblp',
   ],
   openreview: [
     'https://你的-worker.workers.dev/openreview',
     'openreview-proxy',
     'https://api2.openreview.net',
   ],
   ```

## 已知限制

- 论文链接大多指向出版方或 DOI 页面，不一定能免费下载 PDF。
- 刚开完的会议如果不在 OpenReview 上（例如 CVPR、ACL），要等 dblp 收录后才能查到。
- 论文按标题排序，不是论文集里的目录顺序。
