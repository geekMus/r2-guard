# R2-Guard

基于 Cloudflare Workers 的 R2 资源守卫，可以控制对资源的访问

## 部署

将此仓库下的 workers.js 部署到 Cloudflare Workers 中即可

绑定 R2 资源，名称为 BUCKET

## 配置变量

环境变量：

- `FORCE_PREVIEW_TYPES` (可选): 强制预览类型，希望所有文件都强制预览，则设置为 `/`
- `FORCE_DOWNLOAD_TYPES` (可选): 强制下载类型

_TYPES 可选值来自 MIME 类型列表
