import { formatPrice } from "@/app/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   AskTable — Sell Side of the Order Book
   Red-tinted depth bars grow right-to-left.
   ═══════════════════════════════════════════════════════════════ */

interface AskTableProps {
  asks: [string, string][];
  /** Callback when a price row is clicked */
  onPriceClick?: (price: string) => void;
}

export const AskTable = ({ asks, onPriceClick }: AskTableProps) => {
  /* ─── Calculate cumulative totals ─── */
  let currentTotal = 0;
  const asksWithTotal: [string, string, number][] = asks.map(
    ([price, quantity]) => {
      currentTotal += Number(quantity);
      return [price, quantity, currentTotal];
    }
  );

  const maxTotal = currentTotal;

  return (
    <div className="flex flex-col">
      {asksWithTotal.map(([price, quantity, total]) => (
        <AskRow
          key={price}
          price={price}
          quantity={quantity}
          total={total}
          maxTotal={maxTotal}
          onClick={() => onPriceClick?.(price)}
        />
      ))}
    </div>
  );
};


/* ─── Single Ask Row ─── */
function AskRow({
  price,
  quantity,
  total,
  maxTotal,
  onClick,
}: {
  price: string;
  quantity: string;
  total: number;
  maxTotal: number;
  onClick?: () => void;
}) {
  const fillPercent = maxTotal > 0 ? (100 * total) / maxTotal : 0;

  return (
    <div
      className="relative group cursor-pointer"
      onClick={onClick}
    >
      {/* Depth Bar — grows from right */}
      <div
        className="absolute top-0 right-0 h-full bg-bp-red-bg transition-[width] duration-100"
        style={{ width: `${fillPercent}%` }}
      />

      {/* Data Row */}
      <div className="relative grid grid-cols-3 px-3 py-[3px] text-xs group-hover:bg-bp-bg-hover">
        <div className="text-bp-red tabular-nums">
          {formatPrice(price, 2)}
        </div>
        <div className="text-right text-bp-text-secondary tabular-nums">
          {parseFloat(quantity).toFixed(4)}
        </div>
        <div className="text-right text-bp-text-tertiary tabular-nums">
          {total.toFixed(4)}
        </div>
      </div>
    </div>
  );
}