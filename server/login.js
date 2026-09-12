import readline from "readline";
import { chromium } from "playwright";
import { BOX_PAGE, STORAGE_STATE, USER_AGENT, ensureConfigTemplate, getChromeExecutable } from "./lib/config.js";
import { log } from "./lib/logger.js";

ensureConfigTemplate();

const chromePath = getChromeExecutable();
if (!chromePath) {
  log.chromeMissing();
  process.exit(1);
}

log.info("正在打开浏览器，请完成登录...");

let browser;
try {
  browser = await chromium.launch({
    headless: false,
    executablePath: chromePath,
  });
  const context = await browser.newContext({ locale: "zh-CN", userAgent: USER_AGENT });
  const page = await context.newPage();
  await page.goto(BOX_PAGE("1462628"), { waitUntil: "load", timeout: 120000 });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question("\n登录完成后按回车保存（保存后可关闭此窗口）：", () => {
      rl.close();
      resolve();
    });
  });

  await context.storageState({ path: STORAGE_STATE });
  await context.close();
  log.info("登录信息已保存，可以正常使用了");
} catch {
  log.info("登录过程出错，请重试");
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
}
