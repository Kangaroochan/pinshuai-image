# Pinshuai Image

根据商品参考图生成同款商品的新场景、新构图。支持 1～10 重构深度，默认 5；保留商品款式、可见数量、比例、包装、配件和指定广告文案。

## 安装

将本仓库的技能文件放到业务项目的 `.agents/skills/pinshuai-image/`，或已有的 Codex 技能目录中。保留整个 `scripts`、`references`、`agents` 目录。

在业务项目根目录可直接安装：

```powershell
git clone https://github.com/Kangaroochan/pinshuai-image.git ".agents/skills/pinshuai-image"
```

如果目标已有同名技能，先保留并比较差异，不直接覆盖。

第三方 API 后端需要 Node.js 22+，无需安装 npm 依赖。有宿主生图工具时也可使用宿主模式。

## 首次使用

在对话中调用 `$pinshuai-image` 并提供参考图。如果没有宿主生图工具，技能会先询问是否使用第三方服务、检查配置，并协助处理缺项。Node.js 缺失时会先说明并询问是否协助安装。

第三方服务会接收你授权上传的参考图与提示词。缺少配置时，在**业务项目根目录**运行一次：

```powershell
node "<SKILL_DIR>/scripts/setup-provider.mjs"
```

`<SKILL_DIR>` 替换为已安装技能的绝对路径。按提示填写 Base URL 和 API Key；Base URL 默认 `https://vip.brioi.com/v1`，可改为兼容的 HTTPS 服务。API Key 在本机终端隐藏输入，不需要发送到聊天中。

脚本只补齐缺失/空白配置，并添加 `.env` 的 Git 忽略规则；已有值不覆盖，继承自环境变量的 Key 不会复制进文件。现有 API 开关明确关闭时会停止并说明，不擅自更改。不要在技能目录中保存 Key。也可参考 `.env.example` 手动配置。

查看配置状态（不联网、不显示 Key）：

```powershell
node "<SKILL_DIR>/scripts/setup-provider.mjs" --status
```

配置齐全后，技能按名称询问本批使用哪个模型：GPT Image 2、GPT Image 2.5 Flare、GPT Image 2.5 Sunburst、Gemini Flash 或 Gemini Pro。当前服务必须支持所选模型和对应接口；列出模型不等于已经验证能生图。失败不会自动换模型或重复提交付费任务。

## 输出位置

只生成一组时，该组全部结果图片共用一个文件夹，不按每张图单独建目录。默认在第一张参考图旁为整组新建 `MMDD-HHmm` 文件夹（例如 `1028-1720`）；同一组的所有独立调用传入相同的 `--result-dir`，并使用 `--result-name 01`、`02` 等按序命名。不同组使用不同目录，整组目录同分钟重名时追加 `-01`、`-02`，文件重名也不会覆盖。提示词、原图副本、响应和日志仍保存在各自默认任务目录；`--output-dir` 只改变任务文件目录，`--resume` 沿用记录的结果路径。

## 对话示例

- 参考图 + `7`：深度 7，每张参考图默认生成 1 张。
- “每张参考图生成 2 张”：默认深度 5，每图 2 张。
- “用 Gemini Flash，深度 8，每图 1 张”：使用指定模型与深度。

默认保留原图人物的情绪基调；深度控制同一基调内的表情变化幅度。重构深度不是相似度分数，也不承诺任何平台查重结果。

## 验证

```powershell
node "<SKILL_DIR>/scripts/setup-self-test.mjs"
node "<SKILL_DIR>/scripts/self-test.mjs"
node "<SKILL_DIR>/scripts/provider-self-test.mjs"
```

测试仅操作临时文件或本机模拟接口，不会调用真实服务商。生成成功、文件完整和视觉验收分别记录，不能互相替代。

## 案例复盘

运行失败会把脱敏后的状态、模型、深度和内容哈希追加到技能本地 `.local/failure-cases.md`；状态不确定的请求会标记为未确认。视觉案例需先完成验收，再保存包含 `visual_review: reviewed`、`checks`、`issues` 的 `visual-review.json` 并登记：

```powershell
node "<SKILL_DIR>/scripts/casebook.mjs" record-review "<RUN_DIR>" "<RUN_DIR>/visual-review.json"
node "<SKILL_DIR>/scripts/casebook.mjs" lessons --category product_identity
```

同类案例只形成待复核候选，不自动改写通用规则或训练图像模型。案例簿属于本机学习数据，由 `.gitignore` 排除，不应上传到公开仓库。

## 隐私与许可证

仓库只分发空白配置模板。不要提交 `.env`、`.gateway.env`、API Key、私人参考图或生成结果。Git 忽略规则不会移除已经被提交的密钥；若曾误提交，请在服务商处撤销并更换 Key。

保留 MIT 许可证。部分脚本改编自 [ConardLi/garden-skills](https://github.com/ConardLi/garden-skills)，来源及改动记录见 [UPSTREAM.json](UPSTREAM.json)。
