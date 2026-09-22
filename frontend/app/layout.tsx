import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local Transcriber",
  description: "Private, offline transcription with faster-whisper",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Arabic/RTL by default; TranscriberApp switches lang/dir at runtime.
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
