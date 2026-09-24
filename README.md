# 会议论文速查

输入会议名称（如 `CVPR`、`NeurIPS`、`ACL`），按年份列出该会议每篇论文的链接。数据来自 [dblp](https://dblp.org)。

网页本身是纯静态的（HTML + CSS + JavaScript）。本地使用时，自带的 `server.py` 负责提供网页并代为请求 dblp，只用到 Python 标准库，不需要安装任何依赖。

## 功能

- 按会议名称或缩写搜索，同名的会议和 workshop 会列出来供选择
- 列出该会议所有年份及每年的论文数量，点击年份加载论文
- 每篇论文显示标题、作者和链接：开放获取页面（CVF、OpenReview、ACL Anthology、PMLR 等）优先，另附 DOI 和 dblp 链接
- 按标题或作者筛选
- 导出 CSV（Excel 可直接打开），或一键复制所有论文链接
- 地址栏会记住当前查询，例如 `?q=CVPR&venue=conf/cvpr&year=2024`，可以直接分享

## 本地运行

```bash
python3 server.py
```

会自动打开浏览器，地址以终端里显示的为准（默认 <http://127.0.0.1:8000>，端口被占用时会自动换一个）。终端里还会显示 dblp 是否连接正常。按 `Ctrl + C` 停止。

> 请不要用 `python3 -m http.server` 或直接双击 `index.html` 打开：浏览器通常会因为跨域限制拦截对 dblp 的请求，页面会提示“浏览器无法直接访问 dblp”。`server.py` 会在本机代为请求 dblp，从而绕过这个限制。

## 部署到 GitHub Pages

1. 打开仓库的 **Settings → Pages**
2. **Source** 选择 **Deploy from a branch**
3. 选择要发布的分支和 `/ (root)` 目录，保存
4. 等一两分钟后，访问页面上显示的网址

GitHub Pages 只能放静态文件，没法运行 `server.py`。如果在线访问时提示“浏览器无法直接访问 dblp”，需要按下文部署一个 Cloudflare Worker 做中转。

## 工作原理

网页调用 dblp 的公开 API（本地使用时经 `server.py` 转发）：

| 步骤 | 请求 |
| --- | --- |
| 搜索会议 | `https://dblp.org/search/venue/api?q=CVPR&format=json` |
| 获取年份和每年论文数 | `https://dblp.org/search/publ/api?q=streamid:conf/cvpr: year:&c=1000&format=json`（利用搜索补全；如果拿不到，就逐年查询） |
| 获取某一年的论文 | `https://dblp.org/search/publ/api?q=streamid:conf/cvpr: year:2024&h=1000&f=0&format=json`（每次最多 1000 条，自动翻页） |

请求会自动排队，两次请求至少间隔 0.4 秒，避免给 dblp 造成压力。遇到限流（HTTP 429）会等待后重试。

## 连接 dblp 失败时

网页会依次尝试：

1. `server.py` 提供的本地中转（`/dblp-proxy/`，只在用 `server.py` 启动时存在）
2. 浏览器直接请求 `dblp.org`，再试官方镜像 `dblp.uni-trier.de`
3. 改用 JSONP 方式请求

常见提示：

- **“浏览器无法直接访问 dblp”**：没有用 `server.py` 启动，浏览器又拦截了跨域请求。本地请改用 `python3 server.py`；在线部署请配置下面的 Cloudflare Worker。
- **“本地服务器也无法连接 dblp”**：本机网络访问不了 dblp。先确认浏览器能打开 <https://dblp.org>；如果需要代理才能访问，`server.py` 会使用系统代理设置，也可以在启动前设置 `HTTPS_PROXY` 环境变量。

在线部署时的中转：部署 [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js)。

1. 在 Cloudflare 控制台新建一个 Worker，把该文件内容粘贴进去并部署
2. 把 Worker 地址加到 `app.js` 里 `CONFIG.apiBases` 的最前面：

   ```js
   apiBases: ['https://你的-worker.workers.dev', 'dblp-proxy', 'https://dblp.org', 'https://dblp.uni-trier.de'],
   ```

## 已知限制

- 论文链接大多指向出版方或 DOI 页面，不一定能免费下载 PDF。
- dblp 单个查询最多返回 10000 条结果，一年论文超过这个数时只能显示一部分（目前没有会议到这个规模）。
- 论文数据以 dblp 收录为准：刚开完的会议可能还没被收录。
