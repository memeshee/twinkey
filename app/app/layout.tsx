import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TwinKey — one SS58 key, both Portaldot runtimes",
  description:
    "Connect the Portaldot wallet you already have to any Solidity dApp. TwinKey resolves your H160 from the chain and signs contract calls as native revive.call extrinsics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
