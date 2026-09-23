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

type FixtureJson = Record<string, unknown>;

const FIXTURE_FILES = [
  'v1-sap-execute.json',
  'v1-sap-result.json',
  'v1-adp-invoke.json',
  'v1-adp-result.json',
  'v1-aap-ask.json',
  'v1-aap-reply.json',
] as const;

async function readRaw(name: string): Promise<string> {
  return readFile(`fixtures/protocol/${name}`, 'utf-8');
}

async function readJson(name: string): Promise<FixtureJson> {
  return JSON.parse(await readRaw(name)) as FixtureJson;
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

const NEGATIVES_A: NegativeCase[] = [
  // missing fields
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
  // mixed direction
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
const NEGATIVES_B: NegativeCase[] = [
  // illegal status
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

const NEGATIVES: NegativeCase[] = [...NEGATIVES_A, ...NEGATIVES_B];
describe('Communication Protocol v1 frames', () => {
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
      expect(frame).toEqual(json);
      expect(`${JSON.stringify(frame, null, 2)}\n`).toBe(raw);
    });
  });

  describe('frozen causality', () => {
    it('keeps the causal graph closed over protocol exchanges only', async () => {
      const frames = await Promise.all(
        FIXTURE_FILES.map(async (name) => protocolFrameSchema.parse(await readJson(name))),
      );
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
      const allRaw = (await Promise.all(FIXTURE_FILES.map(readRaw))).join('\n');
      expect(allRaw).not.toMatch(/intent-0019|tool-call-0011/);
    });

    it('walks an ADP result back to its SAP root', async () => {
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
    it.each(NEGATIVES)('rejects $name', async ({ file, mutate }) => {
      const json = await readJson(file);
      mutate(json);
      expect(protocolFrameSchema.safeParse(json).success).toBe(false);
    });
  });
  describe('cancel frames (no doc example, exercised inline)', () => {
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
      const sep = String.fromCharCode(0);
      expect(bindingKey('task-0088', 'ws/path', 'implementer')).toBe(
        `task-0088${sep}ws/path${sep}implementer`,
      );
    });
  });
});
