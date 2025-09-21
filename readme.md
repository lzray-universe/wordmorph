

# Word Morph

一个“单词变形（Word Morph）”小站：
给定起点词与终点词，玩家每步只能做**允许的微操作**，并且每一步都必须仍是词表中的真实单词，目标是在限定步数内到达终点。

*  暗/亮主题切换（本地记忆）
*  固定词表（`public/wordlist.txt`）
*  两种规则模式

  * **经典**：只允许“改 1 个字母”（不换位、不重排）
  * **变种**：允许“改 1 个字母 / 插入 1 个字母 / 删除 1 个字母”
*  随机选词、一键重置、**一步提示** / **最短路答案**
*  词义/词源查询：优先 Cloudflare Worker，字典/翻译多级回退
*  可控的长度过滤与步数上限（默认：同长=3×长度；异长=3×较长长度）

---

## 目录结构

```
wordmorph-main/
📄 .gitattributes
📁 .github
  📁 workflows
    📄 pages.yml
📄 .gitignore
📄 index.html
📄 package-lock.json
📄 package.json
📁 public
  📄 wordlist.txt
📁 src
  📄 App.tsx
  📄 main.tsx
📄 style.css
📄 tsconfig.json
📄 vite.config.ts
```

---

## 在线体验 & 截图


---

## 快速开始

```bash
# Node 18+ 推荐
npm i
npm run dev   # 本地开发（Vite）
npm run build # 产物在 dist/
npm run preview
```

* **部署到 GitHub Pages**：仓库已带 `Deploy Vite to GitHub Pages` 的 CI（`.github/workflows/pages.yml`）。
  `vite.config.ts` 中：

  ```ts
  export default defineConfig({
    plugins: [react()],
    base: process.env.GITHUB_PAGES ? '/wordmorph/' : '/',
  })
  ```

  如果仓库名不是 `wordmorph`，请把 `base` 改为 `/<你的仓库名>/`，或在 CI 中设置 `GITHUB_PAGES=1` 并同步调整。

---

## 使用说明

1. 选择**模式**（经典/变种）。
2. 在面板 **① 词表信息** 里点击长度“圆片”可**允许/禁用**某些长度（默认只开 3/4/5）。
3. 在 **② 模式与选词** 填入起点/终点（可用“随机一对”），点击**开始**。
4. 游戏面板显示：当前词、已用步数、上限与剩余。
5. 输入下一个词或点“提示”“应用提示”“看答案”。
6. 点击你路径里的任意词可弹出**释义/词源卡片**。

**词表**：当前 `public/wordlist.txt` 约 37 万词（1–31 字母），默认玩法只启用 3–14 字母（约 35 万）。

---

## 外部查询（释义/词源）

`src/App.tsx` 顶部常量：

* `WORKER_BASE = https://wordworker.../define?word=`：Cloudflare Worker（返回 `{ meaning, etymology }`）。
* 若无释义，回退到 **DictionaryAPI**：`https://api.dictionaryapi.dev/...`

  * 若只拿到英文释义，会通过 **Google Translate（免费接口）** 翻到中文：
    `TRANSLATE_PROXY_BASE = https://cors-header-proxy.../corsproxy?apiurl=...`
* 还配置了 `GLOSBE_WORKER_BASE` 作为另一层兜底。


---

# 算法设计

> 关键目标：**在大词表上高效求最短路径**，同时支持两种规则模式，并在 UI 里即时提供“提示/答案”。

## 1. 图模型与邻接定义

把每个词看作一个结点。两词间存在边，当且仅当它们相差一次**允许的微操作**。

* **经典模式（同长）**：只允许“替换 1 个字母”。
  例如 `cold → cord` 合法；`trod → toad` **不合法**。
* **变种模式（可异长）**：允许

  * 替换 1 个字母（同长）
  * 插入 1 个字母（长度 +1）
  * 删除 1 个字母（长度 −1）
    三者中任选其一，且结果必须在词表中。

因此，**边无权**，最短路径可用 BFS求解。

---

## 2. 邻居枚举的索引化

大词表下，逐词暴力试变更会非常慢。项目使用**按长度分桶**+**模式索引**：

### 2.1 按长度分桶（`dictByLen: Map<number, Set<string>>`）

* 预处理将词表分到不同长度的 `Set` 中，方便 O(1) 判断存在性、且只在可能长度中枚举邻居。

### 2.2 替换邻居（经典&变种都用）

* 对每个长度 L 的词，构建**通配模式索引** `patternIndexByLen[L]: Map<pattern, string[]>`。
* 一个词 `w` 的所有替换邻居 = 对每个位置 i，生成 `w[:i] + '*' + w[i+1:]`，再把该模式下的所有词合并（去掉自身）。
* 构建成本：对每个词生成 L 个键，整体 **O(∑L)**；查询邻居近似 **O(L + 候选数)**。

> 该索引是**懒构建**的：只有当某个长度第一次需要时才 `buildPatternIndex`。

### 2.3 插入邻居（仅变种）

