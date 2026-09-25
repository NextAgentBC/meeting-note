const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const detectedLanguage = navigator.language.toLowerCase();
let language = detectedLanguage.startsWith("zh") ? "zh" : detectedLanguage.startsWith("fr") ? "fr" : "en";
let accounts = [];

// A link shared in WeChat opens in WeChat's own browser, where claiming the finished app — Face ID,
// a fingerprint, the screen lock — never works. Better to say so than to leave someone with an app
// they cannot sign into. The app keeps its own copy of this list (public/in-app-browser.js).
const IN_APP_BROWSERS = [
  ["WeChat", "微信", /MicroMessenger/i],
  ["QQ", "QQ", /\bQQ\/[\d.]+/i],
  ["Weibo", "微博", /Weibo/i],
  ["DingTalk", "钉钉", /DingTalk/i],
  ["Feishu", "飞书", /Lark|Feishu/i],
  ["Alipay", "支付宝", /AlipayClient/i],
  ["Douyin", "抖音", /aweme|BytedanceWebview/i],
  ["Xiaohongshu", "小红书", /xhsdiscover|XHS\//i],
  ["Facebook", "Facebook", /FBAN|FBAV/i],
  ["Instagram", "Instagram", /Instagram/i],
  ["LINE", "LINE", /\bLine\/\d/i]
];
const inApp = IN_APP_BROWSERS.find(([, , pattern]) => pattern.test(navigator.userAgent || ""));

/** Looks language up in a { en, zh, fr } object, falling back to English. */
function pick(choices) {
  return choices[language] ?? choices.en;
}

const LANGUAGE_CYCLE = { en: "zh", zh: "fr", fr: "en" };
const LANGUAGE_LABEL = { en: "EN", zh: "中文", fr: "Français" };
const appleDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installHereAnyway = false;
let releaseVersion = "";
let view = null;        // what the progress card is showing, so a language switch can redraw it
let retryAction = () => location.assign("/oauth/start");

// What each failure means in plain words. The Worker sends a code; the English sentence Cloudflare
// returned is kept as the detail line, because support needs it and the reader does not.
const PROBLEMS = {
  workers_subdomain: {
    zh: "这个 Cloudflare 账户还没有 workers.dev 免费域名。在 Cloudflare 控制台打开一次 Workers 页面就会自动创建，然后回来重试。",
    en: "This Cloudflare account has no workers.dev address yet. Open the Workers page in the Cloudflare dashboard once — that creates it — then come back and try again.",
    fr: "Ce compte Cloudflare n'a pas encore d'adresse workers.dev. Ouvrez une fois la page Workers du tableau de bord Cloudflare — cela la crée — puis revenez réessayer."
  },
  database: {
    zh: "创建数据库时出错。稍等片刻再重试；如果一直失败，请确认该账户可以使用 Cloudflare D1。",
    en: "Creating the database failed. Try again in a moment, and check that this account can use Cloudflare D1.",
    fr: "La création de la base de données a échoué. Réessayez dans un instant, et vérifiez que ce compte peut utiliser Cloudflare D1."
  },
  storage: {
    zh: "创建存储空间时出错。稍等片刻再重试；如果一直失败，请确认该账户可以使用 Workers KV。",
    en: "Creating storage failed. Try again in a moment, and check that this account can use Workers KV.",
    fr: "La création du stockage a échoué. Réessayez dans un instant, et vérifiez que ce compte peut utiliser Workers KV."
  },
  queue: {
    zh: "创建后台任务队列时出错。请确认该账户已启用 Cloudflare Queues，然后重试。",
    en: "Creating the background queue failed. Check that Cloudflare Queues is enabled on this account, then try again.",
    fr: "La création de la file d'attente a échoué. Vérifiez que Cloudflare Queues est activé sur ce compte, puis réessayez."
  },
  worker: {
    zh: "上传应用时出错。请重试；如果一直失败，请把下面这行英文发给我们。",
    en: "Uploading the app failed. Try again, and send us the line below if it keeps failing.",
    fr: "L'envoi de l'application a échoué. Réessayez ; si le problème persiste, envoyez-nous la ligne ci-dessous."
  },
  address: {
    zh: "应用已经创建，但公开地址没有打开。请重试一次。",
    en: "The app was created but its public address was not switched on. Please try once more.",
    fr: "L'application a été créée, mais son adresse publique n'a pas été activée. Veuillez réessayer."
  },
  session: {
    zh: "授权已过期。请重新授权 Cloudflare，然后继续安装。",
    en: "The authorization expired. Authorize Cloudflare again to continue.",
    fr: "L'autorisation a expiré. Autorisez de nouveau Cloudflare pour continuer."
  },
  authorization: {
    zh: "Cloudflare 授权没有完成，请重试。",
    en: "Cloudflare authorization did not finish. Please try again.",
    fr: "L'autorisation Cloudflare ne s'est pas terminée. Veuillez réessayer."
  },
  unknown: {
    zh: "安装没有完成。请重试；如果一直失败，请把下面这行英文发给我们。",
    en: "The installation did not finish. Try again, and send us the line below if it keeps failing.",
    fr: "L'installation ne s'est pas terminée. Réessayez ; si le problème persiste, envoyez-nous la ligne ci-dessous."
  }
};

function selectedAccount() {
  return document.querySelector('input[name="account"]:checked')?.value || "";
}

function translate() {
  document.documentElement.lang = language === "zh" ? "zh-Hans" : language === "fr" ? "fr" : "en";
  document.querySelectorAll("[data-zh]").forEach((element) => {
    element.textContent = element.dataset[language];
  });
  $("#language").textContent = LANGUAGE_LABEL[LANGUAGE_CYCLE[language]];
  if (inApp && !installHereAnyway) renderBrowserWarning();
  if (view) render();
}

function renderBrowserWarning() {
  const [name, chineseName] = inApp;
  $("#browserWarningTitle").textContent = pick({
    zh: `请用 Safari 或 Chrome 打开，不要用${chineseName}内置浏览器`,
    en: `Open this in Safari or Chrome, not ${name}`,
    fr: `Ouvrez ceci dans Safari ou Chrome, pas dans le navigateur intégré de ${name}`
  });
  const steps = pick({
    zh: ["点这个页面右上角的「···」。", appleDevice ? "选「在 Safari 中打开」。" : "选「在浏览器打开」。", "在那边点安装，全程两分钟。"],
    en: [
      "Tap the ••• button at the top right of this screen.",
      appleDevice ? "Choose “Open in Safari”." : "Choose “Open in browser”.",
      "Install from there: the whole thing takes two minutes."
    ],
    fr: [
      "Touchez le bouton ••• en haut à droite de cet écran.",
      appleDevice ? "Choisissez « Ouvrir dans Safari »." : "Choisissez « Ouvrir dans le navigateur ».",
      "Installez à partir de là : le tout prend deux minutes."
    ]
  });
  $("#browserSteps").replaceChildren(...steps.map((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    return item;
  }));
  $("#browserUrl").value = `${location.origin}/`;
  $("#browserUrl").scrollLeft = 0;
}

function show(id) {
  ["start", "account", "progress", "success"].forEach((name) => $(`#${name}`).classList.toggle("hidden", name !== id));
}

const WORKING = {
  session: { zh: "正在检查授权", en: "Checking your authorization", fr: "Vérification de votre autorisation" },
  install: { zh: "正在创建你的私人空间", en: "Creating your private space", fr: "Création de votre espace privé" }
};

function working(step) {
  view = { kind: "working", step };
  show("progress");
  render();
}

function fail(code, detail) {
  view = { kind: "problem", code, detail: detail || "" };
  show("progress");
  render();
}

function render() {
  const problem = view.kind === "problem" ? PROBLEMS[view.code] || PROBLEMS.unknown : null;
  $("#progressTitle").textContent = problem
    ? pick({ zh: "安装暂时没有完成", en: "Installation did not finish", fr: "L'installation ne s'est pas terminée" })
    : WORKING[view.step][language];
  $("#progressDetail").textContent = problem ? problem[language] : $("#progressDetail").dataset[language];
  $("#progressDetail").classList.toggle("error", Boolean(problem));
  $("#problemDetail").textContent = problem ? view.detail : "";
  $("#problemDetail").classList.toggle("hidden", !problem || !view.detail);
  const account = selectedAccount();
  const help = $("#problemHelp");
  help.classList.toggle("hidden", !problem || view.code !== "workers_subdomain" || !account);
  help.href = account ? `https://dash.cloudflare.com/${account}/workers/onboarding` : "#";
  help.textContent = pick({ zh: "打开 Cloudflare Workers 页面", en: "Open the Cloudflare Workers page", fr: "Ouvrir la page Cloudflare Workers" });
  $("#retry").textContent = problem && (view.code === "session" || view.code === "authorization")
    ? pick({ zh: "重新授权", en: "Authorize again", fr: "Autoriser de nouveau" })
    : pick({ zh: "重试安装", en: "Try again", fr: "Réessayer" });
  $("#retry").classList.toggle("hidden", !problem);
  $(".spinner").classList.toggle("hidden", Boolean(problem));
  $(".bar").classList.toggle("hidden", Boolean(problem));
}

async function loadSession() {
  working("session");
  const response = await fetch("/api/session", { credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    retryAction = () => location.assign("/oauth/start");
    fail("session", data.error || "");
    return;
  }
  if (!data.authorized) {
    show("start");
    return;
  }
  accounts = data.accounts || [];
  if (!accounts.length) {
    retryAction = () => location.assign("/oauth/start");
    fail("session", "No Cloudflare account is available");
    return;
  }
  $("#accounts").replaceChildren(...accounts.map((account, index) => {
    const label = document.createElement("label");
    label.className = "account-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "account";
    input.value = account.id;
    input.checked = index === 0;
    input.addEventListener("change", () => void showExisting());
    label.append(input, document.createTextNode(account.name));
    return label;
  }));
  show("account");
  void showExisting();
}

// What this account already has. A failed attempt leaves nothing behind, so an empty list here is
// the normal answer after one — but a finished install whose address was lost shows up.
async function showExisting() {
  const accountId = selectedAccount();
  const panel = $("#existing");
  panel.classList.add("hidden");
  $("#installAnother").classList.add("hidden");
  $("#install").classList.remove("hidden");
  if (!accountId) return;
  let apps = [];
  try {
    if (!releaseVersion) {
      const release = await fetch("/api/release").then((response) => (response.ok ? response.json() : null)).catch(() => null);
      releaseVersion = release?.version || "";
    }
    const response = await fetch(`/api/installs?accountId=${encodeURIComponent(accountId)}`, { credentials: "same-origin" });
    if (!response.ok) return;
    apps = (await response.json()).apps || [];
  } catch {
    return;
  }
  if (!apps.length || selectedAccount() !== accountId) return;
  $("#existingList").replaceChildren(...apps.map((app) => installRow(app, accountId)));
  panel.classList.remove("hidden");
  $("#install").classList.add("hidden");
  $("#installAnother").classList.remove("hidden");
}

function installRow(app, accountId) {
  const row = document.createElement("div");
  row.className = "existing-app";
  const link = document.createElement("a");
  link.href = app.url;
  link.textContent = app.url.replace("https://", "");
  link.rel = "noopener noreferrer";
  row.append(link);

  // Older copies may not expose /api/health, so an empty version means "needs repair/update",
  // not "hide the update action". Keep a reapply action even for the current release so the
  // owner always has a one-tap recovery path instead of being trapped at "already installed".
  const current = Boolean(app.version && releaseVersion && app.version === releaseVersion);
  if (!current || !app.claimed) {
    const tag = document.createElement("p");
    tag.className = "existing-tag";
    tag.textContent = !app.claimed
      ? pick({ zh: "还没有人认领这个应用", en: "Nobody has claimed this app yet", fr: "Personne n'a encore récupéré cette application" })
      : pick({ zh: "可以更新或修复到最新版", en: "Update or repair this app to the latest version", fr: "Vous pouvez la mettre à jour ou la réparer vers la dernière version" });
    row.append(tag);
  }

  const actions = document.createElement("div");
  actions.className = "existing-actions";
  const update = document.createElement("button");
  update.type = "button";
  update.className = "ghost-button";
  update.textContent = current
    ? pick({ zh: "重新应用最新版", en: "Reapply latest version", fr: "Réappliquer la dernière version" })
    : pick({ zh: "更新到最新版", en: "Update to latest", fr: "Mettre à jour vers la dernière version" });
  update.addEventListener("click", () => void act(update, "/api/update", { accountId, workerName: app.name }, (data) => {
    row.append(note(pick({
      zh: `已更新到 ${data.version}。打开应用即可，数据都在。`,
      en: `Updated to ${data.version}. Open it as usual; everything is still there.`,
      fr: `Mise à jour vers ${data.version}. Ouvrez-la comme d'habitude ; tout est toujours là.`
    })));
  }));
  actions.append(update);
  if (!app.claimed) {
    const reclaim = document.createElement("button");
    reclaim.type = "button";
    reclaim.className = "ghost-button";
    reclaim.textContent = pick({ zh: "重新获取认领链接", en: "Make a new claim link", fr: "Générer un nouveau lien de récupération" });
    reclaim.addEventListener("click", () => void act(reclaim, "/api/reclaim", { accountId, workerName: app.name }, (data) => {
      const claim = document.createElement("a");
      claim.className = "claim-link";
      claim.href = `${data.url}#claim=${encodeURIComponent(data.setupCode)}`;
      claim.textContent = pick({ zh: "用 Face ID 认领这个应用", en: "Claim it with Face ID", fr: "Récupérer cette application avec Face ID" });
      row.append(claim);
      row.append(note(pick({
        zh: "这个链接只用一次，认领后旧的认领码就作废了。",
        en: "This link works once; the old claim code stops working.",
        fr: "Ce lien ne fonctionne qu'une fois ; l'ancien code de récupération cesse alors de fonctionner."
      })));
    }));
    actions.append(reclaim);
  }
  if (actions.children.length) row.append(actions);
  return row;
}

function note(text) {
  const line = document.createElement("p");
  line.className = "existing-tag";
  line.textContent = text;
  return line;
}

// One place for the two buttons above: both talk to the installer and both can fail.
async function act(button, path, body, done) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = pick({ zh: "请稍候…", en: "Working…", fr: "Veuillez patienter…" });
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "That did not work");
    button.remove();
    done(data);
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    fail("unknown", error.message);
  }
}

