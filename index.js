const express = require("express");
const cheerio = require("cheerio");

const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_ORIGIN = "https://xhamster.com";
const REQUEST_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.REQUEST_TIMEOUT_MS) || 12000, 3000),
  25000
);

const USER_AGENT =
  process.env.UPSTREAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function noStore(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeUrl(value, base = UPSTREAM_ORIGIN) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

function classifyPage(html, contentType, finalUrl) {
  const host = safeUrl(finalUrl)?.hostname.toLowerCase() || "";
  const sample = html.slice(0, 250000).toLowerCase();

  if (!host.endsWith("xhamster.com")) return "redirected-away";
  if (!contentType.toLowerCase().includes("text/html")) return "not-html";
  if (/captcha|verify you are human|are you a robot|cf-chl-|challenge-platform/.test(sample)) {
    return "challenge";
  }
  if (/access denied|temporarily blocked|unusual traffic|request blocked|forbidden/.test(sample)) {
    return "blocked";
  }
  return "html";
}

function extractVideos($) {
  const videos = [];
  const seen = new Set();

  const selectors = [
    "div.thumb-list__item",
    "div.video-thumb",
    "[data-video-id]",
    "article",
  ];

  const cards = $(selectors.join(",")).toArray();

  for (const element of cards) {
    const card = $(element);
    const anchors = card.find("a[href]").toArray();
    let videoUrl = null;

    for (const a of anchors) {
      const parsed = safeUrl($(a).attr("href"));
      if (
        parsed &&
        parsed.hostname.toLowerCase().endsWith("xhamster.com") &&
        /\/videos?\//i.test(parsed.pathname)
      ) {
        videoUrl = parsed;
        break;
      }
    }

    if (!videoUrl || seen.has(videoUrl.href)) continue;

    const title =
      cleanText(card.find("a[title]").first().attr("title")) ||
      cleanText(card.find("[title]").first().attr("title")) ||
      cleanText(card.find(".video-thumb-info__name, .thumb-list__item-title, h3, h2").first().text()) ||
      cleanText(card.find("img").first().attr("alt"));

    if (!title) continue;

    const img = card.find("img").first();
    const rawThumb =
      img.attr("data-src") ||
      img.attr("data-original") ||
      img.attr("data-lazy-src") ||
      img.attr("src") ||
      null;
    const thumbUrl = rawThumb ? safeUrl(rawThumb) : null;

    const duration = cleanText(
      card.find(
        ".thumb-image-container__duration, .duration, [class*='duration']"
      ).first().text()
    );

    const pathParts = videoUrl.pathname.split("/").filter(Boolean);
    const id = pathParts.length ? pathParts[pathParts.length - 1] : null;

    seen.add(videoUrl.href);
    videos.push({
      title,
      url: videoUrl.href,
      thumb: thumbUrl ? thumbUrl.href : null,
      duration: duration || null,
      video_id: id,
    });
  }

  return videos;
}

app.get("/", (_req, res) => {
  noStore(res);
  res.status(200).json({
    status: "online",
    service: "xHamster Search Proxy",
    endpoints: [
      "/health",
      "/xhamster?q=indian&page=1",
      "/debug/xhamster?q=indian&page=1",
    ],
  });
});

app.get("/health", (_req, res) => {
  noStore(res);
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

async function searchHandler(req, res, debug = false) {
  noStore(res);

  const query = cleanText(req.query.q || req.query.search).slice(0, 160);
  const rawPage = String(req.query.page || "1");

  if (!query) {
    return res.status(400).json({
      error: "Missing q parameter. Example: /xhamster?q=indian",
    });
  }
  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1) {
    return res.status(400).json({ error: "page must be a positive integer" });
  }

  const page = Math.min(Number(rawPage), 100);
  const searchUrl = new URL(`/search/${encodeURIComponent(query)}`, UPSTREAM_ORIGIN);
  searchUrl.searchParams.set("page", String(page));
  const startedAt = Date.now();

  try {
    const response = await fetch(searchUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || searchUrl.href;
    const html = await response.text();
    const pageKind = classifyPage(html, contentType, finalUrl);

    const baseDiagnostics = {
      upstreamStatus: response.status,
      upstreamOk: response.ok,
      finalUrl: safeUrl(finalUrl)?.origin + (safeUrl(finalUrl)?.pathname || ""),
      contentType,
      pageKind,
      responseBytes: Buffer.byteLength(html),
      durationMs: Date.now() - startedAt,
    };

    if (!response.ok || pageKind !== "html") {
      console.warn("upstream_unavailable", JSON.stringify(baseDiagnostics));
      return res.status(502).json({
        source: "xhamster",
        error: !response.ok
          ? `Upstream returned HTTP ${response.status}`
          : `Upstream returned an unsupported page (${pageKind})`,
        ...(debug ? { diagnostics: baseDiagnostics } : {}),
      });
    }

    const $ = cheerio.load(html);
    const videos = extractVideos($);
    const pageTitle = cleanText($("title").first().text()).slice(0, 180);

    const diagnostics = {
      ...baseDiagnostics,
      pageTitle,
      parsedVideoCount: videos.length,
      matchingAnchors: $("a[href*='/video'], a[href*='/videos/']").length,
    };

    console.info("search_complete", JSON.stringify({
      queryLength: query.length,
      page,
      ...diagnostics,
    }));

    return res.status(200).json({
      source: "xhamster",
      query,
      page,
      count: videos.length,
      videos,
      ...(debug ? { diagnostics } : {}),
      ...(videos.length === 0
        ? { note: "No video cards matched the current HTML selectors; upstream markup may have changed." }
        : {}),
    });
  } catch (error) {
    const timedOut =
      error?.name === "TimeoutError" ||
      error?.name === "AbortError";

    const diagnostics = {
      failureType: timedOut ? "timeout" : "fetch-error",
      message: cleanText(error?.message || error).slice(0, 250),
      durationMs: Date.now() - startedAt,
    };

    console.error("search_failed", JSON.stringify(diagnostics));

    return res.status(502).json({
      source: "xhamster",
      error: timedOut
        ? "Upstream request timed out"
        : "Could not retrieve upstream search results",
      ...(debug ? { diagnostics } : {}),
    });
  }
}

app.get("/xhamster", (req, res) =>
  searchHandler(req, res, req.query.debug === "1")
);
app.get("/api/xhamster-search", (req, res) =>
  searchHandler(req, res, req.query.debug === "1")
);
app.get("/debug/xhamster", (req, res) => searchHandler(req, res, true));

app.use((_req, res) => {
  noStore(res);
  res.status(404).json({ error: "Endpoint not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
