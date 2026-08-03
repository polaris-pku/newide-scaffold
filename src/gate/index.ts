import { BaseGateRunner } from './runner';
import { CommandRunner } from './command-runner';
import { PromptRunner } from './prompt-runner';
import { CompositeRunner } from './composite-runner';
import { HttpRunner } from './http-runner';

BaseGateRunner.build = (gateId, definition, resolver) => {
  switch (definition.type) {
    case 'command':
      return new CommandRunner(gateId, definition);
    case 'prompt':
      return new PromptRunner(gateId, definition);
    case 'composite':
      if (!resolver) {
        throw new Error('CompositeRunner requires a resolver function.');
      }
      return new CompositeRunner(gateId, definition, resolver);
    case 'http':
      return new HttpRunner(gateId, definition);
    default: {
      const unsupported = definition as { type: string };
      throw new Error(`Unsupported gate type: ${unsupported.type}`);
    }
  }
};

export * from './gate';
export * from './aggregator';
export * from './mock-gate';
export * from './runner';
export * from './scheduler';
export * from './output-parser';
export * from './command-runner';
export * from './prompt-runner';
export * from './composite-runner';
export * from './http-runner';
