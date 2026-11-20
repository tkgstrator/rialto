// An additional API key gets its own routing ID under the vendor.
export function apiKeyProviderBaseName(name: string): string {
  return name.replace(/-key-[a-f0-9]{32}$/, '')
}
