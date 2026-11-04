# 版本与发布

## Required publication language

All new commit subjects and bodies, PR titles and descriptions, Release titles and notes, asset names and packaged instructions must be written in English. Use `type(scope): concise English description` for commits and PR titles, and `Vehicle Manager vX.Y.Z` for official Release titles. PR titles describe the change rather than advertising a development version. Validation and upgrade notes must also be in English.

Run `node scripts/check-language.mjs`; the `english` CI job rejects Chinese text in PR/commit/release metadata and the English guide/template. Authors must still review actual English wording. Future packages contain `User-Guide.md` from `docs/portable-guide.en.md` and the existing English `README.txt`. Existing bilingual UI support is unchanged. Published historical ZIPs remain immutable; packaging changes take effect in the next version.

最新正式版本以 [GitHub Latest](https://github.com/yongkang2/vehicle-manager/releases/latest) 为准。本地源码可能是尚未发布的开发版本，不能据此断言线上最新版。

## 唯一版本来源

`package.json.version` → `npm version X.Y.Z --no-git-tag-version` 同步锁文件与 `shared/version.ts` → build → 打包。
标签为 `vX.Y.Z`，标题为 `Vehicle Manager vX.Y.Z`，只交付一个 `vehicle-manager-X.Y.Z-win-x64-时间戳.zip`。
构建时间戳使用 UTC，仅用于定位产物。数据库、共享协议及备份格式是独立兼容性版本，不与应用版本对齐。

## 发布步骤

1. 同步远程 main，从它建立开发分支；确认目标团队的最低客户端版本要求。通过 PR 合并，禁止直接推主线。
2. 升级应用版本，运行 `npm run check:version`、完整测试、lint、build。PR 的 Verify 工作流必须通过。
3. 在干净且同步到远程 main 的源码上运行 `npm run package:portable`。脚本自动检查版本、远程最新 Release、标签占用和上一正式版的提交继承关系；网络查询失败则不打包。它会执行完整测试、lint、build 和最终解压包验收，然后生成 SHA-256 与 provenance。
4. 核对 provenance 的 sourceCommit 就是远程 main；创建草稿 Release，标签、标题和附件版本必须与 package.json 一致。附唯一 ZIP、对应 .sha256 和 provenance.json。说明变化、兼容性、验证及升级步骤。
5. 下载草稿附件核对 SHA-256，再正式发布并设为 Latest。重新读取线上 Release，确认标签目标和附件信息。正式发布后不移动标签、不替换内容；变更内容升新版本。

## 正式版本沿革

| 版本 | 状态与说明 |
| --- | --- |
| 1.0.1 / 早期“1.0.2” | 历史预发布标题、标签和附件不一致，保留供追溯，不用于新安装 |
| 1.0.3、1.1.0、1.1.1、1.1.2 | 历史正式版本 |
| 1.1.3 | 有本地开发构建，没有正式 Release |
| 1.1.4 | 移除自动更新；正式包构建时间为 20261103095332，较早同版本本地构建不是正式交付包 |
| 1.1.5 / 1.2.0 | 开发阶段版本，没有正式 Release；部分团队门槛已到 1.2.0 |
| 1.2.1 | 修复共享协议兼容性；因团队最低版本门槛而跳到 1.2.1 |
| 1.2.2 | 统一版本来源，移除独立覆盖，增加发布校验和 CI；实际发布状态以 GitHub 为准 |

## 本地历史保留

旧分支、其他 worktree 和原有未提交文件不自动删除。统一工作开始前的改动保存在名为 `preserve-before-release-unification-20261104` 的 stash；应用后仍保留该备份。
本地冲突的旧 v1.0.2 标签保留为 `archive/local-v1.0.2-before-unification`，本地 v1.0.2 已与远程一致；备份标签不推送远程。
历史产物放在 releases/archive/，当前交付产物位于 releases/。全部为忽略文件，不进入源码仓库。业务数据不随版本整理移动。
