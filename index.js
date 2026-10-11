const cheerio = require("cheerio");

// ========== xHamster Search ==========
app.get("/xhamster", async (req, res) => {
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
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://xhamster.com/",
      },
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    const videos = [];

    // xHamster video cards
    $("div.thumb-list__item, div.video-thumb").each((i, el) => {
      const title = $(el).find("a.video-thumb__image-container, a.thumb-image-container").attr("title") || 
                    $(el).find("a").attr("title") || 
                    $(el).find(".video-thumb-info__name").text().trim();

      const link = $(el).find("a").attr("href");
      const thumb = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
      const duration = $(el).find(".thumb-image-container__duration, .duration").text().trim();

      if (link && title) {
        // Extract video ID / slug
        const slugMatch = link.match(/\/videos\/([^\/\?]+)/);
        const id = slugMatch ? slugMatch[1] : null;

        videos.push({
          title: title.trim(),
          url: link.startsWith("http") ? link : `https://xhamster.com${link}`,
          thumb: thumb,
          duration: duration,
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
    res.status(500).json({ error: err.message });
  }
});
