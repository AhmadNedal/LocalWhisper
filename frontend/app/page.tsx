"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { TranscriberApp } from "@/components/TranscriberApp";

/**
 * The app is rendered on the client only: it depends on the desktop bridge,
 * saved preferences and the OS locale data (Intl), none of which exist at
 * build time. Rendering it during static export would cause hydration mismatches.
 */
export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Sign-in first (mandatory when the desktop shell requires it), then the app.
  return mounted ? <AuthGate>{(account) => <TranscriberApp account={account} />}</AuthGate> : null;
}
