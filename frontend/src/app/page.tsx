import LoadingSpinner from "@/components/LoadingSpinner";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <h1 className="text-xl font-bold text-gray-900">
            GMCC Property Search
          </h1>
          <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
            Sale Listings
          </span>
        </div>
      </header>

      {/* Main */}
      <main className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <LoadingSpinner size="lg" label="Frontend migration in progress..." />
          <p className="mt-4 text-sm text-gray-500">
            Components scaffolded. Page integration coming in Phase 3.
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white py-4 text-center text-xs text-gray-400">
        Powered by RentCast API &bull; FFIEC Census Data &bull; GMCC Program
        Matching
      </footer>
    </div>
  );
}
