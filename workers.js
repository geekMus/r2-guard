/**
 * 🌐 Cloudflare Worker - R2 专用下载 + 可配置文件预览策略（统一错误页面）
 * ----------------------------------------------------------
 * 功能特性：
 * ✅ 仅访问 R2 对象存储
 * ✅ 支持 Range 请求（分片/多线程下载）
 * ✅ 根据 Content-Type 智能决定 inline / attachment
 * ✅ 自动补全 charset=utf-8
 * ✅ 错误页面美观、统一
 */

const CHARSET_DEFAULT = 'utf-8';
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/* -------------------- 工具函数 -------------------- */

const parseMimeList = (mimeStr) => {
	if (!mimeStr) return [];
	return mimeStr
		.split(',')
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
};

const generateErrorPage = (statusCode, customMessage = null) => {
	const msg =
		customMessage ||
		(statusCode === 404 ? '抱歉，您请求的资源未找到' : statusCode === 416 ? '请求的范围无效' : '请求的资源可能需要特殊权限或者暂时不可用');

	return new Response(
		`<!DOCTYPE html>
		<html lang="zh-CN">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>${customMessage ? '配置错误' : '状态 ' + statusCode}</title>
			<style>
				body {
					font-family: system-ui, sans-serif;
					display: flex;
					justify-content: center;
					align-items: center;
					height: 100vh;
					margin: 0;
					background: #f4f6fb;
				}
				.container {
					text-align: center;
					background: white;
					padding: 2rem 3rem;
					border-radius: 12px;
					box-shadow: 0 5px 25px rgba(0,0,0,0.1);
				}
				.status { font-size: 4rem; color: #667eea; font-weight: bold; }
				h1 { margin: 0.5rem 0; color: #333; }
				p { color: #666; }
			</style>
		</head>
		<body>
			<div class="container">
				<h1>${customMessage ? '配置错误' : '请求状态'}</h1>
				<div class="status">${customMessage ? '!' : statusCode}</div>
				<p>${msg}</p>
			</div>
		</body>
		</html>`,
		{
			status: customMessage ? 500 : statusCode,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}
	);
};

// 解析 Range 请求
function parseRange(rangeHeader, totalLength) {
	if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
	const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
	let start = parseInt(startStr, 10);
	let end = endStr ? parseInt(endStr, 10) : totalLength - 1;
	if (isNaN(start) || start < 0 || start >= totalLength) return null;
	if (isNaN(end) || end >= totalLength) end = totalLength - 1;
	if (end < start) return null;
	return { start, end };
}

// 根据 Content-Type 判定 inline / attachment
const getDisposition = (contentType, env) => {
	if (!contentType) return 'attachment';
	contentType = contentType.toLowerCase();

	const forcePreviewList = parseMimeList(env.FORCE_PREVIEW_TYPES);
	const forceDownloadList = parseMimeList(env.FORCE_DOWNLOAD_TYPES);

	if (forcePreviewList.some((t) => contentType.includes(t))) return 'inline';
	if (forceDownloadList.some((t) => contentType.includes(t))) return 'attachment';

	if (contentType.startsWith('image/')) return 'inline';
	if (contentType.startsWith('text/')) return 'inline';
	if (contentType.includes('application/pdf')) return 'inline';

	const otherPreview = ['application/json', 'application/xml', 'application/javascript', 'text/javascript'];
	if (otherPreview.some((t) => contentType.includes(t))) return 'inline';

	return 'attachment';
};

/* -------------------- R2 下载逻辑 -------------------- */

const handleR2Request = async (request, env) => {
	if (!ALLOWED_METHODS.has(request.method)) {
		return generateErrorPage(405, '不允许的请求方法');
	}

	const url = new URL(request.url);
	const key = url.pathname.slice(1);
	if (!key) return generateErrorPage(404);

	const objMeta = await env.BUCKET.head(key).catch(() => null);
	if (!objMeta) return generateErrorPage(404);

	const totalLength = objMeta.size;
	const contentType = objMeta.httpMetadata?.contentType || 'application/octet-stream';

	const headers = new Headers();
	headers.set('Content-Type', contentType);
	headers.set('Accept-Ranges', 'bytes');

	const rangeHeader = request.headers.get('Range');
	let status, body;

	if (rangeHeader) {
		const range = parseRange(rangeHeader, totalLength);
		if (!range) return generateErrorPage(416); // 无效 Range

		const { start, end } = range;
		const chunkLength = end - start + 1;

		const obj = await env.BUCKET.get(key, { range: { offset: start, length: chunkLength } });
		if (!obj) return generateErrorPage(404);

		headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);
		headers.set('Content-Length', chunkLength.toString());

		status = 206;
		body = obj.body;
	} else {
		const obj = await env.BUCKET.get(key);
		if (!obj) return generateErrorPage(404);

		headers.set('Content-Length', totalLength);
		status = 200;
		body = obj.body;
	}

	// 设置 Content-Disposition
	const disposition = getDisposition(contentType, env);
	headers.set('Content-Disposition', disposition);

	// 自动补充 charset=utf-8
	if (contentType.startsWith('text/') && !contentType.includes('charset')) {
		headers.set('Content-Type', `${contentType}; charset=${CHARSET_DEFAULT}`);
	}

	return new Response(body, { status, headers });
};

/* -------------------- Cloudflare Worker 入口 -------------------- */

export default {
	async fetch(request, env) {
		return handleR2Request(request, env);
	},
};
