"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownTextProps {
  children: string;
  className?: string;
}

export default function MarkdownText({ children, className }: MarkdownTextProps) {
  return (
    <div className={`markdown-text ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h3 className="mb-2 mt-3 text-base font-bold text-gray-900 first:mt-0">{children}</h3>
          ),
          h2: ({ children }) => (
            <h4 className="mb-1.5 mt-2.5 text-sm font-bold text-gray-900 first:mt-0">{children}</h4>
          ),
          h3: ({ children }) => (
            <h5 className="mb-1 mt-2 text-sm font-semibold text-gray-800 first:mt-0">{children}</h5>
          ),
          p: ({ children }) => (
            <p className="mb-2 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          ul: ({ children }) => (
            <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-sm">{children}</li>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return (
                <code className="block overflow-x-auto rounded-md bg-gray-800 px-3 py-2 text-xs text-gray-100">
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-gray-200 px-1 py-0.5 text-xs font-mono text-gray-800">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 last:mb-0">{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-gray-300 pl-3 text-gray-600 last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-gray-200" />,
          a: ({ href, children }) => (
            <a href={href} className="text-red-600 underline hover:text-red-700" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-500">{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-gray-100">{children}</tbody>
          ),
          th: ({ children }) => (
            <th className="px-3 py-1.5 font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-gray-700">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
