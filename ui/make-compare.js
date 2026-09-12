import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ref = path.resolve(
  "C:/Users/Administrator/.cursor/projects/e-24/assets/c__Users_Administrator_AppData_Roaming_Cursor_User_workspaceStorage_fab3776d212289a140acfe750dacb905_images_1038-a8fe87c1-d05d-4440-a032-8ed35119cfe4.png"
);
const shot = path.join(root, "ui/preview-race-1080x1920.png");
const out = path.join(root, "ui/compare-ref-vs-app-1080x1920.png");

const CHROME_CANDIDATES = [
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  const browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage({ viewport: { width: 2160, height: 1920 } });
  const refUrl = pathToFileURL(ref).href;
  const shotUrl = pathToFileURL(shot).href;
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#111;display:flex">
    <div style="width:1080px;height:1920px;position:relative">
      <img src="${refUrl}" style="width:1080px;height:1920px;object-fit:cover"/>
      <div style="position:absolute;top:12px;left:12px;background:rgba(0,0,0,.7);color:#fff;padding:6px 12px;font:700 22px sans-serif">参考图</div>
    </div>
    <div style="width:1080px;height:1920px;position:relative">
      <img src="${shotUrl}" style="width:1080px;height:1920px;object-fit:cover"/>
      <div style="position:absolute;top:12px;left:12px;background:rgba(0,0,0,.7);color:#fff;padding:6px 12px;font:700 22px sans-serif">程序截图 1080×1920</div>
    </div>
  </body></html>`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: out });
  await browser.close();
  console.log("saved", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
