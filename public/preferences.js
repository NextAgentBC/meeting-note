// Local-only display preferences: seven colour themes, light/dark/system appearance, and UI language.
// These never leave the device and deliberately do not require an account setting or a network request.

const $ = (selector) => document.querySelector(selector);

export const THEMES = ["pine", "celadon", "dusk", "pomegranate", "lilac", "rosewood", "butter"];
export const MODES = ["light", "dark", "system"];
export const LANGUAGES = ["en", "zh"];

const KEYS = {
  theme: "meetingnote:theme",
  mode: "meetingnote:mode",
  language: "meetingnote:language"
};

const ZH = {
  "Meetings": "会议",
  "Plans": "计划",
  "Notes": "笔记",
  "Me": "我的",
  "New": "新",
  "Write a note or add photos": "写笔记或添加照片",
  "Ideas, memories, shopping lists—save anything in seconds.": "灵感、回忆、购物清单，几秒钟就能保存。",
  "Record a meeting": "记录会议",
  "AI transcript and organized notes": "AI 转写并整理会议笔记",
  "What's this meeting?": "这是什么会议？",
  "Team meeting · Monday": "团队会议 · 星期一",
  "What to record": "录制内容",
  "Microphone": "麦克风",
  "Zoom + microphone": "Zoom + 麦克风",
  "Note type and language": "笔记类型与语言",
  "Note type": "笔记类型",
  "Business meeting": "商务会议",
  "Workshop": "讲座 / 工作坊",
  "Interview": "访谈",
  "Language": "语言",
  "English": "英文",
  "Start recording": "开始录音",
  "Your meetings": "你的会议",
  "Refresh": "刷新",
  "Quick note": "随心笔记",
  "Save whatever is on your mind": "随手记下此刻想到的事",
  "Note category": "笔记分类",
  "Let AI organize": "让 AI 自动整理",
  "Idea": "灵感",
  "Journal": "日记",
  "Plan": "计划",
  "Life": "生活",
  "Reference": "资料",
  "Write an idea, a moment, a shopping note…": "写下灵感、片刻回忆、购物清单……",
  "Say it instead": "说一段",
  "Listening": "正在听",
  "tap to stop": "点一下结束",
  "Writing it down…": "正在转成文字…",
  "Nothing was recorded.": "没有录到声音。",
  "Nothing was heard. Try again, a little closer to the microphone.": "没有听清。再试一次，离麦克风近一点。",
  "Meeting Note could not use the microphone. Check the permission for this site.": "Meeting Note 无法使用麦克风。请检查这个网站的麦克风权限。",
  "This browser cannot record audio.": "这个浏览器不能录音。",
  "Couldn't transcribe that recording. Please try again.": "这段录音没能转成文字，请再试一次。",
  "Take photo": "拍照",
  "Choose photos": "从相册选择",
  "Save note": "保存笔记",
  "Up to 6 photos. They are resized and converted to WebP on this device before upload.": "最多 6 张照片。上传前会在本机缩小并转换为 WebP。",
  "Lost the code?": "认领码丢了？",
  "Open the installer": "打开安装器",
  ", pick the same Cloudflare account, and choose \"Make a new claim link\".": "，选同一个 Cloudflare 账户，点「重新获取认领链接」。",
  "Who said what": "谁在说话",
  "Listen again, and tell the voices apart": "重听一遍，把说话的人分开",
  "A second pass over this meeting with a model that marks each speaker. It runs on Workers AI inside your own Cloudflare account — the audio does not go anywhere else — and it is billed by the audio minute.": "用能区分说话人的模型把这场会议重听一遍。它跑在你自己 Cloudflare 账户的 Workers AI 上——录音不会发去别处——按音频分钟计费。",
  "Start": "开始",
  "Start?": "开始吗？",
  "Save the names": "保存姓名",
  "Rewrite the note with names": "用姓名重写笔记",
  "Close": "关闭",
  "Their name": "他的名字",
  "minutes of audio": "分钟录音",
  "about": "约",
  "Listening again": "正在重听",
  "Done. Name the voices you recognise.": "完成。认得出来的，给他起个名字。",
  "Names saved.": "姓名已保存。",
  "Rewriting…": "正在重写…",
  "This runs a paid model in your own Cloudflare account.": "这会在你自己的 Cloudflare 账户里调用一个按量计费的模型。",
  "Rewrite this meeting's note from the new transcript, with the names?": "用新的转写（带姓名）重写这场会议的笔记？",
  "Show less": "收起",
  "Date": "日期",
  "Time": "时间",
  "Forget": "忘记",
  "All": "全部",
  "Filter notes by kind": "按分类筛选笔记",
  "Nothing in this kind yet.": "这个分类还没有内容。",
  "Quick notes": "随心笔记",
  "Your text and photos, newest first.": "文字和照片按最新时间排列。",
  "Ask your meetings, notes and plans": "询问你的会议、笔记和计划",
  "What did we decide about the venue?": "关于场地，我们最后决定了什么？",
  "Ask": "提问",
  "Examples": "示例",
  "What's on this week?": "这周有什么安排？",
  "Who promised to do what?": "谁答应了做什么？",
  "Everything you record, write, photograph and plan is remembered on its own. Ask in English or Chinese, and every answer shows where it came from.": "录音、文字、照片和计划都会自动归档。你可以用中文或英文提问，每个回答都会标明来源。",
  "Remembered facts": "长期记忆",
  "Things that stay true, taken from your meetings. The newest version of each wins.": "从会议中提取、长期有效的信息；如有更新，以最新版为准。",
  "Recently remembered": "最近记录",
  "Show": "显示",
  "Everything": "全部",
  "Meeting notes": "会议笔记",
  "Said aloud": "语音记录",
  "Transcripts": "逐字稿",
  "Free AI today": "今日免费 AI 额度",
  "Checking…": "正在检查……",
  "AI options": "AI 选项",
  "Understand new photos": "理解新照片",
  "Understand new photos with AI": "使用 AI 理解新照片",
  "Optional · reads visible text and suggests a category. Existing photos are not sent when you turn it on.": "可选 · 识别可见文字并建议分类。开启时不会发送已有照片。",
  "Transcription": "转写",
  "Vocabulary": "专有词汇",
  "Names and terms the transcript should spell right": "帮助转写正确识别人名和专业词",
  "Sign-in": "登录",
  "Add a phone or computer": "添加手机或电脑",
  "Show a code the new device scans": "显示二维码供新设备扫描",
  "Recovery code": "恢复码",
  "Make a new one if you lost yours": "遗失后可以重新生成",
  "Connected apps": "已连接应用",
  "Process recordings and return notes to your local vault": "处理录音并把笔记返回本地资料库",
  "Calendar": "日历",
  "Calendar sync": "日历同步",
  "Google, iPhone, Mac or Outlook": "Google、iPhone、Mac 或 Outlook",
  "This device": "当前设备",
  "Install on this device": "安装到这台设备",
  "Opens like an app, from the home screen": "从主屏幕像 App 一样打开",
  "Keep Meeting Note one tap away": "让 Meeting Note 一点就开",
  "On your home screen it opens like any other app: one tap, no address to remember and no browser bar.": "放到手机主屏幕后，它就像普通 App 一样：点一下就开，不用记网址，也没有浏览器地址栏。",
  "Add to home screen": "添加到主屏幕",
  "Tap the Share button: the square with an arrow, at the bottom of Safari.": "点 Safari 底部的分享按钮（方框加向上箭头）。",
  "Scroll down that list and choose “Add to Home Screen”.": "在弹出的列表里往下划，选「添加到主屏幕」。",
  "Tap Add. Meeting Note now sits with your other apps.": "点「添加」。Meeting Note 就和其他 App 排在一起了。",
  "Open the browser menu: the three dots at the top right.": "打开浏览器菜单（右上角三个点）。",
  "Choose “Install app”, or “Add to Home screen”.": "选「安装应用」或「添加到主屏幕」。",
  "Confirm. Meeting Note now sits with your other apps.": "确认。Meeting Note 就和其他 App 排在一起了。",
  "In Chrome or Edge, click the install icon at the right of the address bar.": "Chrome 或 Edge：点地址栏右侧的安装图标。",
  "In Safari, open the File menu and choose “Add to Dock”.": "Safari：打开「文件」菜单，选「添加到程序坞」。",
  "Meeting Note then opens in its own window, with no address bar.": "之后 Meeting Note 会在自己的窗口里打开，没有地址栏。",
  "Or keep the address": "或者把网址存下来",
  "This is where your Meeting Note lives. Save it in your notes, or send it to yourself.": "这就是你的 Meeting Note 的网址。存进备忘录，或者发给自己。",
  "The address of your Meeting Note": "你的 Meeting Note 网址",
  "Lost it? Sign in to Cloudflare and open Workers: it is the one whose name starts with meeting-note.": "网址忘了？登录 Cloudflare 打开 Workers，名字以 meeting-note 开头的那个就是。",
  "Add Meeting Note to your home screen and it opens in one tap.": "把 Meeting Note 加到主屏幕，以后点一下就能打开。",
  "Show me how": "教我怎么加",
  "Not now": "以后再说",
  "Meeting Note is installed and ready from your home screen.": "Meeting Note 已安装，可以从主屏幕打开了。",
  "An app's own browser cannot ask for Face ID, a fingerprint or your screen lock, and cannot put this on your home screen. Your Meeting Note is fine — it needs a real browser.": "App 自带的浏览器无法调用 Face ID、指纹或屏幕锁，也不能把它加到主屏幕。你的 Meeting Note 没有问题，换成系统浏览器就行。",
  "Tap the ••• button at the top right of this screen.": "点这个页面右上角的「···」。",
  "Choose “Open in Safari”.": "选「在 Safari 中打开」。",
  "Choose “Open in browser”.": "选「在浏览器打开」。",
  "Carry on there: Face ID only works in Safari.": "在那边继续：Face ID 只能在 Safari 里用。",
  "Carry on there: your fingerprint or screen lock only works in a real browser.": "在那边继续：指纹和屏幕锁只能在系统浏览器里用。",
  "Copy this address": "复制这个网址",
  "Paste it into Safari or Chrome if the menu has no such choice.": "如果菜单里没有这一项，就把网址粘贴到 Safari 或 Chrome 打开。",
  "Try it here anyway": "仍然在这里试试",
  "The address of this page": "这个页面的网址",
  "A newer Meeting Note is out. Updating takes a minute and keeps your meetings and notes.": "Meeting Note 有新版本了。更新大约一分钟，会议和笔记都会保留。",
  "Update": "更新",
  "Time zone": "时区",
  "Sign out": "退出登录",
  "Only you can sign in · audio deletes itself after 7 days": "只有你能登录 · 录音将在 7 天后自动删除",
  "Only you can sign in · recordings are kept until you delete them": "只有你能登录 · 录音会一直保留，直到你主动删除",
  "Appearance & language": "外观与语言",
  "Colour theme": "主题色",
  "Appearance": "明暗模式",
  "Light": "浅色",
  "Dark": "深色",
  "Follow system": "跟随系统",
  "Interface language": "界面语言",
  "Pine": "松针",
  "Celadon": "青瓷",
  "Dusk": "暮山",
  "Pomegranate": "石榴",
  "Lilac": "雾霭",
  "Rosewood": "豆沙",
  "Butter": "酪黄",
  "Coming up": "接下来",
  "Tap and say your plans": "点一下，说出你的计划",
  "Up to two minutes · English or 中文": "最长两分钟 · 中文或英文",
  "Cancel": "取消",
  "Add": "添加",
  "Check these": "请确认",
  "Add all": "全部添加",
  "Nothing planned yet.": "暂时没有计划。",
  "Recording": "录音",
  "Note": "笔记",
  "Transcript": "逐字稿",
  "Rewrite note": "重新整理笔记",
  "Export .md": "导出 .md",
  "Delete": "删除",
  "Close": "关闭",
  "Loading…": "正在加载……",
  "Saving…": "正在保存……",
  "Converting to WebP…": "正在转换为 WebP……",
  "Could not prepare this photo. Please try again. For HEIC, choose “Most Compatible” in iPhone Camera settings.": "无法处理这张照片，请重试。如果是 HEIC，请在 iPhone「设置 → 相机 → 格式」中选择「兼容性最佳」。",
  "No recordings yet. Your first meeting will appear here.": "还没有录音。第一次会议会显示在这里。",
  "Note ready": "笔记已完成",
  "Needs attention": "需要处理",
  "Transcribing": "正在转写",
  "transcription": "转写",
  "section notes": "阶段笔记",
  "meeting notes": "会议笔记",
  "memory search": "记忆检索",
  "facts": "长期记忆",
  "photo understanding": "照片理解",
  "Offline": "离线",
  "Meeting Note · private sign-in": "Meeting Note · 私密登录",
  "Sign in": "登录",
  "Your phone or computer confirms it's you with Face ID, a fingerprint or your screen lock. No password.": "使用手机或电脑的 Face ID、指纹或屏幕锁确认身份，无需密码。",
  "This browser can't use passkeys": "此浏览器不支持通行密钥",
  "Open this page in a recent Safari, Chrome or Edge.": "请使用最新版 Safari、Chrome 或 Edge 打开此页面。",
  "One-time setup code": "一次性设置码",
  "Use the code you chose during the one-time installation.": "请输入首次安装时设置的代码。",
  "Do this straight after installing: whoever finishes this step first becomes the owner.": "请在安装后立即完成；第一个完成的人将成为所有者。",
  "Your name": "你的名字",
  "Create my passkey": "创建我的通行密钥",
  "Set up your Meeting Note": "设置你的 Meeting Note",
  "This copy is brand new. Create your passkey now, and it's yours alone.": "这是全新安装。现在创建通行密钥，它将只属于你。",
  "Sign in with your passkey": "使用通行密钥登录",
  "Add this device": "添加这台设备",
  "You opened a link from a device where you're signed in. Create a passkey here, and this phone or computer can sign in with Face ID, a fingerprint or its screen lock.": "你打开了已登录设备生成的链接。请在这里创建通行密钥，此手机或电脑以后即可使用 Face ID、指纹或屏幕锁登录。",
  "New phone or computer? On a device where you're already signed in, open": "要添加新手机或电脑？请在已登录的设备上打开",
  "and scan the code with this one.": "，再用新设备扫描二维码。",
  "Lost every device? Use your recovery code": "所有设备都丢失了？使用恢复码",
  "The code you saved when you set up Meeting Note. It puts a new passkey on this device, signs you out everywhere else, and gives you a new code.": "请输入设置 Meeting Note 时保存的恢复码。系统会在本机创建新通行密钥、退出其他设备，并生成新的恢复码。",
  "Replace my passkey": "更换我的通行密钥",
  "← Back to sign in": "← 返回登录",
  "Your other devices keep working. The link works once.": "其他设备仍可继续使用；此链接只能使用一次。",
  "Save your recovery code": "保存恢复码",
  "Copy the code": "复制恢复码",
  "Copied": "已复制",
  "That code has expired. Make a new one.": "此二维码已过期，请生成新的二维码。",
  "Loading connections…": "正在加载连接……",
  "Revoke": "撤销",
  "I've saved it — open Meeting Note": "我已保存，打开 Meeting Note",
  "Records this device's microphone. Keep Meeting Note open while it records.": "录制本机麦克风；录音期间请保持 Meeting Note 打开。",
  "Loading meetings…": "正在加载会议……",
  "Meeting": "会议",
  "Preparing": "正在准备",
  "saved": "已保存",
  "transcribed": "已转写",
  "sections": "段落",
  "level": "音量",
  "Online": "在线",
  "Stop & create note": "停止并生成笔记",
  "Finishing transcript": "正在完成转写",
  "Waiting for the final audio chunks…": "正在等待最后的音频片段……",
  "Retry finishing this meeting": "重试完成本次会议",
  "Create the note from what we have": "用现有内容生成笔记",
  "Download the full local recording": "下载完整本地录音",
  "Notes appear here about five minutes after you start, and are merged into one note when you stop.": "开始约五分钟后会显示阶段笔记；停止录音后会合并成完整笔记。",
  "0 chunks": "0 个音频片段",
  "Transcript will appear here after the first chunk.": "第一个音频片段完成后会显示逐字稿。",
  "Like “Next Tuesday at 3, call Cindy about the venue” or “月底前把房租交了”. You check each plan before it's added.": "例如“下周二下午三点给 Cindy 打电话确认场地”或“月底前交房租”。添加前你可以逐条确认。",
  "Try sending it again": "重新发送",
  "Found in what you said and in your meetings. Nothing is added until you say so.": "从语音和会议中发现；未经你确认不会加入计划。",
  "＋ Take photo": "＋ 拍照",
  "Show more": "显示更多",
  "This meeting's audio": "本次会议的录音",
  "Keep this recording permanently": "永久保留这次录音",
  "Turn off for a session where people were told the audio would be deleted.": "如果参会者被告知录音会删除，请关闭此项。",
  "Download all (.zip)": "全部下载（.zip）",
  "Delete the audio": "删除录音",
  "Product names, brands, people and jargon you say often, one per line. The transcription expects them, and a check afterwards fixes near-misses, such as 荔猪蓝 → 丽珠兰. They apply to every meeting, so keep it to words you really use.": "把常说的产品名、品牌、人名和专业词逐行填写。转写会优先识别，并在之后修正近似词，例如“荔猪蓝”→“丽珠兰”。这些词会用于所有会议，请只保留真正需要的词。",
  "Save vocabulary": "保存专有词汇",
  "Put your plans on your calendar": "把计划加入日历",
  "Or subscribe once": "或一次订阅，持续同步",
  "Your calendar then shows everything you add here and keeps up with changes by itself: Apple Calendar within an hour, Google Calendar within a day.": "日历会显示你在这里添加的全部计划并自动同步更新：Apple 日历通常一小时内，Google 日历通常一天内。",
  "Make my private calendar address": "生成我的私人日历地址",
  "Copy address": "复制地址",
  "iPhone · Mac: subscribe": "iPhone · Mac：订阅",
  "Google: paste it here": "Google：在这里粘贴",
  "Sign in on another device": "在另一台设备上登录",
  "On the new device, point the camera at this code, or open the link below on it.": "在新设备上扫描此二维码，或打开下方链接。",
  "Copy link": "复制链接",
  "Make a new code": "生成新二维码",
  "It works once, for ten minutes. Only open it on your own device.": "二维码只能使用一次，有效期十分钟。请只在自己的设备上打开。",
  "Your way back in": "恢复访问方式",
  "If every device you sign in with is lost, the recovery code puts Meeting Note on a new one. Lost the code you saved? Make a new one here; the old one stops working at once.": "如果所有已登录设备都丢失，恢复码可以让新设备重新访问 Meeting Note。如果恢复码也丢失，可在这里重新生成，旧恢复码会立即失效。",
  "Make a new recovery code": "生成新的恢复码",
  "Take a screenshot or write it down now: it won't be shown again.": "请立即截图或抄写保存；此恢复码不会再次显示。",
  "Connect NextNote": "连接 NextNote",
  "Make a private token, copy it into NextNote, then close this sheet. The token is shown once and can be revoked here at any time.": "生成私人令牌并复制到 NextNote，然后关闭此窗口。令牌只显示一次，可随时在这里撤销。",
  "Make a NextNote token": "生成 NextNote 令牌",
  "Copy token": "复制令牌",
  "Save it in NextNote now. For security, it won't be shown again.": "请立即保存到 NextNote；为确保安全，之后不会再次显示。",
  "Your sign-in has expired. Recording continues, and new audio waits on this device.": "登录已过期。录音仍会继续，新音频会暂存在本机。",
  "Sign in again": "重新登录",
  "Delete this quick note and all of its photos?": "删除这条随心笔记及其中的全部照片？"
};

