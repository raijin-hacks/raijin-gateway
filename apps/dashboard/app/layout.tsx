import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Raijin Gateway',
  description: 'Live decisions, approvals and trust for agent payments',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <div className="flex-1">{children}</div>
        {/* Stack we built with, not which modes are live this second. */}
        <footer className="border-t border-gray-800 px-6 py-2 text-center text-xs text-gray-500">
          Built with x402 on Base Sepolia · CDP server wallet + policy · Claude as the judge
        </footer>
      </body>
    </html>
  );
}
