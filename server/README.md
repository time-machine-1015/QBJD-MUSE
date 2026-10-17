# QBJD MUSE 写入服务（部署说明）

这个服务是整套系统里**唯一能改数据的地方**。它做三件事：

1. 校验登录（共享密码 + 名单，都放在服务端，公开仓库里再也读不到）；
2. 把点赞、评论、回复、上传、删除、改故事写进**数据仓库**；
3. 每次操作只打**一个提交**，并且用"改完发现别人先提交了 → 整段重做"的方式，保证绝不覆盖别人的数据。

数据仓库与网站仓库分开：网站仓库（`QBJD-MUSE`）只放页面和图片外壳，**任何数据写入都不会触发网站重新构建**。

---

## 一、建数据仓库（约 1 分钟）

1. GitHub 右上角 `+` → **New repository**
2. 名字填 `QBJD-MUSE-data`，选 **Public**（Pages 免费版要求公开），**不要**勾选任何初始化文件
3. 建好后进 **Settings → Pages**：Source 选 `Deploy from a branch`，Branch 选 `main` + `/ (root)`，保存

> 数据仓库会是公开的（照片本来也是公开的）。里面只有：照片、回忆墙快照、评论、通知收件箱。**没有任何密钥。**

## 一·前置、把 server 代码放上 GitHub（约 1 分钟）

Deno Deploy 要从仓库里取 `server/write-api.js`，所以先把 `server/` 这个文件夹传上去：

1. 打开 `https://github.com/time-machine-1015/QBJD-MUSE` → **Add file → Upload files**
2. 把本机的 `server` 文件夹拖进去（**只拖这一个文件夹**，不要拖 index.html / cloud.js / 整个项目）
3. 页面应显示 `server/write-api.js` 等文件 → **Commit changes**

> `server/` 里没有任何密钥：token 只存在下一步的 Deno 环境变量里。

## 二、建一个"只够用"的 token（约 2 分钟）

1. GitHub 头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Token name 随便写（如 `qbjd-write-api`），Expiration 建议 1 年
3. **Repository access** → Only select repositories → 只勾 `QBJD-MUSE-data`
4. **Permissions → Repository permissions → Contents** 选 **Read and write**（其余全部保持 No access）
5. 生成后复制那串 `github_pat_...`（只显示一次）

> 这个 token 只存在于服务端环境变量里，前端代码、公开仓库、聊天记录里都不会出现。

## 三、部署到 Deno Deploy（免费，约 5 分钟）

1. 打开 <https://dash.deno.com/>，用 GitHub 账号登录（免费，不用信用卡）
2. **New Project** → 选 **Deploy from GitHub**（若没建过，先授权 Deno 访问仓库）
3. 选网站仓库 `QBJD-MUSE`，**Entry point** 填 `server/write-api.js`，分支 `main`
4. 部署前先设置环境变量（Environment Variables）：

| 变量名 | 填什么 |
|---|---|
| `GH_TOKEN` | 第二步生成的 `github_pat_...` |
| `GH_OWNER` | 你的 GitHub 用户名（如 `time-machine-1015`） |
| `GH_REPO` | `QBJD-MUSE-data` |
| `GH_BRANCH` | `main` |
| `ALLOWED_USERS` | 8 个名字，逗号分隔，如 `chenjianhao,yangzelin,...` |
| `PASSCODE_HASH` | 跑 `node server/hash-passcode.mjs 你的共享密码` 得到 |
| `SESSION_SECRET` | 同上那条命令输出的随机串 |
| `MQTT_SECRET` | 任意 32 位随机字符（生成通知主题用；所有人必须用同一串） |

5. 部署完成后会得到一个地址，形如 `https://qbjd-muse-write.deno.dev`

> 如果界面里没有"从 GitHub 部署"，备用方案是在本机跑：
> `npx -y deployctl deploy --project=qbjd-muse-write --prod server/write-api.js`
> （需要先在 Deno Deploy 账号设置里创建 Access Token）

## 四、验证（约 1 分钟）

浏览器打开：

```
https://你的地址.deno.dev/api/ping
```

应该看到 `{"ok":true,"service":"qbjd-muse-write-api","users":8,...}`。

再试登录（把名字和密码换成你们的）：

```
curl -X POST https://你的地址.deno.dev/api/login -H "Content-Type: application/json" -d "{\"user\":\"chenjianhao\",\"passcode\":\"共享密码\"}"
```

返回里带 `token` 就是通了。

---

## 五、接口一览（前端用）

所有写操作都要带 `Authorization: Bearer <登录返回的 token>`。

| 接口 | 作用 | 请求体 |
|---|---|---|
| `GET /api/ping` | 健康检查 | — |
| `POST /api/login` | 登录换 token | `{user, passcode}` |
| `POST /api/upload` | 上传照片（原图+缩略图+记录，一个提交） | `{fileName, imageBase64, thumbBase64, w, h, season, story}` |
| `POST /api/like` | 点赞/取消照片 | `{photoId, add}` |
| `POST /api/comment` | 评论照片 / 回复评论 | `{photoId, text, replyTo?}` |
| `POST /api/comment-like` | 点赞/取消评论 | `{photoId, commentId, add}` |
| `POST /api/story` | 保存故事（仅作者） | `{photoId, story}` |
| `POST /api/delete` | 删除回忆（仅作者） | `{photoId}` |
| `POST /api/comments` | 拉某张照片的评论 | `{photoId}` |
| `POST /api/wall` | 拉整面回忆墙 | — |

返回里带 `event`（事件内容）、`recipients`（该通知谁）。**客户端拿到 `recipients` 后通过 MQTT 立即推给对方，实现"秒到"的通知**；即使推送失败，对方最迟 60 秒后轮询到。

## 六、数据仓库里的文件

```
state/wall.json         回忆墙快照（照片记录 + 点赞名单 + 评论数）
state/version.json      版本号（客户端每 60 秒只拉这一个很小的文件）
comments/<照片id>.json  该照片的评论（含点赞名单、回复关系）
inbox/<用户名>.json     某人的通知收件箱（最新在前，最多 200 条）
photos/<文件名>         原图
photos/thumb_<文件名>   缩略图
```

读取走 GitHub Pages（`https://<用户名>.github.io/QBJD-MUSE-data/...`），**不需要 token、不限次数**；写入只能通过本服务。

## 七、本地自测（不需要联网，不碰真实仓库）

```bash
node server/test-local.mjs
```

会用一个"假 GitHub"跑 36 项检查，其中最关键的一项是**并发保护**：模拟"你读到状态之后、提交之前，别人先提交了"，验证两边改动都在、没有被覆盖——这正是旧版丢数据的病根。
