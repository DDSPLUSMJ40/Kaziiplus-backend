import { mockFormationProvider } from './formation.mock';

export interface FormationQuote {
  providerCostCents: number; // all-in wholesale, including the state filing fee
  stateFeeCents: number; // the state-filing-fee portion, for the price breakdown
}

export interface FormationInput {
  companyName: string;
  state: string;
  founderName: string;
  founderEmail: string;
  mailingAddress: { line1: string; line2?: string; city: string; state: string; zip: string };
}

export type ProviderStatus = 'FILED' | 'COMPLETED' | 'FAILED';

export interface FormationStatusEvent {
  providerOrderId: string;
  status?: ProviderStatus;
  ein?: string;
  registeredAgentAssigned?: boolean;
  failureReason?: string;
}

export interface FormationProvider {
  name: 'MOCK' | 'DOOLA';
  getQuote(state: string): Promise<FormationQuote>;
  submitFormation(input: FormationInput): Promise<{ providerOrderId: string }>;
  // Throws on an invalid signature; returns null for an event we ignore.
  parseStatusWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): FormationStatusEvent | null;
}

export function getFormationProvider(): FormationProvider {
  const name = (process.env.FORMATION_PROVIDER ?? 'mock').toLowerCase();
  if (name === 'mock') return mockFormationProvider;
  throw new Error(`Unknown or unimplemented FORMATION_PROVIDER: ${name}`);
}
