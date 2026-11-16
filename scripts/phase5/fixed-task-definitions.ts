/**
 * 阶段 5 固定真实任务集定义（≥10 例，可重跑）。
 *
 * 职责与核心逻辑：
 * - 每个任务固定：id、类别（single_dispatch / multi_dispatch / analysis）、目标、初始 fixture、
 *   prompt、确定性完成标准（checks）。fixture 内容内联在本文档里，harness 每次从同一份定义
 *   重建 workspace，保证初始状态一致、可重复对照。
 * - 完成标准全部是**确定性校验**（文件内容 / JSON 路径 / 子进程退出码 / 答复关键词 /
 *   工作区未变），不依赖 role 或 driver 自述；运行终态另行记录，二者不混为一谈。
 * - 使用普通任务提示词；不注入禁止 verify、强制 direct-finish 或工具参数要求。
 */

export type FixedTaskKind = 'single_dispatch' | 'multi_dispatch' | 'analysis';

export interface FixtureFile {
  /** workspace 相对路径（POSIX 分隔符）。 */
  path: string;
  content: string;
}

export type CompletionCheck =
  /** 在 workspace 里用当前 node 跑一个脚本，退出码 0 即通过。 */
  | { kind: 'node_script'; path: string; label?: string; timeout_ms?: number }
  /** 文件存在且包含全部字面量。 */
  | { kind: 'file_contains'; path: string; patterns: string[]; label?: string }
  /** 文件存在且不包含任何字面量。 */
  | { kind: 'file_not_contains'; path: string; patterns: string[]; label?: string }
  /** JSON 文件按点路径取值后深比较。 */
  | { kind: 'json_path_equals'; path: string; json_path: string; expected: unknown; label?: string }
  /** 文件/目录存在。 */
  | { kind: 'path_exists'; path: string; label?: string }
  /** 最终答复文本包含全部 patterns（`any` 时任一命中即可）。 */
  | { kind: 'answer_contains'; patterns: string[]; any?: boolean; label?: string }
  /** workspace 文件内容与 fixture 完全一致（与生产快照使用相同的精确状态文件/缓存排除规则）。 */
  | { kind: 'workspace_unchanged'; label?: string };

export interface FixedTask {
  id: string;
  kind: FixedTaskKind;
  /** 一句话目标（报告里直接展示）。 */
  goal: string;
  fixture: FixtureFile[];
  prompt: string;
  checks: CompletionCheck[];
  /** 该任务预期会在哪条路径上因证据缺口失败（不是跳过，失败照实登记）。 */
  expected_evidence_gap?: { paths: Array<'new' | 'legacy'>; reason: string };
  notes?: string;
}

const ANALYSIS_ONLY = '这是只读分析任务：不要修改文件，把完整分析写入最终答复。';

