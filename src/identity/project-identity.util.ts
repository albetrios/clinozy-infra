/** Docker/GHCR artifact names derived from a project slug. */
export interface ProjectArtifacts {
  readonly apiImage: string;
  readonly workerImage: string;
  readonly dockerLocalApiTag: string;
  readonly ghcrCacheScopeApi: string;
  readonly ghcrCacheScopeWorker: string;
}

/** Default artifact names from a project slug (`clinozy-be` → `clinozy-be-api`, etc.). */
export function buildDefaultArtifacts(projectSlug: string): ProjectArtifacts {
  return {
    apiImage: `${projectSlug}-api`,
    workerImage: `${projectSlug}-worker`,
    dockerLocalApiTag: projectSlug,
    ghcrCacheScopeApi: `${projectSlug}-api`,
    ghcrCacheScopeWorker: `${projectSlug}-worker`,
  };
}
