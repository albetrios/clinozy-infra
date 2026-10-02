/**
 * Railway verifies a custom domain with a `_railway-verify` TXT record before it issues the
 * certificate; its host comes back relative to the zone, so the checklist needs the full name.
 */
import { describe, expect, it } from 'vitest';
import { type CustomDomainStatus, railwayVerificationRecord } from '@setup/railway/railway-api.js';

const status = (overrides: Partial<CustomDomainStatus>): CustomDomainStatus => ({
  certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP',
  verified: false,
  dnsRecords: [],
  ...overrides,
});

describe('railwayVerificationRecord', () => {
  it('builds the full TXT name for an environment host and for the production host', () => {
    expect(
      railwayVerificationRecord(
        'development--api.acme.test',
        status({
          verificationDnsHost: '_railway-verify.development--api',
          verificationToken: 'railway-verify=abc',
        }),
      ),
    ).toEqual({ name: '_railway-verify.development--api.acme.test', value: 'railway-verify=abc' });
    expect(
      railwayVerificationRecord(
        'api.acme.test',
        status({
          verificationDnsHost: '_railway-verify.api',
          verificationToken: 'railway-verify=def',
        }),
      ),
    ).toEqual({ name: '_railway-verify.api.acme.test', value: 'railway-verify=def' });
  });

  it("prefers the zone Railway reports on the domain's own DNS records", () => {
    const record = {
      recordType: 'DNS_RECORD_TYPE_CNAME',
      hostlabel: 'api',
      fqdn: 'api.eu.acme.test',
      requiredValue: 'x.up.railway.app',
      currentValue: '',
      status: 'DNS_RECORD_STATUS_PROPAGATED',
      purpose: 'DNS_RECORD_PURPOSE_TRAFFIC_ROUTE',
      zone: 'eu.acme.test',
    };
    expect(
      railwayVerificationRecord(
        'api.eu.acme.test',
        status({
          dnsRecords: [record],
          verificationDnsHost: '_railway-verify.api',
          verificationToken: 't',
        }),
      )?.name,
    ).toBe('_railway-verify.api.eu.acme.test');
  });

  it('is undefined when Railway asks for no verification record', () => {
    expect(railwayVerificationRecord('api.acme.test', status({}))).toBeUndefined();
    expect(
      railwayVerificationRecord(
        'api.acme.test',
        status({ verificationDnsHost: '_railway-verify.api' }),
      ),
    ).toBeUndefined();
  });
});
