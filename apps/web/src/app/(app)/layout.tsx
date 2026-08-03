import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { SignOutButton } from "@/components/sign-out-button";

const NAV = [
  { href: "/library", label: "Library" },
  { href: "/create", label: "Create" },
  { href: "/studio", label: "AI Studio" },
  { href: "/images", label: "Images" },
  { href: "/settings", label: "Settings" },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const profile = await prisma.profile.findUnique({ where: { id: session.user.id } });

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex w-full items-center justify-between border-b border-border bg-surface px-4 py-3 md:min-h-screen md:w-56 md:flex-col md:items-stretch md:justify-start md:border-b-0 md:border-r md:py-6">
        <Link href="/library" className="text-lg font-bold tracking-tight">
          Reel<span className="text-primary">Forge</span>
        </Link>
        <nav aria-label="Main" className="flex gap-1 md:mt-8 md:flex-col">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
          {profile?.isAdmin ? (
            <Link
              href="/admin"
              className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              Admin
            </Link>
          ) : null}
        </nav>
        <div className="hidden md:mt-auto md:block">
          <p className="mb-1 truncate text-xs text-muted" title={session.user.email}>
            {session.user.email}
          </p>
          <p className="mb-3 text-xs text-muted">
            Credits: <span className="text-foreground">{profile?.creditsBalance ?? 0}</span>
          </p>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
