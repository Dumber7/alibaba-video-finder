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

function unique(arr) {
  return [...new Set(arr)];
}

function extractFromHtml(html) {
  const mp4s = html.match(/https?:\/\/[^"'\\s<>]+\.mp4[^"'\\s<>]*/gi) || [];
  const m3u8s = html.match(/https?:\/\/[^"'\\s<>]+\.m3u8[^"'\\s<>]*/gi) || [];
  return unique([...mp4s, ...m3u8s]);
}

app.get("/extract", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl || !pageUrl.startsWith("http")) {
    return res.status(400).json({ error: "Missing or bad URL" });
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
  });

  const page = await context.newPage();

  // Stealth-ish: remove webdriver flag
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // Capture any mp4/m3u8 that DO get requested
  const videos = new Set();
  page.on("response", (resp) => {
    const url = resp.url();
    if (url.includes(".mp4") || url.includes(".m3u8")) videos.add(url);
  });

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    // 1) Click "Video" tab if tabs exist (several possible Alibaba layouts)
    await page.evaluate(() => {
      const lower = (s) => (s || "").trim().toLowerCase();

      const candidates = [
        ...document.querySelectorAll(
          '[role="tab"], button, a, div, span'
        ),
      ];

      const tab = candidates.find((el) => lower(el.textContent) === "video");
      if (tab) tab.click();
    });

    await page.waitForTimeout(3000);

    // 2) Scroll + try to trigger lazy gallery loads multiple times
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(2000);
    }

    // 3) Try clicking any visible play buttons / poster frames
    await page.evaluate(() => {
      const clickIf = (el) => {
        try { el.click(); } catch {}
      };

      const playButtons = [
        ...document.querySelectorAll(
          'button, div, span, i, svg'
        ),
      ].filter((el) => {
        const t = (el.textContent || "").toLowerCase();
        const cls = (el.className || "").toLowerCase();
        return (
          t.includes("play") ||
          cls.includes("play") ||
          cls.includes("video")
        );
      });

      playButtons.slice(0, 6).forEach(clickIf);

      // also try any <video> tags
      document.querySelectorAll("video").forEach((v) => {
        try {
          v.muted = true;
          v.play();
        } catch {}
      });
    });

    await page.waitForTimeout(5000);

    // 4) Fallback: scan HTML for direct mp4/m3u8 links
    const html = await page.content();
    const htmlVideos = extractFromHtml(html);

    const all = unique([...videos, ...htmlVideos]);

    await browser.close();
    return res.json({ pageUrl, videos: all });
  } catch (err) {
    await browser.close();
    return res.status(500).json({
      error: "Failed to extract",
      detail: String(err),
    });
  }
});

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
  } catch {
    res.status(500).send("Download proxy error");
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