const textSource = new WeakMap();
const attributeSource = new WeakMap();
let currentLanguage = "en";
let translating = false;

function read(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private browsing can deny storage */ }
}

function translateDynamic(value) {
  let match;
  const kinds = {
    transcription: "转写", "section notes": "阶段笔记", "meeting notes": "会议笔记",
    plans: "计划", answers: "回答", search: "搜索", facts: "长期记忆",
    "memory search": "记忆检索", "photo understanding": "照片理解"
  };
  const duration = (text) => {
    let durationMatch;
    if ((durationMatch = text.match(/^([\d.]+) hours?$/))) return `${durationMatch[1]} 小时`;
    if ((durationMatch = text.match(/^(\d+) minutes?$/))) return `${durationMatch[1]} 分钟`;
    return text;
  };
  const inAppNames = {
    WeChat: "微信", QQ: "QQ", Weibo: "微博", DingTalk: "钉钉", Feishu: "飞书",
    Alipay: "支付宝", Douyin: "抖音", Xiaohongshu: "小红书", Facebook: "Facebook",
    Instagram: "Instagram", LINE: "LINE"
  };
  if ((match = value.match(/^Open this in Safari or Chrome, not (.+)$/))) {
    return `请用 Safari 或 Chrome 打开，不要用${inAppNames[match[1]] || match[1]}内置浏览器`;
  }
  if ((match = value.match(/^(\d+) more pieces$/))) return `还有 ${match[1]} 段`;
  if ((match = value.match(/^(\d+)\/(\d+) ready$/))) return `${match[1]}/${match[2]} 张已准备`;
  if ((match = value.match(/^Uploading photo (\d+)\/(\d+)…$/))) return `正在上传照片 ${match[1]}/${match[2]}…`;
  if ((match = value.match(/^About (.+) of free recording left today$/))) return `今天约剩 ${duration(match[1])}免费录音额度`;
  if ((match = value.match(/^(.+) of recording left today$/))) return `今天剩余录音时间：${duration(match[1])}`;
  if ((match = value.match(/^resets (.+)$/))) return `${match[1]} 重置`;
  if ((match = value.match(/^(\d+) terms · spelled right in every transcript$/))) return `${match[1]} 个词 · 用于每次转写`;
  if ((match = value.match(/^([\d,]+) units · (\d+) calls?$/))) return `${match[1]} 单位 · ${match[2]} 次`;
  if ((match = value.match(/^(\d+) calls?$/))) return `${match[1]} 次`;
  if ((match = value.match(/^(.+?) ([\d,]+) units · (\d+) calls?$/))) return `${kinds[match[1]] || match[1]} ${match[2]} 单位 · ${match[3]} 次`;
  if ((match = value.match(/^(.+?) (\d+) calls?$/))) return `${kinds[match[1]] || match[1]} ${match[2]} 次`;
  if ((match = value.match(/^Note ready(\s*→)?$/i))) return `笔记已完成${match[1] || ""}`;
  if ((match = value.match(/^(\d+) chunks?$/))) return `${match[1]} 个音频片段`;
  if ((match = value.match(/^([\d,]+) of ([\d,]+) free AI units used \((.+)\)\. An hour of recording uses about ([\d,]+)\.(.*)$/))) {
    const breakdown = match[3].split(" · ").map((part) => {
      const item = part.match(/^(.+?) ([\d,]+)$/);
      return item ? `${kinds[item[1]] || item[1]} ${item[2]}` : part;
    }).join(" · ");
    const limit = match[5] ? " 达到上限后 AI 会暂停到额度重置，不会产生费用。" : "";
    return `已使用 ${match[1]} / ${match[2]} 免费 AI 单位（${breakdown}）。每小时录音约使用 ${match[4]}。${limit}`;
  }
  return value;
}

