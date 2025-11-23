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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

function unique(arr) {
  return [...new Set(arr)];
}

function extractVideosFromText(text) {
  const mp4s = text.match(/https?:\/\/[^"'\\s<>]+\.mp4[^"'\\s<>]*/gi) || [];
  const m3u8s = text.match(/https?:\/\/[^"'\\s<>]+\.m3u8[^"'\\s<>]*/gi) || [];
  return unique([...mp4s, ...m3u8s]);
}

/**
 * Stage 1 - plain HTML fetch (no Playwright).
 * Often enough to find public MP4s embedded in JSON blobs.
 */
async function stage1FetchHtml(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "user-agent": UA,
      "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-GB,en;q=0.9",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "referer": "https://www.alibaba.com/",
    },
  });

  const html = await res.text();
  const vids = extractVideosFromText(html);
  return vids;
}

/**
 * Stage 2 - Playwright fallback for pages that hide video until JS runs.
 * Runs headless (Codespaces friendly), with anti-bot args.
 */
async function stage2Playwright(pageUrl) {
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
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
  });

  const page = await context.newPage();

  // hide webdriver flag a bit
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const seen = new Set();
  page.on("response", (resp) => {
    const url = resp.url();
    if (url.includes(".mp4") || url.includes(".m3u8")) seen.add(url);
  });

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    // click "Video" tab if it exists
    await page.evaluate(() => {
      const lower = (s) => (s || "").trim().toLowerCase();
      const els = [
        ...document.querySelectorAll('[role="tab"], button, a, div, span'),
      ];
      const tab = els.find((el) => lower(el.textContent) === "video");
      if (tab) tab.click();
    });

    await page.waitForTimeout(3000);

    // scroll to trigger lazy-loading
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(2000);
    }

    // try to play any video tags
    await page.evaluate(() => {
      document.querySelectorAll("video").forEach((v) => {
        try {
          v.muted = true;
          v.play();
        } catch {}
      });
    });

    await page.waitForTimeout(5000);

    // also scrape HTML after JS
    const html = await page.content();
    const htmlVids = extractVideosFromText(html);

    await browser.close();
    return unique([...seen, ...htmlVids]);
  } catch (e) {
    await browser.close();
    return [];
  }
}

app.get("/extract", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl || !pageUrl.startsWith("http")) {
    return res.status(400).json({ error: "Missing/bad url" });
  }

  try {
    // Stage 1
    const htmlVids = await stage1FetchHtml(pageUrl);
    if (htmlVids.length) {
      return res.json({
        pageUrl,
        videos: htmlVids,
        method: "html",
      });
    }

    // Stage 2
    const pwVids = await stage2Playwright(pageUrl);
    if (pwVids.length) {
      return res.json({
        pageUrl,
        videos: pwVids,
        method: "playwright",
      });
    }

    // Nothing found
    return res.json({
      pageUrl,
      videos: [],
      method: "none",
      note:
        "No public MP4/M3U8 found. Listing likely uses protected/encrypted streams.",
    });
  } catch (err) {
    return res.status(500).json({
      error: "extract failed",
      detail: String(err),
    });
  }
});

// Download proxy to avoid CORS issues
app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) {
    return res.status(400).send("Missing/bad url");
  }

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send("Upstream failed");

    const filename =
      (new URL(url).pathname.split("/").pop() || "video.mp4").split("?")[0];

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    r.body.pipe(res);
  } catch {
    res.status(500).send("download proxy error");
  }
});

// Shut up favicon spam
app.get("/favicon.ico", (req, res) => res.status(204).end());

app.listen(3000, () => console.log("Server running on port 3000"));
