const express = require("express");
const app = express();
const cheerio = require("cheerio");

app.get("/api/xhamster-search", async (req, res) => {
  const query = req.query.q || req.query.search;
  const page = req.query.page || "1";

  if (!query) {
    return res.status(400).json({ error: "Missing q parameter" });
  }

  try {
    const searchUrl = `https://xhamster.com/search/${encodeURIComponent(query)}?page=${page}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://xhamster.com/",
        "Origin": "https://xhamster.com",
        "Sec-Ch-Ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0",
        // Age / consent related cookies (Pornhub style)
        "Cookie": "cookie_accept=1; age_confirmed=1; platform_type=desktop; lang=en;"
      },
      redirect: "follow"
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    // Debug logs (Railway pe dikhenge)
    console.log("xhamster_search", {
      upstreamStatus: response.status,
      finalUrl: response.url,
      htmlLength: html.length,
      pageTitle: $("title").text().trim(),
      containsThumb: html.includes("thumb"),
      pageKind: html.includes("challenge") || html.includes("Just a moment") ? "challenge" : "normal"
    });

    const videos = [];

    // Updated selectors (thoda zyada coverage)
    $("div.thumb-list__item, div.video-thumb, div.thumb-list__item--video, a.video-thumb__image-container").each((i, el) => {
      const $el = $(el);
      const title = $el.find("a").attr("title") || 
                    $el.find(".video-thumb-info__name, .thumb-image-container__name").text().trim() ||
                    $el.attr("title");
      
      const link = $el.find("a").attr("href") || $el.attr("href");
      const thumb = $el.find("img").attr("src") || $el.find("img").attr("data-src") || $el.find("img").attr("data-original");
      const duration = $el.find(".thumb-image-container__duration, .duration, .video-thumb__duration").text().trim();

      if (link && title) {
        const fullUrl = link.startsWith("http") ? link : `https://xhamster.com${link}`;
        const slugMatch = fullUrl.match(/\/videos\/([^\/\?]+)/);
        const id = slugMatch ? slugMatch[1] : null;

        videos.push({
          title: title.trim(),
          url: fullUrl,
          thumb: thumb || null,
          duration: duration || null,
          video_id: id,
          embed: id ? `https://xhamster.com/embed/${id}` : null
        });
      }
    });

    res.json({
      source: "xhamster",
      query,
      page,
      count: videos.length,
      videos
    });

  } catch (err) {
    console.error("xhamster error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
