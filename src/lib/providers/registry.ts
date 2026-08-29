import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import { createLogger } from "@/lib/core/logger";
import { ComfyUiProvider } from "./comfyui/comfyui-provider";
import { MockProvider } from "./mock/mock-provider";
import { RemoteWorkerProvider } from "./remote-worker/remote-worker-provider";
import type { ProviderHealth, VideoProvider } from "./types";

const log = createLogger("providers");

/**
 * Provider registry.
 *
 * Adding a backend: implement `VideoProvider`, register it here, done. Nothing
 * in the director, planner, compiler, jobs or UI needs to know it exists.
 */
const providers = new Map<string, VideoProvider>();

function register(provider: VideoProvider): void {
  providers.set(provider.capabilities.id, provider);
}

register(new MockProvider());
register(new ComfyUiProvider());
register(new RemoteWorkerProvider());

export function getProvider(id?: string): VideoProvider {
  const resolved = id ?? getEnv().VIDEO_PROVIDER;
  const provider = providers.get(resolved);
  if (!provider) {
    throw new StudioError("PROVIDER_NOT_CONFIGURED", `Unknown video provider "${resolved}".`, {
      remedy: `Set VIDEO_PROVIDER to one of: ${listProviderIds().join(", ")}.`,
    });
  }
  return provider;
}

export function listProviders(): VideoProvider[] {
  return Array.from(providers.values());
}

export function listProviderIds(): string[] {
  return Array.from(providers.keys());
}

/**
 * Resolves the provider to actually use.
 *
 * When the configured provider is unavailable the behaviour is governed by
 * `ALLOW_MOCK_FALLBACK` (default: on in development, off in production):
 *
 *  - **on**  — degrade to the mock with a loud, explicit reason, so a developer
 *    with no GPU can still exercise the whole pipeline.
 *  - **off** — refuse. A user who asked for AI video must not silently receive
 *    a placeholder; the job fails with the provider's own remedy attached.
 */
export async function resolveProvider(preferredId?: string): Promise<{
  provider: VideoProvider;
  health: ProviderHealth;
  fellBack: boolean;
  fallbackReason?: string;
}> {
  const preferred = getProvider(preferredId);
  const health = await preferred.health();

  if (health.available) return { provider: preferred, health, fellBack: false };

  // The mock has nothing to fall back to, and is always "available" anyway.
  if (preferred.capabilities.id === "mock") {
    return { provider: preferred, health, fellBack: false };
  }

  if (!getEnv().ALLOW_MOCK_FALLBACK) {
    log.error("Configured provider unavailable and mock fallback is disabled.", {
      provider: preferred.capabilities.id,
      detail: health.detail,
    });
    throw new StudioError(
      preferred.capabilities.requiresGpu ? "GPU_REQUIRED" : "PROVIDER_NOT_CONFIGURED",
      `${preferred.capabilities.label} is not available: ${health.detail}`,
      {
        remedy:
          health.remedy ??
          "Fix the provider, or set ALLOW_MOCK_FALLBACK=true to accept placeholder output instead.",
      },
    );
  }

  log.warn("Configured provider unavailable; falling back to mock.", {
    provider: preferred.capabilities.id,
    detail: health.detail,
  });

  const mock = getProvider("mock");
  return {
    provider: mock,
    health: await mock.health(),
    fellBack: true,
    fallbackReason: `${preferred.capabilities.label} is not available: ${health.detail}${
      health.remedy ? ` ${health.remedy}` : ""
    } Using the development provider instead — the output will be a placeholder, not AI video.`,
  };
}

/** Health of every registered provider, for the UI's provider panel. */
export async function providerStatuses(): Promise<
  Array<{ id: string; label: string; capabilities: VideoProvider["capabilities"]; health: ProviderHealth }>
> {
  return Promise.all(
    listProviders().map(async (p) => ({
      id: p.capabilities.id,
      label: p.capabilities.label,
      capabilities: p.capabilities,
      health: await p.health().catch((error: unknown) => ({
        available: false,
        detail: `Health check threw: ${(error as Error).message}`,
      })),
    })),
  );
}

export { ComfyUiProvider, MockProvider, RemoteWorkerProvider };
export * from "./types";
