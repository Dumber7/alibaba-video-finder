import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

app.get("/extract", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl || !pageUrl.startsWith("http")) {
    return res.status(400).json({ error: "Bad url" });
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
  });

  const videos = new Map();

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (url.includes(".mp4")) videos.set(url, { url, type: "mp4" });
      if (url.includes(".m3u8")) videos.set(url, { url, type: "m3u8" });
    } catch {}
  });

  try {
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 45000 });

    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(2000);

    const playButtons = await page.$$(
      'button:has-text("Play"), .video-play, .play-btn, [aria-label*="play"]'
    );
    for (const btn of playButtons.slice(0, 4)) {
      try { await btn.click({ timeout: 1500 }); } catch {}
    }

    await page.waitForTimeout(4000);

    const list = [...videos.values()];
    await browser.close();

    return res.json({ pageUrl, videos: list });
  } catch (err) {
    await browser.close();
    return res.status(500).json({ error: "Failed to load page", detail: String(err) });
  }
});

app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) {
    return res.status(400).send("Bad url");
  }

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send("Upstream failed");

    const contentType = r.headers.get("content-type") || "video/mp4";
    const filename =
      (new URL(url).pathname.split("/").pop() || "video.mp4").split("?")[0];

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    r.body.pipe(res);
  } catch {
    res.status(500).send("Proxy error");
  }
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));
