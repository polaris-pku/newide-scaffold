import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BidLedger, MarketAudit } from './models';

export interface MarketEvidenceRefs {
  ledger_ref: string;
  audit_ref: string;
}

export interface MarketEvidenceStore {
  persist(input: { ledger: BidLedger; audit: MarketAudit }): Promise<MarketEvidenceRefs>;
}

export interface FileMarketEvidenceStoreOptions {
  root: string;
}

export class FileMarketEvidenceStore implements MarketEvidenceStore {
  constructor(private readonly options: FileMarketEvidenceStoreOptions) {}

  async persist(input: { ledger: BidLedger; audit: MarketAudit }): Promise<MarketEvidenceRefs> {
    const evidenceDirectory = path.join(this.options.root, input.ledger.ledger_id);
    const ledgerPath = path.join(evidenceDirectory, 'ledger.json');
    const auditPath = path.join(evidenceDirectory, 'audit.json');
    await fs.mkdir(evidenceDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(ledgerPath, `${JSON.stringify(input.ledger, null, 2)}\n`, 'utf8'),
      fs.writeFile(auditPath, `${JSON.stringify(input.audit, null, 2)}\n`, 'utf8'),
    ]);
    return {
      ledger_ref: pathToFileURL(ledgerPath).href,
      audit_ref: pathToFileURL(auditPath).href,
    };
  }
}
