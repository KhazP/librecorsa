import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { withBasePath } from "@/lib/base-path";

/*
 * The UI fonts ship with the app (Latin subsets, as Google Fonts serves them; SIL OFL 1.1, licences in ./fonts).
 * next/font/google fetched them at build time, and its Turbopack loader cannot take Google's newer
 * `/l/font?kit=…&skey=…` file URLs, so a build depended on what Google happened to return that day.
 */
const titillium = localFont({
  src: [
    { path: "./fonts/titillium-web-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/titillium-web-400-italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/titillium-web-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/titillium-web-600-italic.woff2", weight: "600", style: "italic" },
    { path: "./fonts/titillium-web-700.woff2", weight: "700", style: "normal" },
    { path: "./fonts/titillium-web-700-italic.woff2", weight: "700", style: "italic" },
    { path: "./fonts/titillium-web-900.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-titillium",
  display: "swap",
});

// Variable fonts: one file serves every weight
const orbitron = localFont({
  src: "./fonts/orbitron-variable.woff2",
  weight: "700 900",
  variable: "--font-orbitron",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-variable.woff2",
  weight: "500 800",
  variable: "--font-jetbrains",
  display: "swap",
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

