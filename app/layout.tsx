import './globals.css';
import { Inter } from 'next/font/google';

// Use Inter font which is available from Google Fonts
const inter = Inter({ 
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata = {
  title: 'Azure OpenAI Voice Chat',
  description: 'Realtime audio conversation with Azure OpenAI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
