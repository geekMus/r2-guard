# R2-Guard

Cloudflare Workers + R2 的高性能对象访问代理 Worker

## 特点

- 安全、统一地对外提供 R2 对象访问

- 支持 Range 分片下载 / 视频拖拽

- 自动处理 CORS / 缓存 / ETag / 304

- 根据 MIME 类型智能决定 预览（inline）或下载（attachment）

- 提供美观、可读的 HTML 错误页面

## 部署

将此仓库下的 workers.js 部署到 Cloudflare Workers 中即可

绑定 R2 资源，名称为 BUCKET

## 配置变量

环境变量：

- `FORCE_PREVIEW_TYPES` (可选): 强制预览类型，希望所有文件都强制预览，则设置为 `/`
- `FORCE_DOWNLOAD_TYPES` (可选): 强制下载类型

可选值来自 MIME 类型列表
