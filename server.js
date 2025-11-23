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

/**
 * Extract any PUBLIC video URLs that Alibaba loads:
 * - clicks the "Video" tab if it exists
 * - scrolls to trigger lazy loading
 * - tries to play <video> tags
 * - listens to network responses for .mp4 / .m3u8
 */
app.get("/extract", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl || !pageUrl.startsWith("http")) {
    return res.status(400).json({ error: "Missing or bad URL" });
  }

  const browser = await chromium.launch({
    headless: false, // Alibaba blocks headless often
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    bypassCSP: true
  });

  const page = await context.newPage();

  // simple stealth: remove webdriver flag
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const videos = new Set();

  page.on("response", (resp) => {
    const url = resp.url();
    if (url.includes(".mp4")) videos.add(url);
    if (url.includes(".m3u8")) videos.add(url);
  });

  try {
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // let the UI settle
    await page.waitForTimeout(2500);

    // IMPORTANT: click the Video tab if the listing uses tabs
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("button, a, div, span"));
      const videoTab = els.find(el =>
        el.textContent &&
        el.textContent.trim().toLowerCase() === "video"
      );
      if (videoTab) videoTab.click();
    });

    // wait for video player to mount + requests to fire
    await page.waitForTimeout(4000);

    // scroll a bit to trigger lazy loads
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(2500);

    // try to autoplay any HTML5 videos
    await page.evaluate(() => {
      document.querySelectorAll("video").forEach(v => {
        try {
          v.muted = true;
          v.play();
        } catch (e) {}
      });
    });

    // wait for network captures
    await page.waitForTimeout(5000);

    const list = [...videos];
    await browser.close();

    return res.json({ pageUrl, videos: list });
  } catch (err) {
    await browser.close();
    return res.status(500).json({
      error: "Failed to load/extract",
      detail: String(err),
    });
  }
});

/**
 * Download proxy to avoid CORS issues.
 * Frontend hits /download?url=MP4_URL
 */
app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) {
    return res.status(400).send("Missing or bad URL");
  }

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send("Upstream failed");

    const filename =
      (new URL(url).pathname.split("/").pop() || "video.mp4").split("?")[0];

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.setHeader(
      "Content-Type",
      r.headers.get("content-type") || "video/mp4"
    );

    r.body.pipe(res);
  } catch (err) {
    res.status(500).send("Download proxy error");
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
