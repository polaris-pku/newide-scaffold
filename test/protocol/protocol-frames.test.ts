/**
 * Communication Protocol v1 consistency suite (P0, issue #145): the six
 * §3–§5 examples are machine-checkable positives that round-trip through the
 * frame validator byte-for-byte; the fixture causal graph must contain only
 * protocol exchanges (calls never enter it); every DoD rejection class —
 * missing fields, mixed direction, illegal status, wrong principal, plus the
 * per-protocol traps — is refused; and the frozen session binding key stays
 * pinned to the live registry implementation.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AAP_COMMANDS,
  AAP_STATUSES,
  ADP_COMMANDS,
  ADP_SIDE_EFFECTS,
  ADP_STATUSES,
  PROTOCOL_VERSION,
  SAP_COMMANDS,
  SAP_STATUSES,
  protocolFrameSchema,
} from '../../src/core';
import { bindingKey } from '../../src/coordination/participant-session-registry';

type FixtureJson = Record<string, unknown>; // JSON.parse 后的松散对象，供 mutation 用

// 六个正例 = 设计稿 §3–§5 的示例 JSON 原样落盘（v1- 前缀把冻结集和目录里
// 既有三个 fixture 区分开）。其中两个的 causation 已按新因果口径修正：
// v1-adp-invoke / v1-aap-ask 指回外层 SAP execute（原 intent-0019 / tool-call-0011）。
const FIXTURE_FILES = [
  'v1-sap-execute.json',
  'v1-sap-result.json',
  'v1-adp-invoke.json',
  'v1-adp-result.json',
  'v1-aap-ask.json',
  'v1-aap-reply.json',
] as const;

// 按仓库惯例从仓库根 cwd 相对读取（vitest 工作目录 = 仓库根，与既有
// test/protocol/run-snapshot.test.ts 等一致，不走 import.meta.url）。
async function readRaw(name: string): Promise<string> {
  return readFile(`fixtures/protocol/${name}`, 'utf-8');
}

async function readJson(name: string): Promise<FixtureJson> {
  return JSON.parse(await readRaw(name)) as FixtureJson; // JSON 宽容空白；校验交给 schema
}

function producerOf(json: FixtureJson): FixtureJson {
  return json.producer as FixtureJson;
}

interface NegativeCase {
  name: string;
  file: string;
  mutate: (json: FixtureJson) => void;
}

const sampleError: FixtureJson = { code: 'BOOM', message: 'kaboom', retryable: false };

// 反例 = 表驱动 inline mutation：克隆一份能通过的正例，改坏一个点，
// 断言 safeParse 失败。每个条目对应 DoD 的一条拒收规则。
// A 组：前两类——缺字段（6 条）+ 方向字段混用（5 条）。
const NEGATIVES_A: NegativeCase[] = [
  // 缺字段：公共键少一个、principal 少 role_id、版本字面量不符 → 一律拒
  { name: 'missing producer', file: 'v1-sap-execute.json', mutate: (j) => void delete j.producer },
  {
    name: 'missing deadline_at',
    file: 'v1-sap-execute.json',
    mutate: (j) => void delete j.deadline_at,
  },
  {
    name: 'missing instruction on driver.invoke',
    file: 'v1-adp-invoke.json',
    mutate: (j) => void delete j.instruction,
  },
  {
    name: 'missing status on receipt',
    file: 'v1-sap-result.json',
    mutate: (j) => void delete j.status,
  },
  {
    name: 'principal missing role_id',
    file: 'v1-sap-execute.json',
    mutate: (j) => void delete producerOf(j).role_id,
  },
  {
    name: 'wrong protocol_version',
    file: 'v1-sap-execute.json',
    mutate: (j) => (j.protocol_version = '2.0'),
  },
  // 方向混用：command/result 恰好其一被破坏的五种姿势
  //（兼有 → strict 多余键拒；皆无 → 没有分支能过；只有 result 没 status → 同理）
  {
    name: 'command frame carrying a complete receipt',
    file: 'v1-sap-execute.json',
    mutate: (j) => {
      j.result = 'agent.execution_result';
      j.status = 'completed';
      j.summary = 'should not coexist with command';
      j.error = null;
    },
  },
  {
    name: 'receipt carrying a command',
    file: 'v1-sap-result.json',
    mutate: (j) => (j.command = 'agent.execute'),
  },
  {
    name: 'command frame with direction fields stripped',
    file: 'v1-sap-execute.json',
    mutate: (j) => void delete j.command,
  },
  {
    name: 'command frame with result but no status',
    file: 'v1-sap-execute.json',
    mutate: (j) => (j.result = 'agent.execution_result'),
  },
  {
    name: 'protocol literal flipped to another protocol',
    file: 'v1-sap-execute.json',
    mutate: (j) => (j.protocol = 'agent-agent'),
  },
];
// B 组：后三类——非法 status（7 条）+ 错误身份（3 条）+ 协议特例（9 条，
// cancel 的 target/causation、invoke 的 side_effect、auto_retry 不进信封、
// AAP reply 禁带 command/message_id/side_effect）。
const NEGATIVES_B: NegativeCase[] = [
  // 非法 status：跨协议枚举串门 + status×error 交叉（superRefine 两条规则）
  {
    name: 'SAP receipt with ADP-only unknown status',
    file: 'v1-sap-result.json',
    mutate: (j) => (j.status = 'unknown'),
  },
  {
    name: 'SAP receipt with ADP-only succeeded status',
    file: 'v1-sap-result.json',
    mutate: (j) => (j.status = 'succeeded'),
  },
  {
    name: 'AAP reply with unknown status',
    file: 'v1-aap-reply.json',
    mutate: (j) => (j.status = 'unknown'),
  },
  {
    name: 'completed receipt carrying a non-null error',
    file: 'v1-sap-result.json',
    mutate: (j) => (j.error = { ...sampleError }),
  },
  {
    name: 'failed receipt with null error',
    file: 'v1-sap-result.json',
    mutate: (j) => (j.status = 'failed'),
  },
  {
    name: 'AAP completed reply carrying an error',
    file: 'v1-aap-reply.json',
    mutate: (j) => (j.error = { ...sampleError }),
  },
  {
    name: 'ADP succeeded result carrying an error',
    file: 'v1-adp-result.json',
    mutate: (j) => (j.error = { ...sampleError }),
  },
  // wrong principal
  {
    name: 'SAP execute produced by driver',
    file: 'v1-sap-execute.json',
    mutate: (j) => (producerOf(j).kind = 'driver'),
  },
  {
    name: 'principal carrying an extra key',
    file: 'v1-sap-execute.json',
    mutate: (j) => (producerOf(j).agent_id = 'agent-1'),
  },
  {
    name: 'ADP invoke produced by system',
    file: 'v1-adp-invoke.json',
    mutate: (j) => (producerOf(j).kind = 'system'),
  },
  // per-protocol traps
  {
    name: 'agent.cancel without target_exchange_id',
    file: 'v1-sap-execute.json',
    mutate: (j) => {
      j.command = 'agent.cancel';
      delete j.instruction;
      delete j.council_seat;
    },
  },
  {
    name: 'agent.cancel causation not pointing at target',
    file: 'v1-sap-execute.json',
    mutate: (j) => {
      j.command = 'agent.cancel';
      delete j.instruction;
      delete j.council_seat;
      j.target_exchange_id = 'ex-sap-00041';
      // causation_id stays null, which is != target
    },
  },
  {
    name: 'driver.invoke without side_effect',
    file: 'v1-adp-invoke.json',
    mutate: (j) => void delete j.side_effect,
  },
  {
    name: 'driver.invoke with invalid side_effect',
    file: 'v1-adp-invoke.json',
    mutate: (j) => (j.side_effect = 'executive'),
  },
  {
    name: 'envelope carrying deployment-level auto_retry',
    file: 'v1-adp-invoke.json',
    mutate: (j) => (j.auto_retry = { workspace_write: true }),
  },
  {
    name: 'AAP reply carrying a command',
    file: 'v1-aap-reply.json',
    mutate: (j) => (j.command = 'agent.ask'),
  },
  {
    name: 'AAP reply carrying message_id',
    file: 'v1-aap-reply.json',
    mutate: (j) => (j.message_id = 'msg-0007'),
  },
  {
    name: 'AAP reply carrying side_effect',
    file: 'v1-aap-reply.json',
    mutate: (j) => (j.side_effect = 'read_only'),
  },
];

// 合并后喂给 it.each：每条反例一个用例，逐条全拒才算过（验收要求列清单，不写「若干」）。
const NEGATIVES: NegativeCase[] = [...NEGATIVES_A, ...NEGATIVES_B];
describe('Communication Protocol v1 frames', () => {
  // 冻结词汇表测试：断言把 8 个枚举/常量钉成设计稿 §2.1 的字面量清单——
  // 谁改了 src 里的枚举而没同步设计稿与本测试，这里就红。
  it('freezes the v1 vocabulary', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
    expect(SAP_COMMANDS).toEqual(['agent.execute', 'agent.cancel']);
    expect(SAP_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
    expect(ADP_COMMANDS).toEqual(['driver.invoke', 'driver.cancel']);
    expect(ADP_STATUSES).toEqual(['succeeded', 'failed', 'cancelled', 'unknown']);
    expect(ADP_SIDE_EFFECTS).toEqual(['read_only', 'workspace_write', 'external']);
    expect(AAP_COMMANDS).toEqual(['agent.ask']);
    expect(AAP_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
  });

  describe('positive fixtures', () => {
    it.each(FIXTURE_FILES)('%s parses and round-trips byte-for-byte', async (name) => {
      const raw = await readRaw(name);
      const json = JSON.parse(raw) as FixtureJson;
      const frame = protocolFrameSchema.parse(json);
      // 验收主断言：parse 前后深相等 → 没有字段被丢、被改、被 strict 剥掉
      expect(frame).toEqual(json);
      // 更强的字节级断言：序列化结果与原文逐字节一致。
      // 成立的前提 = fixture 键序与 envelopeShape 的 shape 键序一致、2 空格缩进、
      // 末尾单个换行（.gitattributes 把 fixtures 钉为 LF，跨平台稳定）。
      expect(`${JSON.stringify(frame, null, 2)}\n`).toBe(raw);
    });
  });

  describe('frozen causality', () => {
    it('keeps the causal graph closed over protocol exchanges only', async () => {
      const frames = await Promise.all(
        FIXTURE_FILES.map(async (name) => protocolFrameSchema.parse(await readJson(name))),
      );
      // 冻结后的精确因果边表：exchange_id → causation_id。
      // 断言整表而不是逐条，既验「只有协议 exchange」（封闭性），也验「一条边没被悄悄改掉」。
      const edges = Object.fromEntries(
        frames.map((frame) => [frame.exchange_id, frame.causation_id]),
      );
      expect(edges).toEqual({
        'ex-sap-00041': null,
        'ex-sap-00042': 'ex-sap-00041',
        'ex-adp-00071': 'ex-sap-00041',
        'ex-adp-00072': 'ex-adp-00071',
        'ex-aap-00051': 'ex-sap-00041',
        'ex-aap-00052': 'ex-aap-00051',
      });
      const exchangeIds = new Set(Object.keys(edges));
      expect(exchangeIds.size).toBe(FIXTURE_FILES.length);
      for (const frame of frames) {
        if (frame.causation_id !== null) {
          expect(exchangeIds.has(frame.causation_id)).toBe(true);
        }
      }
    });

    it('never lets call or intent ids into the fixtures', async () => {
      // 双保险：对六个文件的原始字节全文搜两个修正前的调用 id——
      // 哪怕有人把它们作为 causation（或任何字段）写回去，这里立刻红。
      const allRaw = (await Promise.all(FIXTURE_FILES.map(readRaw))).join('\n');
      expect(allRaw).not.toMatch(/intent-0019|tool-call-0011/);
    });

    it('walks an ADP result back to its SAP root', async () => {
      // 沿 causation 父指针走到底：ex-adp-00072 → ex-adp-00071 → ex-sap-00041 → null。
      // 模拟验收场景「以 SAP execute 为根查出完整因果树」的回溯方向；
      // 途中遇到不在 fixture 集里的 id 立即抛错（因果链不得逃出协议帧集合）。
      const frames = await Promise.all(
        FIXTURE_FILES.map(async (name) => protocolFrameSchema.parse(await readJson(name))),
      );
      const byId = new Map(frames.map((frame) => [frame.exchange_id, frame]));
      const chain: string[] = [];
      let cursor: string | null = 'ex-adp-00072';
      while (cursor !== null) {
        chain.push(cursor);
        const frame = byId.get(cursor);
        if (!frame) throw new Error(`causation left the fixture set at ${cursor}`);
        cursor = frame.causation_id;
      }
      expect(chain).toEqual(['ex-adp-00072', 'ex-adp-00071', 'ex-sap-00041']);
    });
  });

  describe('negative examples', () => {
    // 每条反例一个用例：克隆正例 → mutate 改坏一处 → safeParse 必须失败。
    // success 为 false 才算「被拒」；若 mutation 意外没改坏，这条会红提醒你断言失效。
    it.each(NEGATIVES)('rejects $name', async ({ file, mutate }) => {
      const json = await readJson(file);
      mutate(json);
      expect(protocolFrameSchema.safeParse(json).success).toBe(false);
    });
  });
  // cancel 变体（agent.cancel / driver.cancel）两份设计稿都没有 JSON 示例，
  // 在线构造合法样本 + 上面反例组里的两条 cancel 变坏样本，保证这三个分支不是死代码。
  describe('cancel frames (no doc example, exercised inline)', () => {
    // 合法 cancel：causation 与 target 都指被取消的 execute，instruction/council_seat 换成 target
    it('accepts a well-formed agent.cancel pointing at its execute', async () => {
      const json = await readJson('v1-sap-execute.json');
      json.exchange_id = 'ex-sap-00043';
      json.causation_id = 'ex-sap-00041';
      json.command = 'agent.cancel';
      json.target_exchange_id = 'ex-sap-00041';
      delete json.council_seat;
      delete json.instruction;
      const frame = protocolFrameSchema.parse(json);
      expect(frame).toEqual(json);
    });

    it('accepts a well-formed driver.cancel pointing at its invoke', async () => {
      const json = await readJson('v1-adp-invoke.json');
      json.exchange_id = 'ex-adp-00073';
      json.causation_id = 'ex-adp-00071';
      json.command = 'driver.cancel';
      json.target_exchange_id = 'ex-adp-00071';
      delete json.workspace;
      delete json.side_effect;
      delete json.instruction;
      const frame = protocolFrameSchema.parse(json);
      expect(frame).toEqual(json);
    });
  });

  describe('session binding freeze', () => {
    it('pins task + workspace + role as the binding key', () => {
      // 会话绑定键冻结为 task + workspace + role 三段、\0 分隔——
      // 直接调现网 bindingKey 比对同一拼法，把「键的组成」钉在真实现上（registry 零改动）。
      // 用 fromCharCode(0) 构造分隔符，避免在源码里写字面控制字符。
      const sep = String.fromCharCode(0);
      expect(bindingKey('task-0088', 'ws/path', 'implementer')).toBe(
        `task-0088${sep}ws/path${sep}implementer`,
      );
    });
  });
});