export function t(value) {
  if (currentLanguage !== "zh") return value;
  return ZH[value] || translateDynamic(value);
}

function translated(value) {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const core = value.trim();
  if (!core) return value;
  return `${leading}${t(core)}${trailing}`;
}

function syncText(node) {
  const current = node.nodeValue || "";
  let source = textSource.get(node);
  if (source === undefined || (current !== source && current !== translated(source))) {
    source = current;
    textSource.set(node, source);
  }
  const next = currentLanguage === "zh" ? translated(source) : source;
  if (current !== next) node.nodeValue = next;
}

function syncAttribute(element, name) {
  const current = element.getAttribute(name);
  if (current == null) return;
  let sources = attributeSource.get(element);
  if (!sources) { sources = new Map(); attributeSource.set(element, sources); }
  let source = sources.get(name);
  if (source === undefined || (current !== source && current !== t(source))) {
    source = current;
    sources.set(name, source);
  }
  const next = currentLanguage === "zh" ? t(source) : source;
  if (current !== next) element.setAttribute(name, next);
}

function translateTree(root = document.body) {
  if (!root || translating) return;
  translating = true;
  try {
    if (root.nodeType === Node.TEXT_NODE) syncText(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) syncText(node);
      const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
      for (const element of elements) for (const name of ["placeholder", "aria-label", "title"]) syncAttribute(element, name);
    }
  } finally {
    translating = false;
  }
}

