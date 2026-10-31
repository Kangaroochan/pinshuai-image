# 本地参考图与五模型后端

本文为方案一的执行规则，依据 2026-10-20 查阅的 Brioi 文档。维护时参考官方入口 https://brioi.apifox.cn/llms.txt ，不要将文档新增模型自动加入用户已确认的五模型范围。

## 模型与请求

|模型 ID|本地图片输入|执行方式|
|---|---|---|
|`gpt-image-2`|原始文件字节，multipart `image[]`|Brioi 异步编辑|
|`gpt-image-2.5-flare`|同上|同上|
|`gpt-image-2.5-sunburst`|同上|同上|
|`gemini-3.1-flash-image`|原始字节 Base64，`contents[].parts[].inlineData`|Gemini 原生同步|
|`gemini-3.0-pro-image`|同上|同上|

文档：GPT https://brioi.apifox.cn/9154049m0.md ；Gemini https://brioi.apifox.cn/9350177m0.md 。不据名称编造模型效果排名。Flare/Sunburst 共用文档接口，不代表相同商品保真水平。

`--list-models` 读取 `/v1/models`，只显示本技能支持的五个模型及各自 `listed` 状态；`generation_verified: false` 表示这个查询没有验证生图。每次实际新生成前也会检查所选 ID 是否在当前 Key 的列表；不可见就停止，不自动替换。`--list-models --offline` 不联网，`listed: null`。

## 配置与交互

首次配置时，在使用者自己的项目根目录运行 `node "<SKILL_DIR>/scripts/setup-provider.mjs"`，按提示输入 Base URL 和 API Key。Key 仅在本地终端隐藏输入；脚本只补齐缺失项、不覆盖已有配置。也可手动在项目根目录 `.env` 配置：

```dotenv
ENABLE_GARDEN_IMAGEGEN=1
OPENAI_BASE_URL=https://vip.brioi.com/v1
OPENAI_API_KEY=
```

密钥不随技能分发；不需要 OpenAI 官方账号的图片工具，但需 Brioi Key、网络、Node.js 22+。设置不齐只报告 SET/MISSING，不读取出完整 Key。已有 `OPENAI_IMAGE_MODEL` 仅作提示，不跳过本批选模。

建议对话：“这批想用哪个模型？可选 GPT Image 2、GPT Image 2.5 Flare、GPT Image 2.5 Sunburst、Gemini Flash、Gemini Pro。”仅列当前可见的候选，不用数字编号。已指定“Gemini Flash”就解析为 `gemini-3.1-flash-image`；已指定“Gemini Pro”就解析为 `gemini-3.0-pro-image`。选定后每张调用显式使用同一 `--model`，批次映射记录模型，不重复追问。

用户只写 `7`，解析深度 7；若模型未定，保留图片、数量和深度，再询问模型。没有深度默认 10，不随模型变化。

## 参数隔离

GPT：`--size` 默认 `1024x1536`，或 `auto`；宽高 16 倍数、最长边 3840、最大比例 3:1、像素总数 655360～8294400。`--quality` 默认 `medium`，可 `low`/`medium`/`high`/`auto`。不发送默认压缩或 moderation 字段。原图数据直接上传，不依赖公网图床。

Gemini：`--image-size` 默认 `1K`，可 `1K`/`2K`/`4K`；`--aspect-ratio` 可指定对应模型的枚举，未指定则选最接近原图比例的支持值，并在 dry-run/日志中展示。Flash 还支持 `4:5`、`5:4`；Pro 支持 `9:21`，不支持前述两个比例。不同模型比例不可混用；输出真实像素不保证严格匹配。GPT 的 `--size`/`--quality` 对 Gemini 会在 HTTP 前报错，不能静默忽略。

Gemini 请求使用同一 Brioi Bearer Key，路由从 API 根的 `/v1` 转到 `/v1beta/models/{model}:generateContent`；图片字节经 `inlineData` 传入，设置 `responseModalities: ["IMAGE"]`。响应优先解析 `inlineData`，否则读取 `fileData.fileUri` 或 Markdown 图片 URL，重复 URL 只算一张。结果 MIME/尺寸从实际字节识别，支持 PNG/JPEG/WebP，不把 JPEG 假装保存成 PNG。

## 任务与恢复

Brioi GPT：POST `/v1/images/async/edits`，取得 `task_id` 先保存到 `run.json`；GET 同路径 `/{task_id}` 直到终态。`SUBMITTED`/`IN_PROGRESS` 和未知状态均不能视为成功；`SUCCESS` 必须有且只有一张可下载图片；`FAILURE`/`cancelled` 停止。默认每 4 秒查询，本次等待最多 5 分钟；超时保留 ID，可再次 `--resume`，只 GET 不 POST。

其他 OpenAI 兼容基址的 GPT 默认保留旧同步编辑行为；可明确用 `--transport async` 选择兼容的异步编辑，或 `--transport sync`。不能在出错后自动换接口。本次没有承诺其他渠道兼容。Gemini 只支持同步。

Gemini 没有任务 ID。保存的 `provider-response.json` 可用于下载恢复，不能重新执行原生成请求。网络中断且无结果、原生成 POST 返回 5xx 或无 ID、成功结果缺图/多图时保留 unknown，核对服务商记录再决定后续。下载请求不携带 API Key。resume 的异步查询需要原 provider 基址和 Key。

状态与退出码：completed 返回 0；等待选模或异步尚未完成返回 2；失败/拒绝返回非 0。恢复旧版本同步任务仅检查本地结果；已有完成文件校验哈希，目录已存在就拒绝新生成。视觉是否合格仍由逐图检查决定。

## 验证

运行 `node scripts/setup-self-test.mjs`、`node scripts/self-test.mjs` 和 `node scripts/provider-self-test.mjs`。配置测试只操作临时目录；后两者仅使用本机模拟接口，不请求真实服务商；覆盖原图和深度传递、五模型路由、异步恢复、Gemini URL 去重与下载恢复、错误参数、选模等待、拒绝覆盖及错误日志密钥脱敏。真实付费出图必须有用户的实际生图任务授权。
