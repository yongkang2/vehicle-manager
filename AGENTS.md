# 项目长期规则

遵循用户全局指令：最少假设、最简单实现、最小改动、可验证结果。

## Documentation layout

- Keep the root README.md concise and use it as the documentation entry point. User guides and detailed engineering documents belong in docs/.
- Read docs/design.md for the consolidated product scope, visual design and interface behavior. It replaces the former root PRODUCT.md, DESIGN.md and UX-CONTRACT.md; maintain this single source instead of recreating those root files.
- The Chinese guide is docs/user-guide.zh-CN.md, the packaged English guide remains docs/portable-guide.en.md, and detailed implementation notes are in docs/developer-guide.md. See docs/README.md for the index.

## Frontend consistency for every new feature

- Before adding or changing UI, read docs/design.md and inspect the nearest existing workflow. Preserve the restrained navy engineering identity, existing layout and bilingual behavior.
- Reuse src/theme.ts (palette/interfaceTheme/buttonTheme), the single App ConfigProvider, src/Refined.css and existing Ant Design/business components. Extend the shared owner when a pattern recurs; do not create page-local copies of shared controls or independent color/motion systems.
- Keep established control sizes, page/section spacing, action emphasis, table behavior and accessible focus states. New overlays use the existing library motion; authored feedback must respect reduced motion and avoid layout animation or new runtime dependencies.
- Reserve space for both translations in shared controls and responsive navigation. Language changes must not reflow the working area; overlays must not resize or shift the underlying page. Preserve the root scrollbar reservation and check geometry across locales and overlay open/close states.
- Verify new screens alongside a sibling screen, including populated/empty/error/disabled states, English/Chinese, narrow layouts and keyboard interaction. Update docs/design.md and shared runtime tokens together when an intentional system-wide rule changes.

## English publication policy (required by the user on 2026-11-04)

- Write all new commit subjects and bodies, PR titles and descriptions, Release titles and descriptions, asset names, and packaged instructions in English. This includes validation, compatibility and upgrade notes. Chat replies and the application's existing localization are outside this policy.
- Use `type(scope): concise English description` for PR titles and commit subjects. Do not put development versions in PR titles. Use `Vehicle Manager vX.Y.Z` for official Release titles; explicitly label historical previews and deprecated releases.
- Before committing, opening a PR or publishing a release, review the titles, descriptions, validation notes and packaged instructions for English wording and consistency.
- Package `docs/portable-guide.en.md` as `User-Guide.md`, alongside the existing English README.txt. Do not add Chinese-only instructions or Chinese filenames to future delivery packages. Preserve the application's existing bilingual UI.
- Translate editable Release metadata when correcting language. Preserve historical Git commits, tags and immutable published ZIPs. Do not overwrite an existing ZIP to change its documentation; apply packaging changes to the next release after advancing its version.

## 发布版本一致性（用户于 2026-11-04 明确要求）

- `package.json.version` 是应用版本的唯一来源；生成的前后端版本、发布包内版本、Git 标签 `vX.Y.Z`、Release 标题和 ZIP 文件名中的版本必须一致。禁止通过打包参数或环境变量单独改写某一处版本。
- 正式版本使用三段数字；小功能和修复升 patch、较大的功能更新升 minor、不兼容变更升 major。数据库结构版本、共享协议版本、备份格式版本独立管理，不要求与应用版本数字一致。
- 发布前先读取 GitHub 最新正式 Release、远程标签和对应源码，区分本地版本、开发版本和正式版本。不得仅根据本地源码判断“最新版”；不得从陈旧分支发布。
- 正式发布必须对应可追溯的干净源码提交。测试、lint、build、最终解压包验收和版本一致性检查通过后才可发布；记录提交 SHA、包 SHA-256 和验收结果。
- 一个正式版本只对应一个最终应用 ZIP。正式发布后不得用不同内容覆盖同版本包或移动标签；修复或重新交付不同内容必须提升版本。未发布的临时构建不能作为正式版本交付。
- 开发或预发布版本必须明确标注，不能设为 Latest。正式版本须高于最新正式版，并满足目标团队已经生效的最低客户端版本要求；不确定团队门槛时说明验证范围，不得猜测。
- 交付时明确说明：线上最新正式版、本地源码版本、本次产物版本、来源提交、验证范围。若三者不同，明确解释。
- 历史发布的问题通过说明和弃用标记澄清，保留原标签及包的可追溯性；删除历史发布、替换已发布包或其他不可逆调整须另行取得用户授权。

发布操作以 `docs/releases.md` 为准，设计背景见 `docs/release-consistency-proposal.md`。使用 `npm run check:version` 检查源码一致性，使用 `npm run package:portable` 执行完整验收和远程发布预检。发布前后必须核对标签、标题、唯一 ZIP 和 SHA-256，禁止绕过失败的检查。
