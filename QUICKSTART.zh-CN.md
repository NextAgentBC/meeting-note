# Meeting Note 小白安装说明

先记住一件事：**安装只做一次，大约 15 分钟**。以后开会时，打开你自己的 Meeting Note 网址就行，不需要再进 Cloudflare 或 GitHub。

平时使用只有三步：

1. 打开 Meeting Note，写会议名称，按 **Begin recording**。
2. 开完后按 **Stop & create note**。
3. 等页面出现 **Note ready**，查看转录、摘要和待办。

## 第一次安装

你会遇到两个名字：

- **GitHub**：放着 Meeting Note 原始文件的地方。安装时会自动在你的 GitHub 里复制一份。
- **Cloudflare**：替你免费运行这套工具的服务器。

不需要懂代码，也**不需要绑定信用卡**。

### 第一步：准备两个免费账号（约 8 分钟）

1. 注册 [GitHub](https://github.com/signup)：填邮箱、密码、用户名，完成人机验证，再输入邮箱里收到的验证码。
2. 注册 [Cloudflare](https://dash.cloudflare.com/sign-up)：填邮箱和密码，然后去邮箱点确认链接。
3. 两个网页都保持登录状态。

### 第二步：点一次安装按钮（约 5 分钟）

1. 打开 [Meeting Note 项目页面](https://github.com/NextAgentBC/meeting-note)。
2. 点页面上的 **Deploy to Cloudflare** 按钮。
3. Cloudflare 请你连接 GitHub 时，选择允许。这一步是为了在你的 GitHub 里复制一份 Meeting Note。
4. 其他设置都**保持默认**，直接点部署按钮。
5. 等 3 到 5 分钟，直到页面显示完成。期间不要关闭这个网页。

### 第三步：马上认领，让它只属于你（约 2 分钟）

1. 点完成页面上的 `workers.dev` 网址，形如 `https://meeting-note.你的名字.workers.dev`。**装完马上做这一步**：谁先完成，这份 Meeting Note 就归谁。
2. 输入你的名字，点 **Create my passkey**，用 Face ID、指纹或电脑开机密码确认。
3. 页面会显示一串**恢复码**，形如 `K7QF-M2XP-9HRT-C4WZ`。**马上截图保存**。它只显示这一次，以后手机和电脑都丢了，就靠它找回。
4. 点 **I've saved it**，完成。

以后打开这个 `workers.dev` 网址，就能录音和看纪要。建议把它加进浏览器书签。

## 手机上像 App 一样使用

- iPhone：用 Safari 打开，点分享按钮，再点 **添加到主屏幕**。
- Android：用 Chrome 打开，点菜单，再点 **安装应用**。

## 第一次先做两分钟测试

不要直接拿重要会议测试。先录两分钟，至少说三四句，再按停止。确认页面能出现文字和纪要以后，再用于正式会议。

## 常见问题

**为什么需要 GitHub 和 Cloudflare？** 这是让每个人免费拥有一份独立、私有副本的方法。安装完成后，日常使用不需要打开这两个网站。

**会收费吗？** 不绑卡，用的是免费额度。AI 每天大约够录两小时，用完当天就暂停，不会自动扣钱。额度每天 UTC 零点恢复，也就是温哥华夏令时下午 5 点。

**录音保存多久？** 音频 7 天后自动删除。转录和纪要保留在你自己的账号里。

**想在手机上也用（或者换了电脑）怎么登录？** 在已经登录的那台设备上，点右上角 **Add device**，屏幕上会出现一个二维码。用新手机的相机扫一下（或者把下面的链接发到新设备上打开），点 **Add this device**，再用 Face ID、指纹或锁屏密码确认，就登录好了。原来的设备照样能用。这个二维码只能用一次，10 分钟内有效。如果两台设备用的是同一个 Apple ID 或 Google 账号，新设备可能已经有通行密钥，直接点 **Sign in** 试试。

**恢复码忘了截图，或者弄丢了？** 在已经登录的设备上点右上角 **Add device**，再点 **Make a new recovery code**，马上截图保存。旧的恢复码会作废。

**所有设备都丢了怎么办？** 在登录页点 **Lost every device? Use your recovery code**，输入恢复码。恢复后会显示一个新的恢复码，旧的作废，记得再截图。其他设备上的登录也会全部失效。

**第一次打开就让我 Sign in，没有 Set up？** 说明有人抢在你前面认领了，很少见。进 Cloudflare 后台，打开 `meeting-note` 这个 Worker，依次点 **Settings（设置）→ Variables and Secrets（变量和机密）**，添加一个名为 `SETUP_CODE` 的机密（Secret），值设成一串你记得住的字。回到 Meeting Note，点 **Lost every device? Use your recovery code**，输入这串字，对方的登录就全部失效，这份 Meeting Note 归你。

**会议结束后一直没有纪要？** 打开这场会议，点 **Create the note from what we have**。如果当天免费 AI 额度已经用完，第二天再点 **Retry**。

**AI 写的内容一定准确吗？** 不一定。发出会议纪要前，请对照转录检查人名、数字和待办。
