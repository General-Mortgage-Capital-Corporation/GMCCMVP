"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onClose: () => void;
}
interface State {
  hasError: boolean;
}

/**
 * Error boundary for modals — catches render errors and shows an inline
 * error message with a close button instead of crashing the entire app.
 */
export default class ModalErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("[ModalErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 text-center shadow-2xl">
            <p className="text-sm font-medium text-gray-800 mb-1">Something went wrong</p>
            <p className="text-xs text-gray-500 mb-4">This dialog encountered an error.</p>
            <button
              onClick={() => { this.setState({ hasError: false }); this.props.onClose(); }}
              className="rounded-md bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700"
            >
              Close
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
