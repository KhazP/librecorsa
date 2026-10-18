import type { Metadata } from "next";
import { Titillium_Web, Orbitron, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { withBasePath } from "@/lib/base-path";

const titillium = Titillium_Web({
  subsets: ["latin"],
  weight: ["400", "600", "700", "900"],
  style: ["normal", "italic"],
  variable: "--font-titillium",
});

const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-orbitron",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "LibreCorsa — Open-Source 500Hz Motorsport Simulator",
  description:
    "Open-source multi-class racing simulator with 500 Hz 6-DOF vehicle dynamics, active aero, GT3 & Formula cars, and WebRTC P2P multiplayer.",
  applicationName: "LibreCorsa",
  // Metadata URLs don't get the GitHub Pages base path on their own
  icons: {
    icon: [
      { url: withBasePath("/branding/librecorsa-mark.svg"), type: "image/svg+xml" },
      { url: withBasePath("/favicon.ico"), sizes: "16x16 32x32 48x48" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${titillium.variable} ${orbitron.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased bg-[#08090D] text-[#F5F7FA] selection:bg-[#CCFF00] selection:text-[#08090D]">
        {children}
      </body>
    </html>
  );
}

