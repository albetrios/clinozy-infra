/**
 * Provider registry. Providers are looked up by name; `register()` lets presets
 * (Task 3) add new generic providers (e.g. `command`) without touching the engine.
 */
import type { Provider } from './types.js';
import { httpApiProvider } from './providers/http-api.js';
import { manualProvider } from './providers/manual.js';
import { generateProvider } from './providers/generate.js';
import { commandProvider } from './providers/command.js';
import { mockProvider, staticProvider } from './providers/constants.js';

const registry = new Map<string, Provider>();

export function register(provider: Provider): void {
  registry.set(provider.name, provider);
}

export function getProvider(name: string): Provider {
  const p = registry.get(name);
  if (!p) {
    throw new Error(`Unknown provider "${name}". Registered: ${[...registry.keys()].join(', ')}`);
  }
  return p;
}

/** Names of all registered providers (used by `doctor` / introspection). */
export function registeredProviders(): string[] {
  return [...registry.keys()];
}

// Built-in generic providers.
register(httpApiProvider);
register(manualProvider);
register(generateProvider);
register(commandProvider);
register(staticProvider);
register(mockProvider);
