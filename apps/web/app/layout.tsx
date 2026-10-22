import './globals.css';
import type { Metadata } from 'next';
import { QueryProvider } from '@/components/query-provider';
import { AuthProvider } from '@/components/auth-provider';
import { Header } from '@/components/header';
import { AuthGate } from '@/components/auth-gate';

export const metadata: Metadata = {
  title: 'Baton - Human-Agent 협업 및 업무 인계 플랫폼',
  description: '사람과 AI 에이전트가 함께 작업을 이어받고 전달하는 협업 플랫폼'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full bg-slate-50">
      <body className="h-full font-sans antialiased text-slate-900 selection:bg-indigo-500 selection:text-white">
        <QueryProvider>
          <AuthProvider>
            <AuthGate>
              <div className="min-h-full flex flex-col">
                <Header />
                <div className="flex-1">{children}</div>
              </div>
            </AuthGate>
          </AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
