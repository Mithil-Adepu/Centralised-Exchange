import { create } from 'zustand';

interface MarketStore {
    selectedMarket: string;
    setSelectedMarket: (market: string) => void;
    favorites: string[];
    toggleFavorite: (market: string) => void;
    isFavorite: (market: string) => boolean;
}

export const useMarketStore = create<MarketStore>((set, get) => ({
    selectedMarket: 'SOL_USD',
    setSelectedMarket: (market: string) => set({ selectedMarket: market }),
    favorites: [],
    toggleFavorite: (market: string) => set((state) => ({
        favorites: state.favorites.includes(market)
            ? state.favorites.filter((m) => m !== market)
            : [...state.favorites, market]
    })),
    isFavorite: (market: string) => get().favorites.includes(market),
}));
