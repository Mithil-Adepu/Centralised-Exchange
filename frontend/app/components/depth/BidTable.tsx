import { formatPrice } from "@/app/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   BidTable — Buy Side of the Order Book
   Green-tinted depth bars grow right-to-left.
   ═══════════════════════════════════════════════════════════════ */

interface BidTableProps {
  bids: [string, string][];
  /** Callback when a price row is clicked */
  onPriceClick?: (price: string) => void;
}

export const BidTable = ({ bids, onPriceClick }: BidTableProps) => {
  /* ─── Calculate cumulative totals ─── */
  let currentTotal = 0;
  const bidsWithTotal: [string, string, number][] = bids.map(
    ([price, quantity]) => {
      currentTotal += Number(quantity);
      return [price, quantity, currentTotal];
    }
  );

  const maxTotal = currentTotal;

  return (
    <div className="flex flex-col">
      {bidsWithTotal.map(([price, quantity, total]) => (
        <BidRow
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


/* ─── Single Bid Row ─── */
function BidRow({
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
        className="absolute top-0 right-0 h-full bg-bp-green-bg transition-[width] duration-100"
        style={{ width: `${fillPercent}%` }}
      />

      {/* Data Row */}
      <div className="relative grid grid-cols-3 px-3 py-[3px] text-xs group-hover:bg-bp-bg-hover">
        <div className="text-bp-green tabular-nums">
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