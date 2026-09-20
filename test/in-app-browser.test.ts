import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error - public/ ships without types; it is plain browser JavaScript.
import { inAppBrowser, openOutsideSteps } from "../public/in-app-browser.js";

function browser(userAgent: string, platform = "iPhone", maxTouchPoints = 5) {
  vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });
}

const WECHAT_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN";
const WECHAT_ANDROID = "Mozilla/5.0 (Linux; Android 13; PGT-AN20 Build/HUAWEIPGT-AN20; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 MQQBrowser/6.2 TBS/046205 Mobile Safari/537.36 MMWEBID/2857 MicroMessenger/8.0.40.2420(0x28002837) WeChat/arm64 Weixin NetType/WIFI";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

describe("browsers that cannot do passkeys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("knows the app browsers people share links into", () => {
    browser(WECHAT_IOS);
    expect(inAppBrowser()).toBe("WeChat");
    browser(WECHAT_ANDROID, "Linux armv8l", 0);
    expect(inAppBrowser()).toBe("WeChat");
    browser("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 QQ/8.9.68.614 Mobile/15E148");
    expect(inAppBrowser()).toBe("QQ");
    browser("Mozilla/5.0 (iPhone) Weibo (iPhone14,3__weibo__14.5.0__iphone__os17.5)");
    expect(inAppBrowser()).toBe("Weibo");
    browser("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 AlipayClient/10.5.36");
    expect(inAppBrowser()).toBe("Alipay");
  });

  it("leaves a real browser alone", () => {
    browser(SAFARI_IOS);
    expect(inAppBrowser()).toBe("");
    browser(CHROME_ANDROID, "Linux armv8l", 0);
    expect(inAppBrowser()).toBe("");
    browser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36", "MacIntel", 0);
    expect(inAppBrowser()).toBe("");
  });

  it("sends an iPhone to Safari and everyone else to the browser", () => {
    browser(WECHAT_IOS);
    expect(openOutsideSteps()[1]).toContain("Safari");
    browser(WECHAT_ANDROID, "Linux armv8l", 0);
    expect(openOutsideSteps()[1]).toContain("browser");
  });
});
