# Module 01 — Precision Math & Zero-Loss Financial Arithmetic

> **The Mathematical Bedrock of the Exchange**  
> *"In a game or a social network, rounding $0.1 + 0.2$ to $0.30000000000000004$ is an invisible cosmetic flaw. In an exchange processing millions of trades a day, that invisible fraction represents physical fiat or cryptocurrency. If your math is loose, your exchange will silently bleed capital or create money from thin air until insolvency. This module dissects every single line of `engine/src/trade/precision.ts` and `shared/src/index.ts`."*

---

## 1. The Floating-Point Fatal Flaw (IEEE 754)

Before writing a single line of exchange code, every engineer must understand why standard floating-point types (`double`, `float`, and JavaScript's default `number`) are **strictly forbidden** in financial trade matching and ledger balances.

### How Computers Store Decimals:
CPUs do not store numbers in decimal (base-10). They store numbers in binary (base-2) using the IEEE 754 floating-point standard:
$$\text{Value} = (-1)^{\text{sign}} \times (1 + \text{mantissa}) \times 2^{\text{exponent}-1023}$$

Just as $\frac{1}{3} = 0.333333\dots$ has an infinite repeating representation in base-10, numbers like $0.1$ and $0.2$ have an **infinite repeating representation in binary**:
$$0.1_{10} = 0.00011001100110011\dots_2$$

Because computers have finite bits (64 bits for `Float64`), they must truncate the repeating bits. The result:
```javascript
console.log(0.1 + 0.2);
// Output: 0.30000000000000004

console.log(0.1 + 0.2 === 0.3);
// Output: false!

console.log(100.50 * 3.7);
// Output: 371.8500000000001
```

### The Real-World Disaster Scenario:
Suppose a customer deposits $371.85 USDC and buys 3.7 SOL at $100.50.
1. The code calculates total cost using float: $100.50 \times 3.7 = 371.8500000000001$.
2. The code checks: `if (balance >= cost)` $\rightarrow$ `371.85 >= 371.8500000000001` evaluates to **`false`**!
3. The valid order is unexpectedly rejected with `"Insufficient funds"`.
4. Worse: in fee calculation, small fractional pennies are rounded up or down arbitrarily, breaking double-entry bookkeeping balances.

### The Solution: Scaled Fixed-Point Integer Representation
Instead of decimals, we scale every number into a pure whole integer by multiplying by a fixed power of 10:
$$\text{Scaled Value} = \text{Decimal Value} \times \text{SCALE}$$

In our engine:
$$\text{SCALE} = 1,000,000 = 10^6$$
- Every currency has **6 decimal places of precision** (1 micro-unit).
- Bitcoin/Solana quantities down to $0.000001$ are represented as `1`.
- $1.00\text{ USDC}$ is represented as `1000000`.
- $\$150.25\text{ USDC}$ is represented as `150250000`.
- The engine's CPU instructions perform **integer additions, subtractions, and multiplications only**. There are zero binary decimal rounding errors anywhere in the hot path.

---

## 2. Deep Dive: `engine/src/trade/precision.ts`

Let us examine every line of the implementation in `engine/src/trade/precision.ts`.

### 2.1 Scale Constants (Lines 1–3)

```typescript
export const SCALE = 1_000_000;
const SCALE_DIGITS = 6;
const SCALE_BIG = BigInt(SCALE);
```

#### Why `1_000_000`?
1. **Industry Standard**: Most crypto spot markets (Binance, Coinbase, Backpack) quote prices and trade sizes with up to 4 to 6 decimal places (e.g. SOL minimum lot size is $0.001$, minimum tick size is $\$0.01$).
2. **JavaScript Safe Integer Ceiling**:
   In JavaScript, `Number.MAX_SAFE_INTEGER` is:
   $$2^{53} - 1 = 9,007,199,254,740,991 \approx 9 \times 10^{15}$$
   With $\text{SCALE} = 10^6$, the maximum currency amount representable without losing 64-bit integer precision is:
   $$\frac{9,007,199,254,740,991}{1,000,000} \approx 9,007,199,254 \text{ units (9 Billion USDC / SOL)}$$
   This is more than sufficient for any realistic trading account without requiring the memory overhead of BigInt objects for every single struct in memory.
3. **`SCALE_BIG`**: Pre-allocates `BigInt(1000000)` once at boot so high-frequency multiplication does not allocate new BigInt constants on every fill.

---

### 2.2 `toScaledFromDecimal`: Parsing Strings to Scaled Integers (Lines 5–30)

```typescript
export function toScaledFromDecimal(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return NaN;
  }

  const negative = trimmed.startsWith("-");
  const normalized = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fracRaw = ""] = normalized.split(".");
  const whole = wholeRaw || "0";

  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fracRaw)) {
    return NaN;
  }

  const frac = (fracRaw + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  const wholeInt = Number(whole);
  const fracInt = Number(frac || "0");

  if (!Number.isFinite(wholeInt) || !Number.isFinite(fracInt)) {
    return NaN;
  }

  const scaled = wholeInt * SCALE + fracInt;
  return negative ? -scaled : scaled;
}
```

#### Line-by-Line Breakdown:
- **Line 6–9: Sanitization**: `value.trim()` strips leading/trailing whitespace. If empty, immediately returns `NaN`.
- **Line 11–12: Negative Sign Extraction**: Detects `"-"` prefix, saves the flag `negative`, and slices it off. We parse the magnitude first, then reapply the sign at the end.
- **Line 13–14: Decimal Splitting**:
  `normalized.split(".")`:
  - Input `"150.25"` $\rightarrow$ `wholeRaw = "150"`, `fracRaw = "25"`.
  - Input `"150"` $\rightarrow$ `wholeRaw = "150"`, `fracRaw = ""`.
  - Input `".5"` $\rightarrow$ `wholeRaw = ""`, `fracRaw = "5"`, `whole = "0"`.
- **Line 16–18: Regex Defense Against Malformed Input**:
  `!/^\d+$/.test(whole) || !/^\d*$/.test(fracRaw)`
  - Rejects exponential notation like `"1e6"`, garbage characters like `"100.5a"`, or multiple decimal points like `"100.5.2"`.
- **Line 20: The Padding & Truncation Mechanism**:
  ```typescript
  const frac = (fracRaw + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  ```
  This single line performs two crucial operations:
  1. **Right-Padding with Zeros**:
     If `fracRaw = "5"` (representing $0.5$):
     `"5" + "000000" = "5000000"`.
     `.slice(0, 6)` extracts `"500000"`.
     Converted to integer: $500,000$.
     $500,000 / 1,000,000 = 0.5$. Correct!
  2. **Truncation Beyond Precision**:
     If `fracRaw = "123456789"` (8 decimals):
     `"123456789" + "000000" = "123456789000000"`.
     `.slice(0, 6)` extracts `"123456"`.
     Sub-satoshi digits are **truncated, not rounded up**.
     *Why truncate?* Financial exchanges never allow buyers or sellers to trade at sub-tick fractions that would give unfair execution priority over resting orders.
- **Line 28–29: Final Integer Composition**:
  `wholeInt * SCALE + fracInt`.
  For `"150.25"`:
  $150 \times 1,000,000 + 250,000 = 150,250,000$.
  Returns `150250000`.

---

### 2.3 `fromScaledToDecimal`: Converting Scaled Integers Back to Human Strings (Lines 32–53)

```typescript
export function fromScaledToDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / SCALE);
  const frac = abs % SCALE;
  const sign = negative ? "-" : "";

  if (frac === 0) {
    return `${sign}${whole}`;
  }

  const fracStr = frac
    .toString()
    .padStart(SCALE_DIGITS, "0")
    .replace(/0+$/, "");

  return `${sign}${whole}.${fracStr}`;
}
```

#### Line-by-Line Breakdown:
- **Line 38–40: Math Division & Remainder**:
  Suppose `value = 150250000`:
  - `whole = Math.floor(150250000 / 1000000) = 150`.
  - `frac = 150250000 % 1000000 = 250000`.
- **Line 43–45: Clean Whole Numbers**:
  If `frac === 0` (e.g. `150000000`), returns directly `"150"` without unnecessary trailing `.0`.
- **Line 47–50: Fractional Normalization**:
  1. `frac.toString()`: `"250000"`.
  2. `.padStart(SCALE_DIGITS, "0")`: Ensures leading zeros are preserved.
     *Example*: If `frac = 50` (meaning $0.000050$):
     `"50".padStart(6, "0")` $\rightarrow$ `"000050"`. Without `padStart`, this would erroneously become `"50"` ($0.5$)!
  3. `.replace(/0+$/, "")`: Strips trailing zeros for concise display:
     `"250000"` $\rightarrow$ `"25"`.
     Result: `"150.25"`.

---

### 2.4 `multiplyScaled`: Safe Scaled Multiplication (Lines 79–81)

When multiplying two scaled numbers, you encounter a fundamental algebraic scaling problem:

$$\text{Let } x = A \times \text{SCALE}, \quad y = B \times \text{SCALE}$$
$$\text{If you multiply them directly: } x \times y = A \times B \times \text{SCALE}^2$$

The result is scaled by $\text{SCALE}^2$ ($10^{12}$), not $\text{SCALE}$ ($10^6$)! To restore the correct scale, you must divide by $\text{SCALE}$:
$$\text{Result} = \frac{x \times y}{\text{SCALE}} = A \times B \times \text{SCALE}$$

#### The Integer Overflow Trap:
Suppose you calculate the cost of buying $10,000$ SOL at $\$150$:
- Quantity $x = 10,000 \times 1,000,000 = 10,000,000,000$ ($10^{10}$).
- Price $y = 150 \times 1,000,000 = 150,000,000$ ($1.5 \times 10^8$).
- Standard JS Multiplication:
  $$x \times y = 10^{10} \times 1.5 \times 10^8 = 1.5 \times 10^{18}$$
- Recall `Number.MAX_SAFE_INTEGER` $\approx 9 \times 10^{15}$.
- $1.5 \times 10^{18}$ **vastly exceeds `MAX_SAFE_INTEGER`**!
- If you use native JS `(x * y) / SCALE`, JavaScript loses lower-order bit precision, silently corrupting the calculation!

#### The Code Implementation:
```typescript
export function multiplyScaled(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b)) / SCALE_BIG);
}
```
1. `BigInt(a) * BigInt(b)`: Promotes both integers to arbitrary-precision BigInt arithmetic. This can calculate numbers of arbitrary length without any loss of precision.
2. `/ SCALE_BIG`: Divides by $1,000,000\text{n}$ in BigInt space. Any fractional micro-fraction is naturally truncated towards zero.
3. `Number(...)`: Safely casts the result back to a standard JavaScript `number`, because after dividing by $10^6$, the final cost ($\$1,500,000 \times 10^6 = 1.5 \times 10^{12}$) comfortably fits within $9 \times 10^{15}$.

---

### 2.5 Scale Converters & Percent Changes (Lines 83–99)

```typescript
export function scaledToNumber(value: number): number {
  return value / SCALE;
}

export function scaleFromNumber(value: number): number {
  return Math.round(value * SCALE);
}

export function percentChangeScaled(current: number, first: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(first) || first === 0) {
    return "0";
  }

  const diff = current - first;
  const percentScaled = Number((BigInt(diff) * BigInt(10000)) / BigInt(first));
  return formatDecimalWithScale(percentScaled, 2);
}
```

- **`scaledToNumber(value)`**: Used when returning executed quantities to API callers who expect raw decimal numbers in JSON responses (e.g., `executedQty: 1.5`).
- **`scaleFromNumber(value)`**: Used when initializing test balances from whole numbers (e.g., `scaleFromNumber(1000000)` $\rightarrow$ `1000000000000`).
- **`percentChangeScaled`**: Calculates 24-hour ticker percentage price change:
  $$\text{Percent} = \frac{\text{current} - \text{first}}{\text{first}} \times 100$$
  Multiplies `diff` by `10000n` to retain 2 decimal places of percentage precision without floating-point division.

---

## 3. Sanity Bounds & Safety Invariants in `Engine.ts`

Even with scaled integers, bad actors can try to submit extreme values to cause denial-of-service or arithmetic anomalies.

In `engine/src/trade/Engine.ts` (lines 456–467), the engine enforces strict business sanity boundaries:

```typescript
const MIN_PRICE = toScaledFromDecimal("0.01");         // $0.01 minimum
const MAX_PRICE = toScaledFromDecimal("1000000");      // $1,000,000 maximum
const MIN_QUANTITY = toScaledFromDecimal("0.000001");  // 0.000001 minimum (1 micro-unit)
const MAX_QUANTITY = toScaledFromDecimal("100000");    // 100,000 maximum per order

if (numPrice < MIN_PRICE) throw new Error(`Price too low (minimum $0.01)`);
if (numPrice > MAX_PRICE) throw new Error(`Price too high (maximum $1,000,000)`);
if (numQuantity < MIN_QUANTITY) throw new Error(`Quantity too small (minimum 0.000001)`);
if (numQuantity > MAX_QUANTITY) throw new Error(`Quantity too large (maximum 100,000 per order)`);
```

### Why These Bounds Matter:
1. **Dust Attack Prevention**: A malicious bot submitting $10,000$ orders of $0.0000000001$ would flood RAM and the order book with negligible dust. `MIN_QUANTITY` guarantees every resting order represents meaningful economic value.
2. **Fat Finger Protection**: Prevents a trader from accidentally submitting a buy order at $\$10,000,000$ or quantity of $100,000,000$ SOL, which would destabilize liquidity or exhaust the number range.

---

## 4. Shared Protocol Types: `shared/src/index.ts`

The `shared/` package is the strict contract that keeps the API Gateway, Matching Engine, and WebSocket service synchronized.

### 4.1 Engine Commands (`MessageToEngine`)

```typescript
export const CREATE_ORDER = "CREATE_ORDER";
export const CANCEL_ORDER = "CANCEL_ORDER";
export const ON_RAMP = "ON_RAMP";
export const GET_OPEN_ORDERS = "GET_OPEN_ORDERS";
export const GET_TICKERS = "GET_TICKERS";
export const GET_DEPTH = "GET_DEPTH";
export const GET_BALANCES = "GET_BALANCES";

export type MessageToEngine =
  | {
    type: typeof CREATE_ORDER;
    data: {
      market: string;
      price: string;
      quantity: string;
      side: "buy" | "sell";
      userId: string;
    };
  }
  | {
    type: typeof CANCEL_ORDER;
    data: {
      orderId: string;
      market: string;
      userId: string;
    };
  }
  | {
    type: typeof ON_RAMP;
    data: {
      amount: string;
      userId: string;
      txnId?: string;
    };
  }
  | {
    type: typeof GET_DEPTH;
    data: { market: string };
  }
  | {
    type: typeof GET_OPEN_ORDERS;
    data: { userId: string; market: string };
  }
  | {
    type: typeof GET_TICKERS;
    data: { market?: string };
  }
  | {
    type: typeof GET_BALANCES;
    data: { userId: string };
  };
```

#### Key Design Observation:
Notice that `price`, `quantity`, and `amount` are passed across the network boundary as **strings** (`"150.00"`), NOT numbers!
- **Why?** JSON serialization in browsers and Node.js (`JSON.parse` / `JSON.stringify`) internally parses numbers into IEEE 754 floating-point values.
- If you transfer `"150.000001"` as a raw JSON number, standard JSON parsers may truncate or round the least significant digit before your code ever sees it.
- Passing numbers as strings guarantees zero serialization loss between HTTP, Redis, and Engine.

### 4.2 Engine Responses (`MessageToApi`)

```typescript
export type MessageToApi =
  | {
    type: "ORDER_PLACED";
    payload: {
      orderId: string;
      executedQty: number;
      fills: {
        price: string;
        qty: number;
        tradeId: number;
      }[];
    };
  }
  | {
    type: "ORDER_CANCELLED";
    payload: {
      orderId: string;
      executedQty: number;
      remainingQty: number;
    };
  }
  | {
    type: "ORDER_REJECTED";
    payload: {
      orderId?: string;
      reason: string;
    };
  }
  | {
    type: "DEPTH";
    payload: {
      bids: [string, string][]; // [price, quantity]
      asks: [string, string][];
    };
  }
  | {
    type: "BALANCES";
    payload: {
      userId: string;
      balances: Record<string, { available: number; locked: number }>;
    };
  };
```

---

## 5. Summary Checklist of Precision Rules

When writing any exchange code, memorize these 4 unbreakable rules:

1. **At the Network Boundary (HTTP/WS)**: Always receive and transmit money values as Strings (`"150.50"`).
2. **At the Engine Boundary**: Immediately convert strings to scaled integers using `toScaledFromDecimal()`.
3. **Inside the Matching Engine**: Perform integer arithmetic only. For multiplying two scaled numbers, always use `multiplyScaled()`.
4. **Before Leaving the Engine**: Convert back to formatted decimal strings using `fromScaledToDecimal()` or `scaledToNumber()`.
