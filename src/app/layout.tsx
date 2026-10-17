import type { Metadata } from "next";
import { Titillium_Web, Orbitron, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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
  title: "Rwanda Grand Prix — Fan Project",
  description:
    "Fan-made browser F1 racing sim on a 2026 Rwanda Grand Prix circuit at Bugesera (5.30 km, 14 turns).",
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
      <body className="antialiased selection:bg-[#E10600] selection:text-white">
        {children}
      </body>
    </html>
  );
}

