/**
 * Audit log for setup operations.
 *
 * Writes timestamped create/update/delete records to .setup-audit.log
 * so every change to provisioned resources is traceable.
 */
import { appendFileSync } from 'node:fs';
import { toolPath } from '@setup/common/paths.js';

const AUDIT_LOG_PATH = toolPath('.setup-audit.log');

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'SKIP' | 'ERROR';

export interface AuditEntry {
  action: AuditAction;
  provider: string;
  resource: string;
  detail: string;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Write a single entry to the audit log.
 */
export function logAudit(entry: AuditEntry): void {
  const line = `[${formatTimestamp()}] ${entry.action.padEnd(6)} ${entry.provider.padEnd(20)} ${entry.resource.padEnd(30)} → ${entry.detail}\n`;
  try {
    appendFileSync(AUDIT_LOG_PATH, line, 'utf-8');
  } catch {
    // audit log is best-effort, don't crash if disk is full
  }
}

/**
 * Convenience helpers for common actions.
 */
export function auditCreate(provider: string, resource: string, detail: string): void {
  logAudit({ action: 'CREATE', provider, resource, detail });
}

export function auditUpdate(provider: string, resource: string, detail: string): void {
  logAudit({ action: 'UPDATE', provider, resource, detail });
}

export function auditDelete(provider: string, resource: string, detail: string): void {
  logAudit({ action: 'DELETE', provider, resource, detail });
}

export function auditSkip(provider: string, resource: string, detail: string): void {
  logAudit({ action: 'SKIP', provider, resource, detail });
}

export function auditError(provider: string, resource: string, detail: string): void {
  logAudit({ action: 'ERROR', provider, resource, detail });
}