function setLanguage(language, persist = true) {
  currentLanguage = LANGUAGES.includes(language) ? language : "en";
  document.documentElement.lang = currentLanguage === "zh" ? "zh-Hans" : "en";
  document.documentElement.dataset.language = currentLanguage;
  if (persist) write(KEYS.language, currentLanguage);
  translateTree(document.body);
  const select = $("#interfaceLanguage");
  if (select) select.value = currentLanguage;
  window.dispatchEvent(new CustomEvent("meetingnote:language-changed", { detail: { language: currentLanguage } }));
}

function refreshThemeMeta() {
  // The glass bars re-measure what is behind them whenever the colours change.
  window.dispatchEvent(new CustomEvent("meetingnote:appearance-changed"));
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && color) meta.content = color;
  });
}

function setTheme(theme, persist = true) {
  const value = THEMES.includes(theme) ? theme : "pine";
  document.documentElement.dataset.theme = value;
  if (persist) write(KEYS.theme, value);
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === value));
  });
  refreshThemeMeta();
}

function setMode(mode, persist = true) {
  const value = MODES.includes(mode) ? mode : "dark";
  document.documentElement.dataset.mode = value;
  if (persist) write(KEYS.mode, value);
  const select = $("#appearanceMode");
  if (select) select.value = value;
  refreshThemeMeta();
}

export function initPreferences() {
  const browserLanguage = navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
  const theme = read(KEYS.theme, document.documentElement.dataset.theme || "pine");
  const mode = read(KEYS.mode, document.documentElement.dataset.mode || "dark");
  const language = read(KEYS.language, document.documentElement.dataset.language || browserLanguage);
  setTheme(theme, false);
  setMode(mode, false);
  setLanguage(language, false);

  $("#themePicker")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-choice]");
    if (button) setTheme(button.dataset.themeChoice);
  });
  $("#appearanceMode")?.addEventListener("change", (event) => setMode(event.target.value));
  $("#interfaceLanguage")?.addEventListener("change", (event) => setLanguage(event.target.value));

  const observer = new MutationObserver((records) => {
    if (translating) return;
    for (const record of records) {
      if (record.type === "characterData") syncText(record.target);
      for (const node of record.addedNodes) translateTree(node);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (document.documentElement.dataset.mode === "system") refreshThemeMeta();
  });
}