* 对词 `w`（长 L），在 L+1 桶中检查：把 26 个字母分别插到每个位置，看是否在 `dictByLen[L+1]`。
* 复杂度：最坏 **O(26×(L+1))** 次哈希查询，实际由 `Set` 加速。

### 2.4 删除邻居（仅变种）

* 对词 `w`，删除每个位置的字母，若在 `dictByLen[L-1]` 就是邻居。
* 复杂度：**O(L)** 次哈希查询。

---

## 3. 搜索：**BFS** + 有界剪枝

函数 `BFS(start, target, neighborFn, cap, maxStates=200000)`：

1. **边界**：`start === target` 直接返回 `[start]`。
2. **双向扩展**：

   * `left` 从 `start` 出发，`right` 从 `target` 出发；每轮扩展**更小的一边**，降低分支总数。
   * 分别用 `leftPrev/rightPrev` 记录前驱，用 `leftDepth/rightDepth` 记录层数。
3. **步数上限（cap）**：显示“上限/剩余”。

   * 默认 `cap = 3×len(start)`（同长）或 `3×max(len(start), len(target))`（异长）。
   * 任何结点若满足 `g + h > cap` 会被**直接剪枝**（见下）。
4. **启发式下界 `hLowerBound(a,b)`**：

   * 同长：**Hamming 距离**（不同位的计数），因为每步只能改 1 个字母 ⇒ 至少要改这么多步。
   * 异长（变种）：至少要做 `|len(a)−len(b)|` 次插/删 ⇒ 这是合法的**编辑距离下界**。

   > 这是\*\*可采纳（admissible）\*\*的下界，仅用于“**是否超 cap**”的剪枝，不改变 BFS 的最短路保证。
5. **会合与回溯**：当某边首次访问到对侧已访问的结点 `meet` 时，

   * 从 `meet` 向左用 `leftPrev` 回溯得到 `start → meet`
   * 从 `meet` 向右用 `rightPrev` 回溯得到 `meet → target`
   * 拼接为完整路径并返回。
6. **安全阈值 `maxStates`**：总展开结点数超过该值抛出 `SearchExceeded`（会提示“搜索空间过大”）。

**正确性**：

* 我们没有以启发式决定扩展顺序（不像 A\*），仅用于 `g + h > cap` 的**界限剪枝**，因此**不改变最短性**；当 `cap` 小于真实最短步数时，搜索可能返回“未找到”，这是预期行为。

**复杂度（量级分析）**：

* 实际运行受三个因素主导：

  1. **长度过滤**（只开 3/4/5 会极大减小图规模）；
  2. **模式**（变种模式因插/删而显著增边）；
  3. **`cap` 与 `maxStates`**（界限越松，搜索越慢）。

---

## 4. UI 交互与“提示/答案”

* **提示**：从“当前词”到目标词，在**剩余步数** `cap - 已用` 的界限下跑一遍 BFS，若找到了最短路，返回下一步 `sp[1]` 并显示“提示 → cur → next”。
* **看答案**：对 **start/target** 在 `cap` 内做一次完整 BFS，若存在则把整条最短路展示出来。
* **输入校验**：每步提交会验证：

  * 词是否合法（仅小写英文字母）；
  * 长度是否在允许集合；
  * 是否属于**当前词**的邻居（按模式规则 + 在词表内）；
  * 未超 `cap`。

---

## 5. 关键常量与可调参数

* `MIN_LEN = 3` / `MAX_LEN = 14`：可玩长度范围。
* 初始允许长度：`new Set([3,4,5])`。
* `maxStates`：`BFS` 的第 5 个参数（默认 200000），防止卡死。
* `computeMoveCap(a,b)`：默认步数上限策略。
* 外部服务端点（WORKER/TRANSLATE/GLOSBE 等）：若你部署到自己的域名，请改为你自己的 Worker。

---

## 6. 性能与实践建议

* 若“搜索空间过大”：

  * **收紧允许长度**（尤其是变种模式）；
  * **把起点/终点挑近一些**（同长同词根通常更容易）；
  * **调大 `cap` 前先看提示**，避免无意义扩展；
  * 必要时增大 `maxStates`（风险自理）。

---

## 7. 词义/词源查询的回退

1. `WORKER_BASE /define?word=`（优先）
2. `DictionaryAPI`（若 1 无中文释义，则取英文释义）
3. `Google Translate`（把英文释义机翻为中文）
4. `GLOSBE_WORKER_BASE`（作为另一层兜底）

> 这些接口均为**非强依赖**：如果被拦截或速率限制，游戏主体依然可用。

---

## 8. 可定制点

* **换词表**：替换 `public/wordlist.txt`，一行一个词（仅 a–z）。
* **调主题**：`style.css` 里有完整的暗/亮配色与玻璃态背景。
* **改模式文案或规则摘要**：在 `App.tsx` 对应区域即可调整。

---



* 仅支持 **ASCII 小写字母**，不含连字符、撇号、变音符等。
* 经典模式不允许**换位**/**重排**（这不是“改 1 个字母”）。
* 词表决定可达性：某些看似“合理”的过渡词不在词表里，最短路可能因此更长或不存在。
* 外部词典/翻译接口可能受 CORS、频率或地域因素影响。
