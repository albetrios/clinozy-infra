/**
 * Classify provisioner errors that retrying the same step cannot fix without editing
 * `.setup/.setup-credentials` or setup.config.json first.
 */
export function isNonRecoverableProvisionerError(message: string): boolean {
  return /(?:AWS credentials rejected|AWS credentials invalid|Access Key Id you provided does not exist|InvalidAccessKeyId|SignatureDoesNotMatch|UnrecognizedClient|security token included in the request is invalid|Neon org_id is required|NEON_ORG_ID)/i.test(
    message,
  );
}
