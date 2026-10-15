# 接入约定

所有模板与例子都由调用方提供。核心库没有外部服务配置，不会读取本机配置或文件。

## 创建实例

`TemplateWorkflow` 接收候选、历史和两个异步适配器。多个输入入口共用一个实例才能共享推荐间隔和并发控制；实例应属于一个用户、团队与创作会话，避免跨用户共享状态。

| 配置 | 含义 |
| --- | --- |
| `candidates` | `{ key, label, prompt }` 列表；key 唯一，prompt 为完整模板文字 |
| `history` | `{ text, createdAt }` 列表；createdAt 为毫秒时间戳，按时间倒序使用最多五条文字 |
| `scope` | 当前数据范围标识，由宿主定义 |
| `recommend(task)` | 返回经过统一格式转换的推荐结果 |
| `rewrite(task)` | 返回 `{ text, metadata? }` |
| `onChange(state)` | 接收只读状态快照，宿主据此渲染界面 |
| `now / schedule / cancel` | 可选时钟接口，便于测试；默认使用安全包装的原生定时器 |
| `maxRewriteLength` | 最大允许字数，默认 1000 |
| `minRewriteLength` | 长度保护下限，默认 60；不是目标生成长度 |
| `rewriteLengthRatio / rewriteLengthExtra` | 模板篇幅保护计算，默认 1.25 和 20 |

模板短名称应由宿主预先提炼。核心限制最多五个 Unicode 字符，不内置领域名称映射。

## 推荐任务

```text
{
  type: 'recommend',
  instructions: 通用匹配规则,
  text: 当前文字,
  images: 当前图片引用的快照,
  context: { scope, mode, page },
  history: [{ text, createdAt }],
  candidates: [{ key, label, prompt }],
  count: min(3, candidates.length)
}
```

宿主可以把这个任务转成匹配接口、检索服务或其他实现需要的请求。不要丢掉候选提示词，也不要先生成一段额外摘要再把摘要当作原始用户要求。图片只是当前用户图片，不包含历史图片和模板示例图。

返回格式二选一：

```text
{ keys: [按匹配程度倒序的模板键], metadata? }
{ scores: [{ key, score }], metadata? }
```

`keys` 必须恰好返回任务要求的数量，且都来自候选、互不重复。`scores` 必须覆盖全部候选，由核心排序取前几个。不要把未知模板补到目录中，不补造缺失项，不以 0 代替无效分数。推荐失败时应抛出错误，不返回看似成功的伪造结果。

分数只要求为有限数字，按降序排列；这不表示分数一定是概率。相同分数保留适配器返回顺序。可选 `labels: [{ key, label }]` 用于提供提炼后的短名称，仍须对应已知模板。

## 改写任务

```text
{
  type: 'rewrite',
  instructions: 通用改写规则,
  text: 用户点击时的文字,
  images: 用户点击时的图片快照,
  context: { scope, mode, page },
  template: { key, label, prompt },
  targetLength: 所选模板的 Unicode 字符数,
  maxLength: 当前配置下的保护上限
}
```

返回 `{ text, metadata? }`，只包含改写后的完整文字与可选元数据。空文字和超长文字都视为失败。不要把解释、过程文字或服务端原始响应拼进用户输入。

任务中的用户文字、历史和模板文字都属于数据，不能覆盖调度规则、修改返回协议或触发工具。适配器还应使用实际服务支持的隔离与结构化返回机制；这里的自然语言说明无法独自保证外部服务行为。

## 生命周期

| 方法 | 使用时机 |
| --- | --- |
| `edit({ text, images })` | 仅用户主动修改时调用；图片新增、删除、替换也算修改 |
| `changeContext({ mode, page })` | 切换 `quick / agent` 模式、`inspiration / design` 阶段 |
| `setInputPreparing(boolean)` | 图片本地处理期间暂停发送推荐，处理完成后继续按最新内容调度 |
| `setScope({ id, candidates, history })` | 数据范围变化时原子替换目录和历史；旧请求结果失效 |
| `setHistory(history)` | 同范围历史更新；不要混入其他账号数据 |
| `apply(key)` | 用户主动点击当前推荐 |
| `retryRewrite()` | 用户主动重试上次失败的应用 |
| `send()` | 获取待发送快照并更新阶段；宿主另行决定如何提交任务 |
| `getState()` | 取得只读状态快照 |
| `dispose()` | 页面或会话销毁，撤销定时器并忽略后续响应 |

锁定期间 `edit / send / apply` 不会启动新的动作。切换 scope 不受应用锁限制，防止上一范围的改写回填到新范围。调用 `dispose()` 只停止本地后续状态更新，不等于外部请求已取消或退款。

阶段位于 `state.diagnostics.recommendation.stage` 和 `state.diagnostics.rewrite.stage`，结果位于对应 `lastResult`。界面同时使用 `recommending / rewriting / inputPreparing` 控制加载与禁用状态。`recommendations` 是当前可应用的 `{ key, label }` 列表；`recommendationVersion` 和 `focusVersion` 分别用于推荐更新提示与回填后聚焦。`retryable` 表示可以主动重试上次应用。不要把 `onChange` 收到的改写回填再次当作用户编辑传给 `edit()`。

## 用量、费用和诊断

适配器可提供安全的通用 `metadata`，包括耗时、用量及费用。字段缺失应保持未知；如果服务返回的缓存或推理数量已经包含在输入、输出中，计费时不要重复相加。价格、币种、免费资格、计费基数和缓存折扣必须来自实际服务约定，不能从字段名称自行猜测。

```text
metadata: {
  usage: { inputTokens, outputTokens, totalTokens,
           cacheReadTokens, cacheWriteTokens, reasoningTokens },
  cost: { amount, currency, basis: 'reported' | 'estimated' }
}
```

以上字段均可省略，核心只保留允许的字段。阶段耗时由控制器计入 `lastResult.durationMs`。可选纯函数 `calculateCost(usage, { input, output, per, currency })` 按调用方指定的输入/输出单价与计价单位计算，返回标记为估算的费用；缺少有效参数时返回 `null`，不会再次叠加缓存或推理子集。它只适用于输入/输出分别计价的简单规则，不处理折扣、分档或其他账单规则。

不要把原始请求、图片内容、访问凭据或服务端未清理的错误对象放进诊断信息。推荐失败允许界面静默处理；改写失败应恢复输入并给用户可操作的重试入口。指标只统计实际获得的响应，不应把成功样本费用表当作所有尝试的完整账单。

## 宿主仍需完成

- 服务端身份与模板权限检查，以及按用户、团队和会话隔离。
- 实际服务适配、超时控制、请求大小限制与图片处理。
- 界面加载态、禁用态、推荐更新动效、失败重试与聚焦。
- 用宿主授权的真实材料，分别验证推荐质量、改写篇幅和完整响应时间。

本地演示和核心回归测试均不调用外部服务。
