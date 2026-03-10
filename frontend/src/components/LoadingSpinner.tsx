interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  label?: string;
}

const SIZES = {
  sm: "h-4 w-4 border-2",
  md: "h-8 w-8 border-2",
  lg: "h-12 w-12 border-3",
};

export default function LoadingSpinner({
  size = "md",
  label,
}: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`animate-spin rounded-full border-gray-300 border-t-blue-600 ${SIZES[size]}`}
        role="status"
        aria-label={label ?? "Loading"}
      />
      {label && (
        <span className="text-sm text-gray-500">{label}</span>
      )}
    </div>
  );
}
