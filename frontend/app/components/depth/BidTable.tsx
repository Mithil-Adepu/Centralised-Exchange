import { formatPrice } from "@/app/lib/utils";

export const BidTable = ({ bids }: { bids: [string, string][] }) => {
    let currentTotal = 0;
    const bidsWithTotal: [string, string, number][] = bids.map(([price, quantity]) => {
        currentTotal += Number(quantity);
        return [price, quantity, currentTotal];
    });
    
    const maxTotal = currentTotal;

    return (
        <div className="flex flex-col">
            {bidsWithTotal?.map(([price, quantity, total]) => (
                <Bid
                    maxTotal={maxTotal}
                    total={total}
                    key={price}
                    price={price}
                    quantity={quantity}
                />
            ))}
        </div>
    );
};

function Bid({ price, quantity, total, maxTotal }: { price: string, quantity: string, total: number, maxTotal: number }) {
    const percentage = maxTotal > 0 ? (100 * total) / maxTotal : 0;

    return (
        <div className="relative group hover:bg-backpack-bg-tertiary">
            {/* Background Bar */}
            <div
                className="absolute top-0 right-0 h-full bg-bp-green/10"
                style={{ width: `${percentage}%` }}
            />

            {/* Content */}
            <div className="relative grid grid-cols-3 px-4 py-[5px] text-xs">
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