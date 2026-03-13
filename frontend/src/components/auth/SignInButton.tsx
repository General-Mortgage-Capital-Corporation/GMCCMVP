"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";

export default function SignInButton() {
  const { user, loading, signIn, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);
    try {
      await signIn();
    } catch {
      setError("Sign-in failed. Make sure pop-ups are allowed.");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <LoadingSpinner size="sm" />
        <span>Signing in…</span>
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600 hidden sm:block">{user.displayName}</span>
        <button
          onClick={signOut}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleSignIn}
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
      >
        {/* Microsoft logo */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="7.5" height="7.5" fill="#F25022"/>
          <rect x="8.5" y="0" width="7.5" height="7.5" fill="#7FBA00"/>
          <rect x="0" y="8.5" width="7.5" height="7.5" fill="#00A4EF"/>
          <rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#FFB900"/>
        </svg>
        Sign in with Microsoft
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
