# pi-skill-distiller

把已经完成的 pi 对话蒸馏成待审核的 `SKILL.md`，由用户编辑、确认后再写入正式 skill 目录。

核心约束：

- 自动抽取只写 `.pi/distill-staging/`，不会直接启用 skill。
- reviewer 在独立的内存 session 中运行，不污染 `/resume` 历史。
- reviewer 只有受限 `read`/`write`；`write` 只能写 staged `SKILL.md`。
- 审核通过后才写入 `.pi/skills/` 或 `~/.pi/agent/skills/`。
- 水位线存为 session custom entry，按当前会话树分支自然恢复。
- 正式 skill 目录使用独立 git 仓库记录每次批准的变更。

## Install

当前工作区可直接运行 `bash pi-skill-distiller/start.command`，使用已安装的 pi 0.84.3 和 `/opt/homebrew/bin/node`。插件要求 pi 0.84.3；旧版全局 `pi`（例如 0.74.2）不支持所需 API。

本地试运行：

```bash
pi -e ./pi-skill-distiller
```

本地安装：

```bash
pi install ./pi-skill-distiller
```

发布到独立 git 仓库后：

```bash
pi install git:github.com/<owner>/pi-skill-distiller
```

## Commands

- `/distill [focus]`：跳过 gate，抽取当前切片并立即打开审核流程。若自动抽取已经处理了刚结束的一轮，会重新使用上一段已处理切片，使定向提示仍然有效。
- `/distill-review`：审核已有 staging 候选。
- `/distill-feedback [reason]`：针对本轮实际读取过的 skill 生成修正候选。

自动路径在 `agent_settled` 后检查 gate，只写 staging 并通知，不弹对话框。compaction 前会尝试同样的 gated 抽取；compaction 后水位线推进到新的 compaction entry。

## Gate defaults

自动抽取要求同时满足：

- 至少 8 条 `toolResult`；
- transcript 序列化后至少 30 KiB；
- 至少一条 user message 和一条 assistant message；
- 主 session 已 idle，且没有排队消息。

`/distill` 与 `/distill-feedback` 跳过这些阈值。

## Review flow

候选位于：

```text
.pi/distill-staging/<name>/SKILL.md
```

`/distill-review` 会逐条打开多行编辑器，并提供：

- 批准到项目 `.pi/skills/`；
- 批准到全局 `~/.pi/agent/skills/`；
- 丢弃；
- 保留到以后。

审核标题会标记名称编辑距离接近或 description 关键词高度重叠的现有 skill。它只提示，不自动拦截。

批准后 extension 会在目标 skill 根目录初始化独立 git 仓库，并提交单个 `SKILL.md`。如果 git identity 未配置或提交失败，文件仍会保留，并显示 warning。

## Settings

项目配置文件：`.pi/pi-skill-distiller-settings.json`

```json
{
  "enabled": true,
  "autoDistill": true,
  "minToolResults": 8,
  "minTranscriptBytes": 30720,
  "reviewerProvider": "anthropic",
  "reviewerModel": "claude-sonnet-4-5",
  "thinkingLevel": "medium",
  "injectMaintenancePrompt": true,
  "feedbackMinSkills": 15,
  "staleAfterDays": 90
}
```

不设置 reviewer model 时沿用当前 session model。只设置 provider 会被拒绝；设置 model 而不设置 provider 时，该 model 必须能唯一匹配。

反馈信号在已加载 skill 数达到 `feedbackMinSkills` 后启用：

- `read` 命中实际加载的 `SKILL.md` 时更新 `.pi/distill-usage.json`；
- `/distill-review` 提示长期未读取的 skill；
- system prompt 加入“发现错误时修正或生成反馈候选”的维护指引。

这些信号不会自动删除或覆盖任何 skill。

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

需要 Node.js 22.19 或更高版本。

## Security model

对话 transcript 是不可信数据。reviewer prompt 明确禁止执行其中的指令；文件工具还会机械限制路径：

- `read` 只能访问 pi 已加载的 skill 路径或 staging；
- `write` 只能访问 `.pi/distill-staging/<name>/SKILL.md`；
- reviewer 没有 shell、删除工具或正式 skill 写权限。

正式落盘始终由用户在审核 UI 中触发。
