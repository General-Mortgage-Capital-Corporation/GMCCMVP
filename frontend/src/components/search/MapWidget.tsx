"use client";

import { useEffect, useRef, useCallback } from "react";
import { fetchMapsKey } from "@/lib/api";

interface MapWidgetProps {
  radius: number;
  searchType: "area" | "specific";
  /** Called when the user clicks/drags the map marker */
  onMarkerPlace: (lat: number, lng: number, address: string) => void;
  /** Called with the current marker lat/lng so the parent can include it in searches */
  onLatLngChange: (lat: number | undefined, lng: number | undefined) => void;
  /** Forward-geocode trigger: when the typed address changes the map should pan */
  query: string;
}

// Module-level flag so the script is only injected once across mounts
let mapsLoadPromise: Promise<void> | null = null;

function loadMapsApi(apiKey: string): Promise<void> {
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject();
    if ((window as unknown as Record<string, unknown>).google) {
      resolve();
      return;
    }
    const cb = `__gmccMapsReady_${Date.now()}`;
    (window as unknown as Record<string, unknown>)[cb] = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=${cb}&libraries=marker`;
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(s);
  });
  return mapsLoadPromise;
}

type GoogleMaps = typeof google.maps;
type GoogleMap = google.maps.Map;
type GoogleGeocoder = google.maps.Geocoder;
type GoogleCircle = google.maps.Circle;
type GoogleAdvancedMarker = google.maps.marker.AdvancedMarkerElement;

export default function MapWidget({
  radius,
  searchType,
  onMarkerPlace,
  onLatLngChange,
  query,
}: MapWidgetProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const markerRef = useRef<GoogleAdvancedMarker | null>(null);
  const circleRef = useRef<GoogleCircle | null>(null);
  const geocoderRef = useRef<GoogleGeocoder | null>(null);
  const initDoneRef = useRef(false);
  const lastQueryRef = useRef("");

  const updateCircle = useCallback(
    (maps: GoogleMaps, map: GoogleMap, pos: google.maps.LatLng) => {
      circleRef.current?.setMap(null);
      circleRef.current = null;
      if (searchType === "specific") return;
      circleRef.current = new maps.Circle({
        map,
        center: pos,
        radius: radius * 1609.34,
        fillColor: "#3b82f6",
        fillOpacity: 0.08,
        strokeColor: "#3b82f6",
        strokeOpacity: 0.4,
        strokeWeight: 1.5,
        clickable: false,
      });
    },
    [radius, searchType],
  );

  const placeMarker = useCallback(
    (maps: GoogleMaps, map: GoogleMap, lat: number, lng: number) => {
      if (markerRef.current) {
        markerRef.current.map = null;
      }
      const pos = new maps.LatLng(lat, lng);
      const marker = new maps.marker.AdvancedMarkerElement({
        position: pos,
        map,
        gmpDraggable: true,
      });
      markerRef.current = marker;
      onLatLngChange(lat, lng);
      updateCircle(maps, map, pos);

      marker.addListener("dragend", () => {
        const p = marker.position as google.maps.LatLng;
        const dlat = typeof p.lat === "function" ? p.lat() : (p as unknown as {lat: number}).lat;
        const dlng = typeof p.lng === "function" ? p.lng() : (p as unknown as {lng: number}).lng;
        onLatLngChange(dlat, dlng);
        updateCircle(maps, map, new maps.LatLng(dlat, dlng));
        geocoderRef.current?.geocode({ location: { lat: dlat, lng: dlng } }, (results, status) => {
          if (status === "OK" && results?.[0]) {
            const addr = results[0].formatted_address.replace(/,\s*USA$/, "");
            onMarkerPlace(dlat, dlng, addr);
          }
        });
      });
    },
    [onLatLngChange, onMarkerPlace, updateCircle],
  );

  // Initialise map once API is loaded
  useEffect(() => {
    if (initDoneRef.current || !divRef.current) return;

    fetchMapsKey()
      .then(({ key }) => loadMapsApi(key))
      .then(() => {
        if (!divRef.current) return;
        initDoneRef.current = true;
        const maps = window.google.maps;
        const map = new maps.Map(divRef.current, {
          center: { lat: 39.8283, lng: -98.5795 },
          zoom: 4,
          mapId: "DEMO_MAP_ID",
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        mapRef.current = map;
        geocoderRef.current = new maps.Geocoder();

        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const lat = e.latLng.lat();
          const lng = e.latLng.lng();
          placeMarker(maps, map, lat, lng);
          geocoderRef.current?.geocode({ location: { lat, lng } }, (results, status) => {
            if (status === "OK" && results?.[0]) {
              const addr = results[0].formatted_address.replace(/,\s*USA$/, "");
              onMarkerPlace(lat, lng, addr);
            }
          });
        });
      })
      .catch(() => {
        // Maps key unavailable — widget stays hidden
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update circle when radius/searchType changes
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker || !window.google) return;
    const pos = marker.position as google.maps.LatLng;
    updateCircle(window.google.maps, map, pos);
  }, [radius, searchType, updateCircle]);

  // Forward-geocode when the typed query changes
  useEffect(() => {
    if (!query.trim() || query === lastQueryRef.current) return;
    if (!mapRef.current || !geocoderRef.current || !window.google) return;
    lastQueryRef.current = query;
    geocoderRef.current.geocode({ address: query }, (results, status) => {
      if (status === "OK" && results?.[0] && mapRef.current) {
        const loc = results[0].geometry.location;
        const lat = loc.lat();
        const lng = loc.lng();
        mapRef.current.setCenter({ lat, lng });
        mapRef.current.setZoom(12);
        placeMarker(window.google.maps, mapRef.current, lat, lng);
      }
    });
  }, [query, placeMarker]);

  return (
    <div className="mt-3">
      <div
        ref={divRef}
        className="h-72 w-full rounded-lg border border-gray-200 bg-gray-100"
      />
      <p className="mt-1 text-center text-xs text-gray-400">
        Click map to pin location · Drag marker to adjust
      </p>
    </div>
  );
}
