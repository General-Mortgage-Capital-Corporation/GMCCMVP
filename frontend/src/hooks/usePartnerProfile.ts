"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { authedFetch } from "@/lib/authed-fetch";

/**
 * The signed-in partner's own record (as saved by their LO in the portal),
 * for prefilling flyer realtor fields. Returns null for LO sessions and
 * while loading. Cached module-wide — the record only changes when the LO
 * edits it in the portal, so once per page load is plenty.
 */

export type PartnerProfile = {
  partner: {
    id: string;
    name: string;
    email: string;
    phone: string;
    title: string;
    license: string;
    imageUrl: string | null;
  };
  mlo: { email: string; name: string };
};

let _cached: PartnerProfile | null = null;
let _inFlight: Promise<PartnerProfile | null> | null = null;

async function fetchProfile(): Promise<PartnerProfile | null> {
  if (_cached) return _cached;
  if (!_inFlight) {
    _inFlight = authedFetch("/api/partner/me")
      .then(async (res) => {
        if (!res.ok) return null;
        _cached = (await res.json()) as PartnerProfile;
        return _cached;
      })
      .catch(() => null)
      .finally(() => {
        _inFlight = null;
      });
  }
  return _inFlight;
}

export function usePartnerProfile(): PartnerProfile | null {
  const { user } = useAuth();
  const isPartner = user?.role === "partner";
  const [profile, setProfile] = useState<PartnerProfile | null>(_cached);

  useEffect(() => {
    if (!isPartner) return;
    let cancelled = false;
    void fetchProfile().then((p) => {
      if (!cancelled && p) setProfile(p);
    });
    return () => {
      cancelled = true;
    };
  }, [isPartner]);

  return isPartner ? profile : null;
}
