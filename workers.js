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
		(statusCode === 404
			? '抱歉，您请求的资源未找到'
			: statusCode === 416
				? '请求的范围无效'
				: statusCode === 400
					? '请求参数不完整或不合法'
					: '请求的资源可能需要特殊权限或者暂时不可用');

	return new Response(
		`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${statusCode}</title>
<style>
body{
	font-family:system-ui,sans-serif;
	display:flex;
	justify-content:center;
	align-items:center;
	height:100vh;
	background:#f4f6fb;
	margin:0
}
.container{
	background:white;
	padding:2rem 3rem;
	border-radius:12px;
	box-shadow:0 5px 25px rgba(0,0,0,.1);
	text-align:center
}
.status{
	font-size:4rem;
	color:#667eea;
	font-weight:bold
}
</style>
</head>

<body>
<div class="container">
<div class="status">${statusCode}</div>
<h1>${customMessage ? '配置错误' : '请求状态'}</h1>
<p>${msg}</p>
</div>
</body>
</html>`,
		{
			status: customMessage ? 500 : statusCode,
			headers: {
				'Content-Type': 'text/html;charset=utf-8',
			},
		},
	);
};

/*
 Range解析

 支持:
 bytes=0-100
 bytes=100-
*/

function parseRange(rangeHeader, totalLength) {
	if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
		return null;
	}

	const value = rangeHeader.replace('bytes=', '');

	// 不支持多Range
	if (value.includes(',')) {
		return null;
	}

	const [startStr, endStr] = value.split('-');

	let start = Number(startStr);

	let end = endStr ? Number(endStr) : totalLength - 1;

	if (Number.isNaN(start) || start < 0 || start >= totalLength) {
		return null;
	}

	if (Number.isNaN(end) || end >= totalLength) {
		end = totalLength - 1;
	}

	if (end < start) {
		return null;
	}

	return {
		start,
		end,
	};
}

// inline / attachment

const getDisposition = (contentType, env, filename) => {
	const forcePreview = parseMimeList(env.FORCE_PREVIEW_TYPES);

	const forceDownload = parseMimeList(env.FORCE_DOWNLOAD_TYPES);

	const type = contentType.toLowerCase();

	let disposition;

	if (forcePreview.some((t) => type.includes(t))) {
		disposition = 'inline';
	} else if (forceDownload.some((t) => type.includes(t))) {
		disposition = 'attachment';
	} else if (
		type.startsWith('image/') ||
		type.startsWith('text/') ||
		type.includes('application/pdf') ||
		type.includes('application/json') ||
		type.includes('application/xml')
	) {
		disposition = 'inline';
	} else {
		disposition = 'attachment';
	}

	return `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

/* -------------------- CORS -------------------- */

const applyCORS = (headers) => {
	headers.set('Access-Control-Allow-Origin', '*');

	headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');

	headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, If-None-Match');

	headers.set(
		'Access-Control-Expose-Headers',
		['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type', 'Content-Disposition', 'ETag'].join(', '),
	);
};

const withCORS = (response) => {
	const headers = new Headers(response.headers);

	applyCORS(headers);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};

/* -------------------- 主逻辑 -------------------- */

const handleR2Request = async (request, env) => {
	// OPTIONS

	if (request.method === 'OPTIONS') {
		const headers = new Headers();

		applyCORS(headers);

		return new Response(null, {
			status: 204,
			headers,
		});
	}

	if (!ALLOWED_METHODS.has(request.method)) {
		return withCORS(generateErrorPage(405, '不允许的请求方法'));
	}

	const url = new URL(request.url);

	let key;

	try {
		key = decodeURIComponent(url.pathname.slice(1)).trim().replace(/\\/g, '/');

		if (!key) {
			return withCORS(generateErrorPage(404));
		}
	} catch {
		return withCORS(generateErrorPage(400, '路径解析失败'));
	}

	const meta = await env.BUCKET.head(key).catch(() => null);

	if (!meta) {
		return withCORS(generateErrorPage(404));
	}

	const totalLength = meta.size;

	const contentType = meta.httpMetadata?.contentType || 'application/octet-stream';

	const etag = meta.etag;

	const filename = key.split('/').pop();

	const headers = new Headers();

	headers.set('Content-Type', contentType);

	headers.set('Accept-Ranges', 'bytes');

	headers.set('ETag', etag);

	headers.set('Cache-Control', 'public,max-age=300,stale-while-revalidate=3600');

	headers.set('Content-Disposition', getDisposition(contentType, env, filename));

	// 304

	const ifNoneMatch = request.headers.get('If-None-Match');

	if (ifNoneMatch && ifNoneMatch === etag) {
		return withCORS(
			new Response(null, {
				status: 304,
				headers,
			}),
		);
	}

	// HEAD

	if (request.method === 'HEAD') {
		headers.set('Content-Length', totalLength.toString());

		return withCORS(
			new Response(null, {
				status: 200,
				headers,
			}),
		);
	}

	let body;

	let status = 200;

	const rangeHeader = request.headers.get('Range');

	if (rangeHeader) {
		const range = parseRange(rangeHeader, totalLength);

		if (!range) {
			return withCORS(generateErrorPage(416));
		}

		const { start, end } = range;

		const length = end - start + 1;

		const obj = await env.BUCKET.get(key, {
			range: {
				offset: start,
				length,
			},
		});

		if (!obj) {
			return withCORS(generateErrorPage(404));
		}

		headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);

		headers.set('Content-Length', length.toString());

		status = 206;

		body = obj.body;
	} else {
		const obj = await env.BUCKET.get(key);

		if (!obj) {
			return withCORS(generateErrorPage(404));
		}

		headers.set('Content-Length', totalLength.toString());

		body = obj.body;
	}

	if (contentType.startsWith('text/') && !contentType.includes('charset')) {
		headers.set('Content-Type', `${contentType}; charset=${CHARSET_DEFAULT}`);
	}

	return withCORS(
		new Response(body, {
			status,
			headers,
		}),
	);
};

/* -------------------- Worker入口 -------------------- */

export default {
	async fetch(request, env) {
		return handleR2Request(request, env);
	},
};
