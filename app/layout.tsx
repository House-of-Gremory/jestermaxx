import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jester Maxing',
  description: 'A p2p jester fighter ',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
