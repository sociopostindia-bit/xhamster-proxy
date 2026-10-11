
const express = require("express");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

// ========== Health Check ==========
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "xHamster Search API",
    endpoints: [
      "/health",
      "/xhamster?q=indian&page=1"
    ]
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

// ========== xHamster Search ==========
app.get("/xhamster", async (req, res) => {
  const query = String(req.query.q || req.query.search || "").trim();
  const rawPage = String(req.query.page || "1");

  if (!query) {
    return res.status(400).json({
      error: "Missing q parameter. Example: /xhamster?q=indian"
    });
  }

  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1) {
    return res.status(400).json({
      error: "Page must be a positive integer"
    });
  }

  const page = Math.min(Number(rawPage), 100);

  try {
    const searchUrl =
      `https://xhamster.com/search/${encodeURIComponent(query)}?page=${page}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://xhamster.com/"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return res.status(502).json({
        source: "xhamster",
        error: `Upstream returned HTTP ${response.status}`
      });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const videos = [];
    const seen = new Set();

    $("div.thumb-list__item, div.video-thumb").each((i, el) => {
      const card = $(el);

      const anchor = card
        .find(
          "a.video-thumb__image-container, a.thumb-image-container"
        )
        .first();

      const link =
        anchor.attr("href") ||
        card.find("a[href*='/videos/']").first().attr("href");

      const title =
        anchor.attr("title") ||
        card.find("a[title]").first().attr("title") ||
        card.find(".video-thumb-info__name").first().text().trim();

      const img = card.find("img").first();

      const thumb =
        img.attr("data-src") ||
        img.attr("data-original") ||
        img.attr("data-lazy-src") ||
        img.attr("src") ||
        null;

      const duration = card
        .find(".thumb-image-container__duration, .duration")
        .first()
        .text()
        .trim();

      if (!link || !title) return;

      let url;

      try {
        const parsed = new URL(link, "https://xhamster.com");

        if (
          parsed.hostname !== "xhamster.com" &&
          parsed.hostname !== "www.xhamster.com"
        ) {
          return;
        }

        if (!parsed.pathname.startsWith("/videos/")) return;

        url = parsed.href;
      } catch {
        return;
      }

      if (seen.has(url)) return;
      seen.add(url);

      const slugMatch = new URL(url).pathname.match(/\/videos\/([^/]+)/);
      const id = slugMatch ? slugMatch[1] : null;

      videos.push({
        title: title.trim(),
        url,
        thumb,
        duration: duration || null,
        video_id: id,
        embed: id
          ? `https://xhamster.com/embed/${id}`
          : null
      });
    });

    return res.json({
      source: "xhamster",
      query,
      page,
      count: videos.length,
      videos
    });
  } catch (err) {
    console.error("xHamster search failed:", err.message);

    return res.status(502).json({
      source: "xhamster",
      error: "Failed to retrieve search results",
      details:
        err.name === "TimeoutError"
          ? "The upstream request timed out"
          : err.message
    });
  }
});

// ========== 404 Handler ==========
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.path
  });
});

// ========== Railway Server ==========
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
