import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RelayPay Support',
  description: 'Speak to RelayPay support about payments, invoicing, and payouts.',
  // The review dashboard is not for search engines, and neither is a
  // support console with live call data on it.
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="shell">
          <header className="masthead">
            <a className="logo" href="/">
              <span className="logo-mark" aria-hidden="true">RP</span>
              RelayPay
            </a>
            <span className="masthead-note">Support</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
