const ALLOWED_UPSTREAM_PREFIX =
	"https://github.com/fossi-foundation/ciel-releases/releases/download/";

const CORS_RESPONSE_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, HEAD, OPTIONS",
	"access-control-allow-headers": "*",
	"access-control-expose-headers": "*",
	"access-control-max-age": "86400",
};

export default {
	async fetch(request) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_RESPONSE_HEADERS });
		}
		const requestedUpstreamUrl = new URL(request.url).searchParams.get("url");
		if (!requestedUpstreamUrl || !requestedUpstreamUrl.startsWith(ALLOWED_UPSTREAM_PREFIX)) {
			return new Response(
				"only ciel-releases asset URLs are proxied",
				{ status: 400, headers: CORS_RESPONSE_HEADERS },
			);
		}
		const upstreamResponse = await fetch(requestedUpstreamUrl, { redirect: "follow" });
		const responseHeaders = new Headers(upstreamResponse.headers);
		for (const [headerName, headerValue] of Object.entries(CORS_RESPONSE_HEADERS)) {
			responseHeaders.set(headerName, headerValue);
		}
		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			headers: responseHeaders,
		});
	},
};
