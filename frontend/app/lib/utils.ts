import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number, decimals: number = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

export function formatPrice(price: string | number, decimals: number = 2): string {
  const numPrice = typeof price === 'string' ? parseFloat(price) : price;
  if (isNaN(numPrice)) return '0.00';
  return formatNumber(numPrice, decimals);
}

export function formatVolume(volume: string | number): string {
  const numVolume = typeof volume === 'string' ? parseFloat(volume) : volume;
  if (isNaN(numVolume)) return '0';
  
  if (numVolume >= 1_000_000_000) {
    return `${(numVolume / 1_000_000_000).toFixed(2)}B`;
  } else if (numVolume >= 1_000_000) {
    return `${(numVolume / 1_000_000).toFixed(2)}M`;
  } else if (numVolume >= 1_000) {
    return `${(numVolume / 1_000).toFixed(2)}K`;
  }
  return numVolume.toFixed(2);
}

export function formatPercentage(value: string | number, includeSign: boolean = true): string {
  const numValue = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(numValue)) return '0.00%';
  
  const formatted = numValue.toFixed(2);
  if (includeSign && numValue > 0) {
    return `+${formatted}%`;
  }
  return `${formatted}%`;
}

export function formatTime(timestamp: number, format: 'time' | 'datetime' | 'date' = 'time'): string {
  const date = new Date(timestamp);
  
  if (format === 'time') {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } else if (format === 'date') {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } else {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
}

export function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 0) return `${seconds}s ago`;
  return 'just now';
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };
    
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  
  return function executedFunction(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

export function getPriceChangeClass(change: number | string): string {
  const numChange = typeof change === 'string' ? parseFloat(change) : change;
  if (numChange > 0) return 'text-trading-buy';
  if (numChange < 0) return 'text-trading-sell';
  return 'text-text-secondary';
}

export function getPriceChangeColor(change: number | string): 'buy' | 'sell' | 'neutral' {
  const numChange = typeof change === 'string' ? parseFloat(change) : change;
  if (numChange > 0) return 'buy';
  if (numChange < 0) return 'sell';
  return 'neutral';
}

export function getMarketIcon(symbol: string): string {
  const [base = 'SOL'] = symbol.split('_');
  return base.charAt(0);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