export const FIXED_TASKS: FixedTask[] = [
  // ── 单次派工即可完成的修改（4 例） ───────────────────────────────
  {
    id: 'm01-fix-add',
    kind: 'single_dispatch',
    goal: '修复 src/math.js 中 add 的实现错误，使 node check.mjs 通过。',
    fixture: [
      {
        path: 'src/math.js',
        content: `// 报表生成器用的小型数学工具。

export function add(a, b) {
  // BUG: 减法与常数偏移，结果不是两数之和。
  return a - b + 1;
}

export function multiply(a, b) {
  return a * b;
}
`,
      },
      {
        path: 'check.mjs',
        content: `import { add, multiply } from './src/math.js';

const problems = [];
if (add(2, 3) !== 5) problems.push('add(2,3)=' + add(2, 3));
if (add(-1, 1) !== 0) problems.push('add(-1,1)=' + add(-1, 1));
if (multiply(3, 4) !== 12) problems.push('multiply(3,4)=' + multiply(3, 4));

if (problems.length > 0) {
  console.error('FAIL: ' + problems.join(', '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      '工作区是一个小型 JS 项目。src/math.js 里 add 函数的实现有 bug，导致 node check.mjs 失败。' +
      '请修复 add，使其满足 add(2,3)===5、add(-1,1)===0，并且不要改动 multiply 的语义。',
    checks: [
      { kind: 'node_script', path: 'check.mjs' },
      { kind: 'file_contains', path: 'src/math.js', patterns: ['export function add'] },
    ],
  },
  {
    id: 'm02-add-slugify',
    kind: 'single_dispatch',
    goal: '在 src/strings.js 中新增并导出 slugify 函数。',
    fixture: [
      {
        path: 'src/strings.js',
        content: `export function capitalize(value) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
`,
      },
      {
        path: 'check.mjs',
        content: `import { capitalize, slugify } from './src/strings.js';

const cases = [
  ['Hello World', 'hello-world'],
  ['  Foo   Bar  ', 'foo-bar'],
  ['A_B', 'a-b'],
  ['already-slugged', 'already-slugged'],
];

const problems = [];
for (const [input, expected] of cases) {
  let actual;
  try {
    actual = slugify(input);
  } catch (error) {
    problems.push('slugify(' + JSON.stringify(input) + ') threw: ' + error.message);
    continue;
  }
  if (actual !== expected) {
    problems.push('slugify(' + JSON.stringify(input) + ')=' + JSON.stringify(actual));
  }
}
if (capitalize('abc') !== 'Abc') problems.push('capitalize broken');

if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      '在 src/strings.js 中新增并导出 slugify(value) 函数：转小写，把空白和下划线替换成连字符，' +
      '合并连续连字符，并去掉首尾连字符；保留已有 capitalize 函数不变。node check.mjs 必须通过。',
    checks: [
      { kind: 'node_script', path: 'check.mjs' },
      { kind: 'file_contains', path: 'src/strings.js', patterns: ['export function slugify'] },
    ],
  },
  {
    id: 'm03-config-retry',
    kind: 'single_dispatch',
    goal: '修改 config/app.json 的 retry 配置（max_attempts=5、backoff_ms=250），其余字段不变。',
    fixture: [
      {
        path: 'config/app.json',
        content: `{
  "name": "report-service",
  "port": 8080,
  "retry": {
    "max_attempts": 3,
    "backoff_ms": 100
  },
  "features": ["reports", "exports"]
}
`,
      },
      {
        path: 'check.mjs',
        content: `import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./config/app.json', import.meta.url), 'utf8'));
const problems = [];
if (config.retry?.max_attempts !== 5) problems.push('max_attempts=' + config.retry?.max_attempts);
if (config.retry?.backoff_ms !== 250) problems.push('backoff_ms=' + config.retry?.backoff_ms);
if (config.name !== 'report-service') problems.push('name changed');
if (config.port !== 8080) problems.push('port changed');
if (JSON.stringify(config.features) !== JSON.stringify(['reports', 'exports'])) {
  problems.push('features changed');
}
if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      '请修改 config/app.json：把 retry.max_attempts 改为 5，retry.backoff_ms 改为 250。' +
      'name、port、features 必须保持原值不变，JSON 仍要合法。node check.mjs 必须通过。',
    checks: [
      { kind: 'node_script', path: 'check.mjs' },
      {
        kind: 'json_path_equals',
        path: 'config/app.json',
        json_path: 'retry.max_attempts',
        expected: 5,
      },
    ],
  },
  {
    id: 'm04-fix-cli-arg',
    kind: 'single_dispatch',
    goal: '修复 bin/cli.js 读取 --name 参数的下标错误。',
    fixture: [
      {
        path: 'bin/cli.js',
        content: `#!/usr/bin/env node
const args = process.argv.slice(2);
const nameIndex = args.indexOf('--name');
// BUG: 取到了 '--name' 本身，而不是它的值。
const name = nameIndex >= 0 ? args[nameIndex] : undefined;
const greeting = name === undefined ? 'Hello, world!' : 'Hello, ' + name + '!';
console.log(greeting);
`,
      },
      {
        path: 'check.mjs',
        content: `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (args) =>
  execFileSync(process.execPath, [path.join(here, 'bin/cli.js'), ...args], { encoding: 'utf8' }).trim();

const problems = [];
if (run(['--name', 'Ada']) !== 'Hello, Ada!') problems.push('named=' + run(['--name', 'Ada']));
if (run([]) !== 'Hello, world!') problems.push('default=' + run([]));
if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      'bin/cli.js 解析 --name 参数时有 bug：带 --name Ada 运行会输出错误结果。' +
      '请修复它：node bin/cli.js --name Ada 必须输出 Hello, Ada!，不带参数时必须输出 Hello, world!。' +
      'node check.mjs 必须通过。',
    checks: [
      { kind: 'node_script', path: 'check.mjs' },
      { kind: 'file_not_contains', path: 'bin/cli.js', patterns: ['args[nameIndex]'] },
    ],
  },

  // ── 需要调查 / 多次派工 / 返工 / 验证（4 例） ─────────────────────
  {
    id: 'x01-locate-and-fix',
    kind: 'multi_dispatch',
    goal: '在 cart.js 与 pricing.js 之间定位折扣计算 bug 并修复，使 node check.mjs 通过。',
    fixture: [
      {
        path: 'src/pricing.js',
        content: `export function applyDiscount(amount, percent) {
  // BUG: 百分比没有除以 100，折扣被放大 100 倍。
  return amount - amount * percent;
}

export function applyTax(amount, rate) {
  return amount + amount * rate;
}
`,
      },
      {
        path: 'src/cart.js',
        content: `import { applyDiscount, applyTax } from './pricing.js';

export function cartTotal(items, discountPercent, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discounted = applyDiscount(subtotal, discountPercent);
  return applyTax(discounted, taxRate);
}
`,
      },
      {
        path: 'check.mjs',
        content: `import { cartTotal } from './src/cart.js';

const cases = [
  {
    name: 'no discount no tax',
    items: [{ price: 100, qty: 2 }],
    discount: 0,
    tax: 0,
    expected: 200,
  },
  {
    name: '10% discount 5% tax',
    items: [{ price: 100, qty: 2 }],
    discount: 10,
    tax: 0.05,
    expected: 189,
  },
  {
    name: 'mixed cart',
    items: [
      { price: 50, qty: 1 },
      { price: 20, qty: 3 },
    ],
    discount: 20,
    tax: 0.1,
    expected: 96.8,
  },
];

const problems = [];
for (const item of cases) {
  const actual = cartTotal(item.items, item.discount, item.tax);
  if (Math.abs(actual - item.expected) > 1e-9) {
    problems.push(item.name + ': expected ' + item.expected + ' got ' + actual);
  }
}
if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      '工作区里 node check.mjs 失败，但问题不一定在 cart.js：请先阅读 src/cart.js 与 src/pricing.js，' +
      '定位真正的 bug 所在再修复（不要盲目改无关代码），最后保证 node check.mjs 通过。' +
      '如果一次派工无法确定原因，可以先派只读调查再派执行。',
    checks: [
      { kind: 'node_script', path: 'check.mjs' },
      { kind: 'file_contains', path: 'src/pricing.js', patterns: ['/ 100'] },
    ],
  },
  {
    id: 'x02-test-then-fix',
    kind: 'multi_dispatch',
    goal: '先写 test/discount.test.mjs（当前代码下失败），再修 src/discount.js 让测试通过。',
    fixture: [
      {
        path: 'src/discount.js',
        content: `export function finalPrice(price, memberLevel) {
  // BUG: gold 应为 0.8，silver 应为 0.9。
  if (memberLevel === 'gold') return price * 0.9;
  if (memberLevel === 'silver') return price * 0.95;
  return price;
}
`,
      },
    ],
    prompt:
      '工作区目前没有测试。请分两步完成：1) 先创建 test/discount.test.mjs，用 node:assert 对 finalPrice ' +
      '写断言（gold 会员应打 8 折、silver 应打 9 折、普通用户原价），这份测试在当前代码下必须失败；' +
      '2) 然后修复 src/discount.js，使 node test/discount.test.mjs 通过。',
    checks: [
      { kind: 'path_exists', path: 'test/discount.test.mjs' },
      { kind: 'node_script', path: 'test/discount.test.mjs' },
      {
        kind: 'node_script',
        path: 'check.mjs',
        label: 'host independent check (finalPrice)',
        timeout_ms: 20_000,
      },
    ],
    notes: 'check.mjs 由 harness 在运行结束后写入并执行（见 HOST_CHECK_FILES），不参与 fixture。',
  },
  {
    id: 'x03-verify-required',
    kind: 'multi_dispatch',
    goal: '修复 src/stats.js 的 average bug，并按要求实际运行 node verify.mjs 取得验证证据。',
    fixture: [
      {
        path: 'src/stats.js',
        content: `export function average(values) {
  // BUG: 分母多了 1。
  return values.reduce((sum, value) => sum + value, 0) / (values.length + 1);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import { average } from './src/stats.js';

const problems = [];
if (average([2, 4]) !== 3) problems.push('average([2,4])=' + average([2, 4]));
if (average([10]) !== 10) problems.push('average([10])=' + average([10]));
if (average([]) !== 0) problems.push('average([])=' + average([]));

if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      '修复 src/stats.js 中 average 的 bug，使 node verify.mjs 通过。' +
      '请实际运行 node verify.mjs，并报告验证结果。',
    checks: [
      { kind: 'node_script', path: 'verify.mjs' },
      { kind: 'file_contains', path: 'src/stats.js', patterns: ['values.length'] },
    ],
  },
  {
    id: 'x04-two-bugs',
    kind: 'multi_dispatch',
    goal: '同时修复 src/format.js 与 src/parse.js 中两个独立 bug，使 node check.mjs 通过。',
    fixture: [
      {
        path: 'src/format.js',
        content: `export function formatPrice(cents) {
  // BUG: 少除以 100，且没有保留两位小数。
  return '$' + cents;
}
`,
      },
      {
        path: 'src/parse.js',
        content: `export function parsePrice(text) {
  // BUG: 去掉 $ 后没有转成分（整数分），返回了元。
  return Number(text.replace('$', ''));
}
`,
      },
      {
        path: 'check.mjs',
        content: `import { formatPrice } from './src/format.js';
import { parsePrice } from './src/parse.js';

const problems = [];
if (formatPrice(1234) !== '$12.34') problems.push('formatPrice(1234)=' + formatPrice(1234));
if (formatPrice(5) !== '$0.05') problems.push('formatPrice(5)=' + formatPrice(5));
if (parsePrice('$12.34') !== 1234) problems.push('parsePrice($12.34)=' + parsePrice('$12.34'));
if (parsePrice('$0.05') !== 5) problems.push('parsePrice($0.05)=' + parsePrice('$0.05'));

if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
      },
    ],
    prompt:
      '工作区里有两个独立 bug：src/format.js 的 formatPrice 与 src/parse.js 的 parsePrice。' +
      'node check.mjs 会同时覆盖两者。请逐个定位并修复，两个都必须通过；' +
      '可以一次派工修完，也可以分两次派工。',
    checks: [
      { kind: 'node_script', path: 'check.mjs' },
      { kind: 'file_contains', path: 'src/format.js', patterns: ['toFixed(2)'] },
      { kind: 'file_contains', path: 'src/parse.js', patterns: ['* 100', 'Math.round'] },
    ],
  },

  // ── 无需修改文件的分析 / 答复（3 例） ─────────────────────────────
  {
    id: 'a01-explain-auth',
    kind: 'analysis',
    goal: '只读分析 src/auth.js：解释 token 为什么会被立刻判过期，指出函数并给修复方向。',
    fixture: [
      {
        path: 'src/auth.js',
        content: `const TOKEN_TTL_SECONDS = 900;

export function createToken(nowMs) {
  return { expires_at: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS };
}

export function isTokenExpired(token, nowMs) {
  // expires_at 是秒，nowMs 是毫秒，直接比较会立刻判过期。
  return nowMs > token.expires_at;
}
`,
      },
    ],
    prompt:
      ANALYSIS_ONLY +
      ' 阅读 src/auth.js，解释用户为什么刚登录就被判 token 过期（root cause），' +
      '指出涉及的文件名与函数名，并说明修复方向。回答必须包含：src/auth.js、isTokenExpired、' +
      'expires_at、秒与毫秒的单位不一致。',
    checks: [
      {
        kind: 'answer_contains',
        patterns: ['auth.js', 'isTokenExpired', 'expires_at'],
      },
      { kind: 'workspace_unchanged' },
    ],
  },
  {
    id: 'a02-compare-impl',
    kind: 'analysis',
    goal: '只读比较 src/impl_a.js 与 src/impl_b.js 两种缓存实现并给出选择建议。',
    fixture: [
      {
        path: 'src/impl_a.js',
        content: `// 同步缓存实现：读文件后放进 Map，无容量上限。
const cache = new Map();

export function readCached(filePath, readFileSync) {
  if (cache.has(filePath)) return cache.get(filePath);
  const value = readFileSync(filePath, 'utf8');
  cache.set(filePath, value);
  return value;
}
`,
      },
      {
        path: 'src/impl_b.js',
        content: `// 异步 LRU 缓存实现：有容量上限，命中时刷新顺序。
export function createLruCache(capacity) {
  const entries = new Map();
  return {
    async get(key, load) {
      if (entries.has(key)) {
        const value = entries.get(key);
        entries.delete(key);
        entries.set(key, value);
        return value;
      }
      const value = await load(key);
      entries.set(key, value);
      if (entries.size > capacity) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
`,
      },
    ],
    prompt:
      ANALYSIS_ONLY +
      ' 比较 src/impl_a.js 与 src/impl_b.js 两种缓存实现，推荐其中一个用于「文件内容缓存」场景，' +
      '并给出至少两条理由（可提及容量上限、异步/同步、内存增长、并发）。' +
      '回答必须同时提到 impl_a.js 与 impl_b.js，并明确写出推荐哪一个。',
    checks: [
      { kind: 'answer_contains', patterns: ['impl_a.js', 'impl_b.js'] },
      { kind: 'answer_contains', patterns: ['cache', '缓存', 'LRU', '容量'], any: true },
      { kind: 'workspace_unchanged' },
    ],
  },
  {
    id: 'a03-list-api',
    kind: 'analysis',
    goal: '只读列出 server.js 中全部 HTTP 路由（方法 + 路径）。',
    fixture: [
      {
        path: 'server.js',
        content: `import http from 'node:http';

const routes = [];

function route(method, path, handler) {
  routes.push({ method, path, handler });
}

route('GET', '/health', () => ({ status: 'ok' }));
route('POST', '/users', () => ({ created: true }));
route('GET', '/users/:id', () => ({ id: 1 }));
route('DELETE', '/users/:id', () => ({ deleted: true }));
route('POST', '/login', () => ({ token: 't' }));

export function createServer() {
  return http.createServer((req, res) => {
    const match = routes.find(
      (item) => item.method === req.method && item.path === (req.url ?? ''),
    );
    if (!match) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.end(JSON.stringify(match.handler()));
  });
}
`,
      },
    ],
    prompt:
      ANALYSIS_ONLY +
      ' 阅读 server.js，列出其中注册的全部 HTTP 路由，每条写成「方法 路径」的形式' +
      '（例如 GET /health）。回答必须覆盖全部 5 条路由：/health、POST /users、/users/:id、' +
      'DELETE /users/:id、/login。',
    checks: [
      {
        kind: 'answer_contains',
        patterns: ['/health', '/users', '/login'],
      },
      { kind: 'answer_contains', patterns: ['DELETE', 'delete'], any: true },
      { kind: 'workspace_unchanged' },
    ],
  },
];

/**
 * harness 在 run 结束后额外写入 workspace 并执行的独立校验脚本（不属于 fixture）。
 * 只用于「初始状态里没有检查脚本、但完成标准要求确定性验证」的任务。
 */
export const HOST_CHECK_FILES: Record<string, FixtureFile[]> = {
  'x02-test-then-fix': [
    {
      path: 'check.mjs',
      content: `import { finalPrice } from './src/discount.js';

const problems = [];
if (finalPrice(100, 'gold') !== 80) problems.push('gold=' + finalPrice(100, 'gold'));
if (finalPrice(100, 'silver') !== 90) problems.push('silver=' + finalPrice(100, 'silver'));
if (finalPrice(100, 'none') !== 100) problems.push('none=' + finalPrice(100, 'none'));
if (problems.length > 0) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
`,
    },
  ],
};

export function getFixedTask(id: string): FixedTask {
  const task = FIXED_TASKS.find((item) => item.id === id);
  if (!task) throw new Error(`Unknown fixed task: ${id}`);
  return task;
}
