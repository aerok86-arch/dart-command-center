import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'DART Command Center',
  description: '전자공시 종합 관리',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ height: '100vh', overflow: 'hidden' }}>{children}</body>
    </html>
  )
}
