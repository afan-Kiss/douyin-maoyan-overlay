import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME_PATH = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
};

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function bootPage(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(() => {
    window.overlay = {
      getConfig: async () => ({ apiBase: "", pollIntervalMs: 60000, topCount: 10 }),
      getOverlaySettings: async () => null,
      onSettingsChanged: () => () => {},
      getApiStatus: async () => ({ ready: false }),
      ensureApi: async () => ({ ready: false }),
      isLoggedIn: async () => true,
      startLogin: async () => {},
      onApiReady: () => () => {},
    };
  });
  await page.goto(`${baseUrl}/index.html`);
  await page.evaluate(async () => {
    const { initTrailerPlayer } = await import("./trailer-player.js");
    initTrailerPlayer();
    const v = document.getElementById("trailer-video");
    v.play = () => Promise.resolve();
  });
  return page;
}

async function syncWithCatalog(page, movies, catalog) {
  await page.evaluate(
    async ({ list, cat }) => {
      const { syncTrailerWithRanking } = await import("./trailer-player.js");
      syncTrailerWithRanking(list, cat);
    },
    { list: movies, cat: catalog },
  );
  await page.waitForTimeout(400);
}

async function main() {
  const { server, baseUrl } = await startStaticServer(__dirname);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
  });

  const catalogAB = [
    { name: "坏片A", trailer: "http://invalid.example/a.mp4" },
    { name: "好片B", trailer: "trailers/_sample.mp4" },
  ];

  try {
    const page = await bootPage(browser, baseUrl);

    await syncWithCatalog(
      page,
      [{ rank: 1, name: "坏片A" }, { rank: 2, name: "好片B" }],
      catalogAB,
    );
    await page.waitForFunction(() =>
      document.getElementById("trailer-now")?.textContent?.includes("坏片A"),
    );
    await page.evaluate(() => {
      document.getElementById("trailer-video").dispatchEvent(new Event("error"));
    });
    await page.waitForFunction(() =>
      document.getElementById("trailer-now")?.textContent?.includes("好片B"),
    );
    const case1 = await page.locator("#trailer-now").textContent();
    if (!case1.includes("好片B")) throw new Error(`Case1 failed: ${case1}`);
    console.log("OK: Case1 A error -> B");

    await syncWithCatalog(page, [{ rank: 1, name: "坏片A" }], catalogAB);
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(() => {
        document.getElementById("trailer-video").dispatchEvent(new Event("error"));
      });
      await page.waitForTimeout(300);
    }
    const case2 = await page.locator("#trailer-empty-title").textContent();
    if (!case2.includes("不可用")) throw new Error(`Case2 failed: ${case2}`);
    console.log("OK: Case2 all errors stop");

    await page.evaluate(() => {
      const v = document.getElementById("trailer-video");
      window.__playCalls = 0;
      v.play = () => {
        window.__playCalls += 1;
        return Promise.reject(new Error("blocked"));
      };
    });
    await syncWithCatalog(
      page,
      [{ rank: 1, name: "坏片A" }, { rank: 2, name: "好片B" }],
      catalogAB,
    );
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => {
        document.getElementById("trailer-video").dispatchEvent(new Event("canplay"));
      });
      await page.waitForTimeout(200);
    }
    const playCalls = await page.evaluate(() => window.__playCalls || 0);
    const case3 = await page.locator("#trailer-empty-title").textContent();
    if (playCalls > 20) throw new Error(`Case3 too many play calls: ${playCalls}`);
    if (!case3.includes("不可用")) throw new Error(`Case3 failed: ${case3}`);
    console.log("OK: Case3 play reject no infinite loop");

    await page.evaluate(async () => {
      const { destroyTrailerPlayer, initTrailerPlayer } = await import("./trailer-player.js");
      destroyTrailerPlayer();
      initTrailerPlayer();
      const v = document.getElementById("trailer-video");
      v.play = () => Promise.resolve();
    });
    await page.evaluate(
      async ({ list, cat }) => {
        const { syncTrailerWithRanking } = await import("./trailer-player.js");
        syncTrailerWithRanking(list.a, cat);
        syncTrailerWithRanking(list.b, cat);
      },
      {
        list: {
          a: [{ rank: 1, name: "坏片A" }],
          b: [{ rank: 1, name: "好片B" }],
        },
        cat: catalogAB,
      },
    );
    await page.waitForFunction(() => {
      const v = document.getElementById("trailer-video");
      return (
        document.getElementById("trailer-now")?.textContent?.includes("好片B") &&
        v.src.includes("_sample")
      );
    });
    await page.waitForTimeout(2000);
    const case4 = await page.locator("#trailer-now").textContent();
    if (!case4.includes("好片B")) throw new Error(`Case4 failed: ${case4}`);
    console.log("OK: Case4 rapid chart switch keeps new trailer");

    await syncWithCatalog(page, [{ rank: 1, name: "无预告片" }], []);
    const case5 = await page.evaluate(() => {
      const v = document.getElementById("trailer-video");
      return {
        src: v.getAttribute("src"),
        paused: v.paused,
        emptyHidden: document.getElementById("trailer-empty").hidden,
      };
    });
    if (case5.src || case5.emptyHidden) {
      throw new Error(`Case5 failed: ${JSON.stringify(case5)}`);
    }
    console.log("OK: Case5 empty chart clears src and pauses");

    const catalogRefresh = [
      { name: "稳定片A", trailer: "trailers/_sample.mp4" },
      { name: "稳定片B", trailer: "trailers/_sample.mp4" },
    ];
    await page.evaluate(async () => {
      const { destroyTrailerPlayer, initTrailerPlayer } = await import("./trailer-player.js");
      destroyTrailerPlayer();
      initTrailerPlayer();
      const v = document.getElementById("trailer-video");
      v.play = () => Promise.resolve();
    });
    const moviesAFirst = [{ rank: 1, name: "稳定片A" }, { rank: 2, name: "稳定片B" }];
    await syncWithCatalog(page, moviesAFirst, catalogRefresh);
    await page.waitForFunction(() =>
      document.getElementById("trailer-now")?.textContent?.includes("稳定片A"),
    );
    await page.evaluate(() => {
      document.getElementById("trailer-video").dispatchEvent(new Event("playing"));
    });
    const baseState = await page.evaluate(async () => {
      const { __getTrailerDebugState } = await import("./trailer-player.js");
      return __getTrailerDebugState();
    });
    for (let i = 0; i < 10; i += 1) {
      const shuffled =
        i % 2 === 0
          ? [{ rank: 1, name: "稳定片A" }, { rank: 2, name: "稳定片B" }]
          : [{ rank: 1, name: "稳定片A" }, { rank: 3, name: "稳定片B" }];
      await syncWithCatalog(page, shuffled, catalogRefresh);
      const st = await page.evaluate(async () => {
        const { __getTrailerDebugState } = await import("./trailer-player.js");
        return __getTrailerDebugState();
      });
      if (st.generation !== baseState.generation) {
        throw new Error(`Case6 generation changed on refresh: ${JSON.stringify(st)}`);
      }
      if (st.listenerCount !== baseState.listenerCount) {
        throw new Error(`Case6 listener count drift: ${st.listenerCount} vs ${baseState.listenerCount}`);
      }
    }
    await page.evaluate(() => {
      document.getElementById("trailer-video").dispatchEvent(new Event("ended"));
    });
    await page.waitForFunction(() =>
      document.getElementById("trailer-now")?.textContent?.includes("稳定片B"),
    );
    console.log("OK: Case6 chart refresh keeps listeners and ended advances");

    console.log("\nALL PASSED (trailer edge)");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
