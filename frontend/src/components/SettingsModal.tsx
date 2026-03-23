"use client";

import { useRef, useState, useEffect } from "react";
import SignatureEditor from "./SignatureEditor";
import { getHeadshot, setHeadshot, clearHeadshot } from "@/lib/headshot-store";

interface SettingsModalProps {
  onClose: () => void;
}

function HeadshotUpload() {
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(getHeadshot());
  }, []);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      alert("Image must be under 500 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setHeadshot(dataUrl);
      setPreview(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleRemove() {
    clearHeadshot();
    setPreview(null);
  }

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Profile Headshot
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Used on the Home Financing Options flyer. Max 500 KB.
      </p>
      <div className="flex items-center gap-4">
        {preview ? (
          <div className="relative">
            <img src={preview} alt="Headshot" className="h-16 w-16 rounded-full border-2 border-red-500 object-cover" />
            <button
              onClick={handleRemove}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow hover:bg-red-600"
              title="Remove headshot"
            >
              <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-gray-300 text-gray-300">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="8" r="4" />
              <path d="M20 21c0-4.4-3.6-8-8-8s-8 3.6-8 8" />
            </svg>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {preview ? "Replace Photo" : "Upload Photo"}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFile} />
        </div>
      </div>
    </div>
  );
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-800">Settings</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[75vh] space-y-6 overflow-y-auto p-5">
          <HeadshotUpload />
          <div className="border-t border-gray-200 pt-4">
            <SignatureEditor />
          </div>
        </div>
      </div>
    </div>
  );
}
