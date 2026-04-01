"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import DOMPurify from "dompurify";
import { getSignatureHtml, setSignatureHtml, clearSignature, COMPANY_NAME, COMPANY_NMLS, COMPANY_DISCLAIMER } from "@/lib/signature-store";

/**
 * Rich-text email signature editor using contentEditable.
 *
 * Supports:
 *  - Paste from Outlook/Gmail/Word (preserves formatting + images)
 *  - Basic toolbar: Bold, Italic, Underline, Link, Image upload
 *  - Save to / load from localStorage
 *
 * Content is sanitized via DOMPurify before saving to prevent XSS.
 */
export default function SignatureEditor() {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);

  // Load saved signature on mount — content is DOMPurify-sanitized on save
  useEffect(() => {
    const html = getSignatureHtml();
    if (editorRef.current && html) {
      editorRef.current.textContent = ""; // clear first
      // Safe: html was sanitized by DOMPurify before being stored
      const sanitized = DOMPurify.sanitize(html, {
        ADD_TAGS: ["img"],
        ADD_ATTR: ["src", "alt", "width", "height", "style", "href", "target"],
      });
      const template = document.createElement("template");
      template.innerHTML = sanitized;
      editorRef.current.appendChild(template.content);
      setIsEmpty(false);
    }
  }, []);

  const updateEmpty = useCallback(() => {
    const text = editorRef.current?.textContent?.trim() ?? "";
    const hasImg = editorRef.current?.querySelector("img") !== null;
    setIsEmpty(!text && !hasImg);
    setSaved(false);
  }, []);

  function execCmd(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editorRef.current?.focus();
    updateEmpty();
  }

  function handleBold() { execCmd("bold"); }
  function handleItalic() { execCmd("italic"); }
  function handleUnderline() { execCmd("underline"); }

  function handleLink() {
    const url = prompt("Enter URL:");
    if (url) execCmd("createLink", url);
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      alert("Image must be under 500 KB for email compatibility.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Load image to get natural dimensions, then insert with capped size
      const img = new Image();
      img.onload = () => {
        const maxW = 200; // standard email signature logo width
        const w = Math.min(img.naturalWidth, maxW);
        const h = Math.round((w / img.naturalWidth) * img.naturalHeight);
        // Insert as HTML to control dimensions and alignment
        document.execCommand(
          "insertHTML",
          false,
          `<img src="${dataUrl}" width="${w}" height="${h}" style="max-width:200px;height:auto;display:block;margin:4px 0" alt="Signature image" />`,
        );
        editorRef.current?.focus();
        updateEmpty();
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleSave() {
    if (!editorRef.current) return;
    // Ensure pasted images have max-width for email compatibility
    editorRef.current.querySelectorAll("img").forEach((img) => {
      if (!img.style.maxWidth) {
        img.style.maxWidth = "200px";
        img.style.height = "auto";
      }
    });
    // Sanitize with DOMPurify before persisting
    const raw = editorRef.current.innerHTML;
    const html = DOMPurify.sanitize(raw, {
      ADD_TAGS: ["img"],
      ADD_ATTR: ["src", "alt", "width", "height", "style", "href", "target"],
    });
    setSignatureHtml(html);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleClear() {
    if (!confirm("Clear your email signature?")) return;
    clearSignature();
    if (editorRef.current) editorRef.current.textContent = "";
    setIsEmpty(true);
    setSaved(false);
  }

  const btnCls =
    "inline-flex items-center justify-center h-7 w-7 rounded text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors";

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-gray-700 mb-1">Email Signature <span className="text-red-500">*</span></p>
        <p className="text-xs text-gray-500 mb-1">
          Required before sending emails. Add your name, title, and any personal branding.
        </p>
        <p className="text-[0.65rem] text-amber-600 mb-3">
          The company compliance block below is automatically included on every email and cannot be edited.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border border-gray-200 bg-gray-50 rounded-t-lg px-2 py-1">
        <button onClick={handleBold} className={btnCls} title="Bold">
          <span className="text-sm font-bold">B</span>
        </button>
        <button onClick={handleItalic} className={btnCls} title="Italic">
          <span className="text-sm italic">I</span>
        </button>
        <button onClick={handleUnderline} className={btnCls} title="Underline">
          <span className="text-sm underline">U</span>
        </button>

        <div className="mx-1 h-4 w-px bg-gray-300" />

        <button onClick={handleLink} className={btnCls} title="Insert link">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6.5 9.5l3-3M9 12l1.5-1.5a2.12 2.12 0 000-3l-1-1a2.12 2.12 0 00-3 0L5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M7 4L5.5 5.5a2.12 2.12 0 000 3l1 1a2.12 2.12 0 003 0L11 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>

        <button onClick={() => fileRef.current?.click()} className={btnCls} title="Insert image (logo, headshot, etc.)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M1 11l4-3 3 2.5 2.5-2L15 12" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleImageUpload}
        />

        <div className="flex-1" />

        <button
          onClick={handleClear}
          disabled={isEmpty}
          className="text-[0.65rem] text-gray-400 hover:text-red-500 disabled:opacity-30"
        >
          Clear
        </button>
      </div>

      {/* Editor area */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={updateEmpty}
        onPaste={updateEmpty}
        className="min-h-[120px] max-h-[300px] overflow-y-auto rounded-b-lg border border-t-0 border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1 [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded"
        data-placeholder="Paste your email signature here, or type one..."
        style={{ wordBreak: "break-word" }}
      />

      {/* Placeholder styling for empty contentEditable */}
      <style>{`
        [contenteditable][data-placeholder]:empty::before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
        }
      `}</style>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isEmpty}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40 transition-colors"
        >
          {saved ? "Saved!" : "Save Signature"}
        </button>
        {!isEmpty && !saved && (
          <span className="text-[0.65rem] text-amber-600">Unsaved changes</span>
        )}
      </div>

      {/* Company compliance block (non-editable) */}
      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 7h2v5H7V7zm0-3h2v2H7V4z" fill="#9ca3af" />
          </svg>
          <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-400">
            Company Compliance Block (auto-included)
          </span>
        </div>
        <div className="text-[0.6rem] leading-relaxed text-gray-400 whitespace-pre-line">
          <p className="font-semibold text-gray-500 mb-1">{COMPANY_NAME} | NMLS #{COMPANY_NMLS} | CA DRE #01509029</p>
          {COMPANY_DISCLAIMER.split("\n").slice(1).map((line, i) => (
            <p key={i} className={line.trim() ? "mb-1" : "mb-0"}>{line}</p>
          ))}
        </div>
      </div>
    </div>
  );
}
