# 前端 UI 设计与架构约束 (`Tailwind CSS + shadcn-vue + macOS/iOS 毛玻璃风格`)

本文档用于约束 `mihomo-speedtest` Web 前端（`web/`）的技术架构、组件规范与 macOS/iOS 毛玻璃（Frosted Glass / Vibrancy）视觉标准。后续所有前端重构与新增页面均须严格遵循本约束。

---

## 1. 技术栈与目录架构约束

- **核心框架**：Vue 3（`<script setup>` Composition API）+ Vite。
- **样式引擎**：**Tailwind CSS**（禁止在 `.vue` 文件中手写大段原生 CSS；自定义毛玻璃工具类或 CSS 变量统一收口在 `web/src/assets/index.css`）。
- **组件体系**：**shadcn-vue**（基于 `reka-ui` + `class-variance-authority` + `clsx` + `tailwind-merge`）。
  - 基础 UI 组件必须统一放置在 `web/src/components/ui/`（如 `Button`、`Card`、`Input`、`Select`、`Table`、`Badge`、`Dialog`、`Tooltip`、`Progress`、`Collapsible`）。
  - 业务组件禁止直接手写简陋原生 `<select>`、原生 `title` 气泡或自造无焦点的弹窗遮罩，必须使用 `shadcn-vue` 对应组件。
- **图标规范**：统一使用 **`@iconify/vue`** 的 `<Icon icon="..." />` 组件（推荐 `lucide:*` 或 `mdi:*` 图标集），禁止使用 UnoCSS 工具类或内联大段 SVG。

```text
web/src/
├── assets/
│   └── index.css              # Tailwind 指令、CSS 变量与毛玻璃工具类
├── lib/
│   └── utils.ts               # cn() 类名合并工具函数
├── components/
│   ├── ui/                    # shadcn-vue 标准基础组件
│   └── ...                    # 业务拆分组件（订阅卡片、排行榜、历史对比弹窗等）
└── App.vue
```

---

## 2. macOS / iOS 毛玻璃（Vibrancy）视觉规范

### 2.1 背景环境层（Ambient Canvas）
毛玻璃质感依赖底层透出的色彩层次，禁止使用单一纯黑/纯白死板背景：
- 画布底色：深邃夜空底色（如 `#090d16`）叠加 2~3 处低饱和度径向环境光晕（如顶部左上蓝紫光晕 `rgba(10, 132, 255, 0.16)`、右上青绿光晕 `rgba(48, 209, 88, 0.10)`），营造 macOS Sonoma / Sequoia 壁纸透光氛围。

### 2.2 毛玻璃材质分级（Glass Tiers）
所有容器按层级使用统一的磨砂透明度、模糊度与边缘高光：

| 层级 | 使用场景 | Tailwind 材质约束 |
| :--- | :--- | :--- |
| **一级主玻璃** | 主功能卡片（订阅配置、排行榜、统计卡） | `bg-slate-900/55 backdrop-blur-2xl backdrop-saturate-150 border border-white/15 ring-1 ring-inset ring-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.36)]` |
| **二级内嵌玻璃** | 控件输入框、高级参数面板、日志框 | `bg-white/[0.06] backdrop-blur-xl border border-white/10` |
| **悬浮高透玻璃** | `Dialog` 弹窗、`Select` 下拉、`Tooltip` 气泡 | `bg-slate-900/80 backdrop-blur-3xl backdrop-saturate-150 border border-white/20 shadow-2xl` |

### 2.3 圆角与空间节奏（Apple HIG）
- **大圆角体系**：主卡片 `rounded-2xl`（16px），弹窗 `rounded-2xl`，输入框/子容器 `rounded-xl`（12px），按钮 `rounded-lg`（8px），状态徽章/药丸 `rounded-full`。
- **呼吸感留白**：主容器 `max-w-7xl mx-auto px-6 py-8`，卡片内边距 `p-5` 或 `p-6`，卡片间距 `gap-5` / `space-y-5`。

### 2.4 色彩与排版 Token
遵循 Apple 系统语义色（Dark Mode）：
- **主强调色（Accent）**：`#0A84FF`（Apple Blue，用于主按钮、激活态排序高亮、进度条起始色）
- **成功 / 畅通**：`#30D158`（Apple Green，用于延迟达标、速度增长 `+`、可用状态）
- **警告 / 提醒**：`#FF9F0A`（Apple Orange）
- **危险 / 失败**：`#FF453A`（Apple Red，用于停止按钮、下载失败、延迟超时）
- **文字层级**：主文字 `text-slate-100`、次级标签 `text-slate-400`、辅助说明 `text-slate-500`。
- **字体与数字对齐**：
  - 系统无衬线字体栈：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif`。
  - 表格中的排名、倍率、延迟、下载速率、性价比得分**必须使用 `font-mono tabular-nums`**，保证纵向小数点严格对齐。

---

## 3. 页面结构与交互约束

1. **顶部窗口栏**：左侧品牌图标（渐变毛玻璃圆角矩形）+ 标题副标题；右侧胶囊形实时状态指示器（运行中带呼吸动画）。
2. **订阅与测速控制卡**：
   - `subscribeUrl` 输入框与「保存配置」按钮并排；
   - 「高级参数」使用 `shadcn-vue` `Collapsible` 平滑展开/收起；
   - 排序维度、抽测数量与「开始/停止测速」按钮左对齐成组。
3. **三联统计卡**：测速进度（含 `Progress` 进度条）、有效可用节点数、当前最优节点（突出稳态与峰值）。
4. **节点测速排行榜**：
   - **工具栏**：左侧标题，右侧「历史记录 `Select`」与「搜索 `Input`」在桌面端必须**单行右对齐并排**，禁止被 `width: 100%` 挤压换行；
   - **表头排序**：支持点击节点名称、倍率、延迟、平均下载、稳态下载、性价比切换升降序；
   - **速度说明气泡**：平均下载、稳态下载旁使用 `shadcn-vue` `Tooltip` + `?` 图标展示计算公式与**使用场景推荐**；
   - **0 速度状态区分**：明确区分「未测（延迟超时）」与「下载失败（附中文原因）」；
   - **操作列**：保留「历史对比」按钮，点击打开 `shadcn-vue` `Dialog` 展示该节点历次测速趋势与涨跌差值。

---

## 4. 禁止事项（Anti-Patterns）

- 禁止使用不透明的纯色实心卡片覆盖背景光晕，破坏毛玻璃透光感。
- 禁止在同一视图混用多套不同圆角体系或高饱和度霓虹渐变。
- 禁止在工具栏右侧控件上使用未约束宽度的 `w-full` 导致布局错行。
- 禁止将 `style.css` 变成大杂烩原生样式表，所有样式优先通过 Tailwind 工具类与 `shadcn-vue` 变体（`cva`）表达。