async function install() {
  const accountId = selectedAccount();
  if (!accountId) return;
  working("install");
  const response = await fetch("/api/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ accountId })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The token lives for 30 minutes, so a retry after a failed step needs no second sign-in.
    const expired = response.status === 401;
    retryAction = expired ? () => location.assign("/oauth/start") : () => install().catch((error) => fail("unknown", error.message));
    fail(expired ? "session" : data.code || "unknown", data.error || "");
    return;
  }
  $("#openApp").href = `${data.appUrl}#claim=${encodeURIComponent(data.setupCode)}`;
  // The address without the one-time claim code: this is the one worth keeping.
  $("#appAddress").value = data.appUrl;
  $("#appAddress").scrollLeft = 0;
  // And the code in plain sight, because the link is not the only way this ends up being claimed.
  $("#setupCodeValue").value = data.setupCode;
  $("#setupCodeValue").scrollLeft = 0;
  // `ready` is false when the address did not answer while the installer waited for it.
  $("#successNote").classList.toggle("hidden", data.ready !== false && !data.addressIsNew);
  show("success");
}

$("#copyBrowserUrl").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("#browserUrl").value);
    button.textContent = pick({ zh: "已复制", en: "Copied", fr: "Copié" });
    window.setTimeout(() => { button.textContent = button.dataset[language]; }, 2000);
  } catch {
    $("#browserUrl").select();
  }
});
$("#ignoreBrowser").addEventListener("click", () => {
  installHereAnyway = true;
  $("#browserWarning").classList.add("hidden");
});
if (inApp) {
  $("#browserWarning").classList.remove("hidden");
  // The install links stay where they are; until the warning is dismissed they lead to it.
  document.querySelectorAll('a[href="/oauth/start"]').forEach((link) => link.addEventListener("click", (event) => {
    if (installHereAnyway) return;
    event.preventDefault();
    $("#browserWarning").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
}
$("#language").addEventListener("click", () => { language = LANGUAGE_CYCLE[language]; translate(); });
$("#install").addEventListener("click", () => install().catch((error) => fail("unknown", error.message)));
$("#installAnother").addEventListener("click", () => install().catch((error) => fail("unknown", error.message)));
$("#retry").addEventListener("click", () => retryAction());
$("#copySetupCode").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("#setupCodeValue").value);
    button.textContent = pick({ zh: "已复制", en: "Copied", fr: "Copié" });
    window.setTimeout(() => { button.textContent = button.dataset[language]; }, 2000);
  } catch {
    $("#setupCodeValue").select();
  }
});
$("#copyAddress").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("#appAddress").value);
    button.textContent = pick({ zh: "已复制", en: "Copied", fr: "Copié" });
    window.setTimeout(() => { button.textContent = button.dataset[language]; }, 2000);
  } catch {
    $("#appAddress").select();
  }
});
translate();
if (params.get("error")) {
  retryAction = () => location.assign("/oauth/start");
  fail(params.get("error") === "token" ? "session" : "authorization");
} else {
  loadSession().catch((error) => {
    retryAction = () => location.assign("/oauth/start");
    fail("unknown", error.message);
  });
}
