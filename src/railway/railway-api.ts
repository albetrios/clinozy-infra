/**
 * Railway GraphQL access shared by the Railway provider and `pnpm setup:domain`.
 *
 * Holds the one definition of "make sure a service has a Railway-generated domain" — the backend's
 * public address before (or without) a custom domain, which the frontend build needs as
 * VITE_API_BASE_URL.
 */
import { setupFetch } from '@setup/common/setup-fetch.js';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

/** One bearer-authenticated Railway GraphQL call; throws on HTTP or GraphQL errors. */
export async function railwayGraphQL<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await setupFetch({
    name: 'Railway',
    url: RAILWAY_API_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Railway GraphQL failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (result.errors?.length) {
    throw new Error(
      `Railway GraphQL errors: ${result.errors.map((error) => error.message).join('; ')}`,
    );
  }

  return result.data as T;
}

/**
 * Make one service variable hold `value` in one environment: read first, write only on a
 * difference, and never trigger a deploy (`skipDeploys` — the app's own pipeline deploys). Returns
 * whether it changed.
 */
export async function ensureServiceVariable(
  token: string,
  input: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    name: string;
    value: string;
  },
): Promise<boolean> {
  const { projectId, environmentId, serviceId, name, value } = input;
  const current = await railwayGraphQL<{ variables: Record<string, string> }>(
    token,
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
    }`,
    { projectId, environmentId, serviceId },
  );
  if (current.variables[name] === value) return false;
  await railwayGraphQL(
    token,
    `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
    { input: { projectId, environmentId, serviceId, name, value, skipDeploys: true } },
  );
  return true;
}

export interface ServiceDomain {
  id: string;
  domain: string;
  targetPort: number | null;
}

export async function fetchServiceDomains(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<ServiceDomain[]> {
  const result = await railwayGraphQL<{
    domains: { serviceDomains: ServiceDomain[] };
  }>(
    token,
    `
    query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        serviceDomains {
          id
          domain
          targetPort
        }
      }
    }
  `,
    { projectId, environmentId, serviceId },
  );
  return result.domains.serviceDomains;
}

export async function createServiceDomain(
  token: string,
  environmentId: string,
  serviceId: string,
  targetPort: number | undefined,
): Promise<ServiceDomain> {
  const result = await railwayGraphQL<{ serviceDomainCreate: ServiceDomain }>(
    token,
    `
    mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        id
        domain
        targetPort
      }
    }
  `,
    {
      input: {
        environmentId,
        serviceId,
        ...(typeof targetPort === 'number' ? { targetPort } : {}),
      },
    },
  );
  return result.serviceDomainCreate;
}

/** Reuse the service's first Railway-generated domain, or create one. */
export async function ensureServiceDomain(
  token: string,
  target: { projectId: string; environmentId: string; serviceId: string; targetPort?: number },
): Promise<{ domain: ServiceDomain; created: boolean }> {
  const existing = await fetchServiceDomains(
    token,
    target.projectId,
    target.environmentId,
    target.serviceId,
  );
  if (existing[0]) return { domain: existing[0], created: false };
  return {
    domain: await createServiceDomain(
      token,
      target.environmentId,
      target.serviceId,
      target.targetPort,
    ),
    created: true,
  };
}

export interface DnsRecord {
  recordType: string;
  hostlabel: string;
  fqdn: string;
  requiredValue: string;
  currentValue: string;
  status: string;
  purpose: string;
  zone: string;
}

export interface CustomDomainStatus {
  certificateStatus: string;
  verified: boolean;
  dnsRecords: DnsRecord[];
  /** Ownership TXT record Railway asks for, relative to the zone — e.g. `_railway-verify.api`. */
  verificationDnsHost?: string | null;
  /** Its value — e.g. `railway-verify=4f78…`. Public by design: it goes into DNS. */
  verificationToken?: string | null;
}

/**
 * The `_railway-verify` TXT record Railway needs before it verifies a custom domain and issues its
 * certificate, as a full DNS name. `verificationDnsHost` is relative to the domain's zone
 * (`_railway-verify.development--api` for `development--api.clinozy.com`), so the zone is the
 * domain minus that label — or the zone Railway reports on the domain's own DNS records.
 */
export function railwayVerificationRecord(
  domain: string,
  status: CustomDomainStatus,
): { name: string; value: string } | undefined {
  const host = status.verificationDnsHost;
  const value = status.verificationToken;
  if (!host || !value) return undefined;
  const label = host.replace(/^_railway-verify\.?/, '');
  const zone =
    status.dnsRecords.find((record) => record.zone)?.zone ??
    (label && domain.startsWith(`${label}.`) ? domain.slice(label.length + 1) : domain);
  return { name: `${host}.${zone}`, value };
}

export interface CustomDomainSummary {
  id: string;
  domain: string;
  targetPort: number | null;
  status: CustomDomainStatus;
}

export async function fetchCustomDomains(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<CustomDomainSummary[]> {
  const result = await railwayGraphQL<{
    domains: { customDomains: CustomDomainSummary[] };
  }>(
    token,
    `
    query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        customDomains {
          id
          domain
          targetPort
          status {
            certificateStatus
            verified
            verificationDnsHost
            verificationToken
            dnsRecords {
              recordType
              hostlabel
              fqdn
              requiredValue
              currentValue
              status
              purpose
              zone
            }
          }
        }
      }
    }
  `,
    { projectId, environmentId, serviceId },
  );
  return result.domains.customDomains;
}

export async function createCustomDomain(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  domain: string,
  targetPort: number | undefined,
): Promise<CustomDomainSummary> {
  const result = await railwayGraphQL<{ customDomainCreate: CustomDomainSummary }>(
    token,
    `
    mutation($input: CustomDomainCreateInput!) {
      customDomainCreate(input: $input) {
        id
        domain
        targetPort
        status {
          certificateStatus
          verified
          verificationDnsHost
          verificationToken
          dnsRecords {
            recordType
            hostlabel
            fqdn
            requiredValue
            currentValue
            status
            purpose
            zone
          }
        }
      }
    }
  `,
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        domain,
        ...(typeof targetPort === 'number' ? { targetPort } : {}),
      },
    },
  );
  return result.customDomainCreate;
}

/**
 * Attach `domain` to the service (idempotent — an existing attachment is returned as-is). Railway
 * issues the certificate once DNS points at it; `status.dnsRecords` lists what to create.
 */
export async function ensureCustomDomain(
  token: string,
  target: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    domain: string;
    targetPort?: number;
  },
): Promise<{ customDomain: CustomDomainSummary; created: boolean }> {
  const existing = await fetchCustomDomains(
    token,
    target.projectId,
    target.environmentId,
    target.serviceId,
  );
  const match = existing.find(
    (entry) => entry.domain.toLowerCase() === target.domain.toLowerCase(),
  );
  if (match) return { customDomain: match, created: false };
  return {
    customDomain: await createCustomDomain(
      token,
      target.projectId,
      target.environmentId,
      target.serviceId,
      target.domain,
      target.targetPort,
    ),
    created: true,
  };
}
