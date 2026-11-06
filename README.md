# 电子书站 · GitHub Pages 版（纯静态）

这个文件夹就是可以直接推到 GitHub、开 GitHub Pages 的版本。
不用国内服务器，不用 CloudBase，不用备案。

来源：CloudBase 部署包里的前端（`frontend/`），`config.js` 里
`API_BASE_URL` 为空，所以跑的是本地模式。

## Pages 上能用、不能用的，要先说清楚

能用：
- 书架、阅读器、目录、搜索
- 段评下划线 + 数量气泡，点开按热门 / 最新看、点赞、发表
- 多书签、自动实时进度（不用点书签）、字号行距、三档主题
- 上传 EPUB / TXT，EPUB2 NCX / EPUB3 nav 目录、单文件多锚点、
  `<p>` 和 `<br>` 空行分段、去掉纯数字页码段

不能用（Pages 是纯静态托管，没有后台）：
- **段评、上传的书、书签、进度都只存在每个访客自己的浏览器里，
  别人看不到你的，你也看不到别人的。** 想让大家互通，必须
  再接一个后台（之前那套 CloudBase 就是干这个的）。
- EPUB 里的插图在本地模式下显示占位文字，不是真图。
- 打开时书架是空的，需要你自己先上传一本 EPUB / TXT；
  示例书在 CloudBase 包的 `database/seed.js` 里，是我现写的
  两篇短篇示例，不是商业小说。

## 怎么发布

1. 新建一个 GitHub 仓库（建议单独建一个，别放进 re0-continuation 里），
   把这个文件夹里的全部文件推到 `main` 分支根目录。
2. 仓库 Settings → Pages → Source 选 Deploy from a branch，
   Branch 选 `main` / `(root)`，保存。
3. 等一两分钟，打开 `https://<用户名>.github.io/<仓库名>/` 就能看到。

注意：推之前先确认右上角登录的是仓库所有者账号。
之前在浏览器里登的是 ziruiyu055-droid，没有 y20522 仓库的推送权限，
用错账号推会失败或只能 Fork，千万别用错账号提交。
