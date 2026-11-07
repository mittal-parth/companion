import { Button } from "@/components/ui/button";

/**
 * The first page of the local app. The smoke test loads it before
 * accounts, chat, or the cloud computer exist.
 */
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Companion</h1>
        <p className="text-muted-foreground">
          The local app is running. Sign-in and the cloud computer come in later
          phases.
        </p>
        <Button
          render={<a href="/api/health" />}
          nativeButton={false}
          variant="outline"
          className="w-fit"
        >
          Health
        </Button>
      </div>
    </main>
  );
}
