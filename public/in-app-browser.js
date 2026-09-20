// A link opened inside WeChat, QQ or another app runs in that app's own webview, and Meeting Note
// needs two things those webviews refuse: the passkey prompt (WebAuthn is present but never
// resolves) and "Add to Home Screen". The page says so instead of letting someone build an app
// they cannot sign into. The installer keeps its own copy of this list (installer/public/app.js).
const IN_APP_BROWSERS = [
  ["WeChat", /MicroMessenger/i],
  ["QQ", /\bQQ\/[\d.]+/i],
  ["Weibo", /Weibo/i],
  ["DingTalk", /DingTalk/i],
  ["Feishu", /Lark|Feishu/i],
  ["Alipay", /AlipayClient/i],
  ["Douyin", /aweme|BytedanceWebview/i],
  ["Xiaohongshu", /xhsdiscover|XHS\//i],
  ["Facebook", /FBAN|FBAV/i],
  ["Instagram", /Instagram/i],
  ["LINE", /\bLine\/\d/i]
];

export function inAppBrowser() {
  const found = IN_APP_BROWSERS.find(([, pattern]) => pattern.test(navigator.userAgent || ""));
  return found ? found[0] : "";
}

export function isApplePlatform() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function openOutsideSteps() {
  return isApplePlatform()
    ? [
        "Tap the ••• button at the top right of this screen.",
        "Choose “Open in Safari”.",
        "Carry on there: Face ID only works in Safari."
      ]
    : [
        "Tap the ••• button at the top right of this screen.",
        "Choose “Open in browser”.",
        "Carry on there: your fingerprint or screen lock only works in a real browser."
      ];
}
