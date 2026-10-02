/**
 * DNS records the operator must create, reported by providers during a run (Netlify custom
 * domain, Railway custom domains, the Resend sender domain) and listed — with live status — in the
 * next-steps checklist. Not secret: these are public DNS values.
 */
export interface DnsRequirement {
  /** Which provider asked for it. */
  readonly provider: string;
  readonly type: 'CNAME' | 'TXT' | 'MX';
  /** Fully qualified record name, e.g. `app.example.com`. */
  readonly name: string;
  readonly value: string;
  readonly priority?: number;
}

const collected: DnsRequirement[] = [];

/** Record one requirement (duplicates — same type/name/value — are ignored). */
export function requireDnsRecord(record: DnsRequirement): void {
  const duplicate = collected.some(
    (existing) =>
      existing.type === record.type &&
      existing.name.toLowerCase() === record.name.toLowerCase() &&
      existing.value === record.value,
  );
  if (!duplicate) collected.push(record);
}

/** Everything reported so far in this process. */
export function collectedDnsRequirements(): readonly DnsRequirement[] {
  return collected;
}

/** Map a Railway `DNS_RECORD_TYPE_CNAME` style type to its plain name. */
export function plainDnsType(type: string): DnsRequirement['type'] | undefined {
  const plain = type.replace(/^DNS_RECORD_TYPE_/, '').toUpperCase();
  return plain === 'CNAME' || plain === 'TXT' || plain === 'MX' ? plain : undefined;
}
