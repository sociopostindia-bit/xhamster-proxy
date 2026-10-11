const crypto = require("node:crypto");
const express = require("express");
const cheerio = require("cheerio");

const app = express();
app.disable("etag");
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_ORIGIN = "https://xhamster.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function getSafeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function detectPageKind(html, contentType, finalUrl) {
  const text = html.slice(0, 250_000).toLowerCase();
  const host = (() => {
    try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return "invalid"; }
  })();
  if (!host.endsWith("xhamster.com")) return "redirected-away";
  if (!contentType.toLowerCase().includes("text/html")) return "not-html";
  if (/airtel|dot\.gov|internet service provider|parental control/.test(text)) return "isp-interstitial";
  if (/captcha|verify you are human|are you a robot|cf-chl-|cloudflare/.test(text)) return "challenge";
  if (/access denied|temporarily blocked|unusual traffic|request blocked/.test(text)) return "blocked";
  return "xhamster-html";
}

function parseVideos($) {
  const videos = [];
  const seen = new Set();

  $("div.thumb-list__item, div.video-thumb").each((_, el) => {
    const card = $(el);
    const anchor = card
      .find("a.video-thumb__image-container, a.thumb-image-container")
      .first();
    const link = anchor.attr("href") || card.find("a[href*='/videos/']").first().attr("href");
    const title = anchor.attr("title") || card.find("a[title]").first().attr("title") ||
      card.find(".video-thumb-info__name").first().text().trim();
    const img = card.find("img").first();
    const thumb = img.attr("data-src") || img.attr("data-original") ||
      img.attr("data-lazy-src") || img.attr("src") || null;
    const duration = card.find(".thumb-image-container__duration, .duration").first().text().trim();

    if (!link || !title) return;
    let parsed;
    try { parsed = new URL(link, UPSTREAM_ORIGIN); } catch { return; }
    if (!["xhamster.com", "www.xhamster.com"].includes(parsed.hostname)) return;
    if (!parsed.pathname.startsWith("/videos/")) return;
    if (seen.has(parsed.href)) return;
    seen.add(parsed.href);

    const match = parsed.pathname.match(/\/videos\/([^/]+)/);
    const id = match ? match[1] : null;
    videos.push({
      title: title.trim(),
      url: parsed.href,
      thumb,
      duration: duration || null,
      video_id: id,
      embed: id ? `https://xhamster.com/embed/${id}` : null,
    });
  });

  return videos;
}

app.get("/", (_req, res) => {
  noStore(res);
  res.json({ status: "online", service: "xHamster Search API", endpoints: ["/health", "/xhamster?q=indian&page=1", "/debug/xhamster?q=indian&page=1"] });
});

app.get("/health", (_req, res) => {
  noStore(res);
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

async function handleSearch(req, res, includeDiagnostics) {
  noStore(res);
  const requestId = crypto.randomUUID();
  const query = String(req.query.q || req.query.search || "").trim().slice(0, 160);
  const rawPage = String(req.query.page || "1");

  if (!query) return res.status(400).json({ error: "Missing q parameter. Example: /xhamster?q=indian", requestId });
  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1) {
    return res.status(400).json({ error: "Page must be a positive integer", requestId });
  }

  const page = Math.min(Number(rawPage), 100);
  const searchUrl = `${UPSTREAM_ORIGIN}/search/${encodeURIComponent(query)}?page=${page}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: `${UPSTREAM_ORIGIN}/`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || searchUrl;
    const html = await response.text();
    const $ = cheerio.load(html);
    const htmlTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ").trim().slice(0, 180) || null;
    const htmlPreview = html.slice(0, 500).replace(/\s+/g, " ").trim();
    const thumbListItemCount = $("div.thumb-list__item").length;
    const videoThumbCount = $("div.video-thumb").length;
    const cardSelectorCount = thumbListItemCount + videoThumbCount;
    const videoAnchorCount = $("a[href*='/videos/']").length;
    const title = $("title").first().text().trim().slice(0, 180) || htmlTitle || "";
    const pageKind = detectPageKind(html, contentType, finalUrl);
    const videos = pageKind === "xhamster-html" ? parseVideos($) : [];

    const diagnostics = {
      requestId,
      upstreamStatus: response.status,
      upstreamOk: response.ok,
      redirected: response.redirected,
      finalUrl: getSafeUrl(finalUrl),
      contentType,
      responseBytes: Buffer.byteLength(html),
      pageTitle: title || null,
      containsThumb: html.toLowerCase().includes("thumb"),
      htmlPreview: includeDiagnostics ? htmlPreview : undefined,
      pageKind,
      thumbListItemCount,
      videoThumbCount,
      cardSelectorCount,
      videoAnchorCount,
      parsedVideoCount: videos.length,
      durationMs: Date.now() - startedAt,
    };

    console.info("xhamster_search", JSON.stringify({
      ...diagnostics,
      queryLength: query.length,
      page,
    }));
    console.info("xhamster_upstream_inspection", JSON.stringify({
      requestId,
      status: response.status,
      htmlLength: html.length,
      title: htmlTitle,
      containsThumb: html.toLowerCase().includes("thumb"),
      first500Characters: htmlPreview,
    }));

    if (!response.ok || pageKind !== "xhamster-html") {
      return res.status(502).json({
        source: "xhamster",
        error: !response.ok ? `Upstream returned HTTP ${response.status}` : `Unexpected upstream page: ${pageKind}`,
        requestId,
        ...(includeDiagnostics ? { diagnostics } : {}),
      });
    }

    return res.json({
      source: "xhamster",
      query,
      page,
      count: videos.length,
      videos,
      requestId,
      ...(includeDiagnostics ? { diagnostics } : {}),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    const diagnostics = {
      requestId,
      failureType: timedOut ? "timeout" : "fetch-error",
      durationMs: Date.now() - startedAt,
      message: String(err.message || err).slice(0, 300),
    };
    console.error("xhamster_search_failed", JSON.stringify({ ...diagnostics, queryLength: query.length, page }));
    return res.status(502).json({
      source: "xhamster",
      error: timedOut ? "Upstream request timed out" : "Failed to retrieve upstream search results",
      requestId,
      ...(includeDiagnostics ? { diagnostics } : {}),
    });
  }
}

app.get("/xhamster", (req, res) => handleSearch(req, res, req.query.debug === "1"));
app.get("/debug/xhamster", (req, res) => handleSearch(req, res, true));

app.use((req, res) => {
  noStore(res);
  res.status(404).json({ error: "Endpoint not found", path: req.path });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
