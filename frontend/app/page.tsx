"use client";

import { useEffect, useState } from "react";
import { TranscriberApp } from "@/components/TranscriberApp";

/**
 * The app is rendered on the client only: it depends on the desktop bridge,
 * saved preferences and the OS locale data (Intl), none of which exist at
 * build time. Rendering it during static export would cause hydration mismatches.
 */
export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <TranscriberApp /> : null;
}
