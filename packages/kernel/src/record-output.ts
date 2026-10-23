/** The candidate-keyed delivery record is the native recorder's output.
 * Other record-neutral files remain ordinary declared validation inputs. */
import { deliveryRecordPathFor, type HarnessConfig, type ProviderRegistration } from "./config.ts";

export function recordOutputProvider(provider: ProviderRegistration, output: string): ProviderRegistration {
  const scope = provider.check?.scope;
  if (!scope || !scope.files.includes(output)) return provider;
  return { ...provider, check: { ...provider.check!, scope: { ...scope, files: scope.files.filter(file => file !== output) } } };
}

/** Bind configuration without its own output's accidental inventory entry.
 * Membership prefixes stay intact: only the exact candidate output is omitted
 * when resolving their members, never siblings or an entire neutral prefix. */
export function recordOutputConfiguration(config: HarnessConfig, deliverableDigest?: string): HarnessConfig {
  if (deliverableDigest === undefined) return config;
  const output = deliveryRecordPathFor(config, deliverableDigest);
  return { ...config, providers: config.providers.map(provider => recordOutputProvider(provider, output)) };
}
