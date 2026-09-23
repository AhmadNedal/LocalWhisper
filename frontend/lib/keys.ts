/** What the settings fields show: the user's own key, and whether a built-in key exists. */
export async function keyState(name: string): Promise<{ stored: string; builtin: boolean }> {
  const d = typeof window !== "undefined" ? window.desktop : undefined;
  if (!d) return { stored: "", builtin: false };
  const stored = d.getStoredSecret ? await d.getStoredSecret(name) : await d.getSecret(name);
  const builtin = d.hasBuiltinSecret ? await d.hasBuiltinSecret(name) : false;
  return { stored: stored ?? "", builtin: Boolean(builtin) };
}
