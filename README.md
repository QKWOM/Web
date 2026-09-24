# 会议论文速查

输入会议名称（如 `CVPR`、`NeurIPS`、`ACL`），按年份列出该会议每篇论文的链接。数据来自 [dblp](https://dblp.org)。

纯静态网页（HTML + CSS + JavaScript），不需要后端，也不需要安装依赖。

## 功能

- 按会议名称或缩写搜索，同名的会议和 workshop 会列出来供选择
- 列出该会议所有年份及每年的论文数量，点击年份加载论文
- 每篇论文显示标题、作者和链接：开放获取页面（CVF、OpenReview、ACL Anthology、PMLR 等）优先，另附 DOI 和 dblp 链接
- 按标题或作者筛选
- 导出 CSV（Excel 可直接打开），或一键复制所有论文链接
- 地址栏会记住当前查询，例如 `?q=CVPR&venue=conf/cvpr&year=2024`，可以直接分享

## 本地运行

```bash
python3 -m http.server 8000
```

然后在浏览器打开 <http://localhost:8000>。

## 部署到 GitHub Pages

1. 打开仓库的 **Settings → Pages**
2. **Source** 选择 **Deploy from a branch**
3. 选择要发布的分支和 `/ (root)` 目录，保存
4. 等一两分钟后，访问页面上显示的网址

## 工作原理

网页在浏览器中直接调用 dblp 的公开 API：

| 步骤 | 请求 |
| --- | --- |
| 搜索会议 | `https://dblp.org/search/venue/api?q=CVPR&format=json` |
| 获取年份和每年论文数 | `https://dblp.org/search/publ/api?q=streamid:conf/cvpr: year:&c=1000&format=json`（利用搜索补全；如果拿不到，就逐年查询） |
| 获取某一年的论文 | `https://dblp.org/search/publ/api?q=streamid:conf/cvpr: year:2024&h=1000&f=0&format=json`（每次最多 1000 条，自动翻页） |

请求会自动排队，两次请求至少间隔 0.4 秒，避免给 dblp 造成压力。遇到限流（HTTP 429）会等待后重试。

## 如果提示“无法连接 dblp”

网页会依次尝试：

1. 直接请求 `dblp.org`
2. 请求官方镜像 `dblp.uni-trier.de`
3. 改用 JSONP 方式请求

如果都失败，可能是浏览器拦截了跨域请求，或者当前网络访问不了 dblp。这时可以部署 [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js) 作为中转：

1. 在 Cloudflare 控制台新建一个 Worker，把该文件内容粘贴进去并部署
2. 把 Worker 地址加到 `app.js` 里 `CONFIG.apiBases` 的最前面：

   ```js
   apiBases: ['https://你的-worker.workers.dev', 'https://dblp.org', 'https://dblp.uni-trier.de'],
   ```

## 已知限制

- 论文链接大多指向出版方或 DOI 页面，不一定能免费下载 PDF。
- dblp 单个查询最多返回 10000 条结果，一年论文超过这个数时只能显示一部分（目前没有会议到这个规模）。
- 论文数据以 dblp 收录为准：刚开完的会议可能还没被收录。
