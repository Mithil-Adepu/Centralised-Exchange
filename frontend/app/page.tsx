"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
    const router = useRouter();

    useEffect(() => {
        router.push("/markets");
    }, [router]);

    return (
        <div className="min-h-screen bg-backpack-bg-primary flex items-center justify-center">
            <div className="text-center">
                <div className="w-16 h-16 bg-gradient-to-br from-[#00FFA3] to-[#DC1FFF] rounded-lg flex items-center justify-center mx-auto mb-4">
                    <span className="text-white font-bold text-2xl">B</span>
                </div>
                <p className="text-bp-text-secondary">Redirecting to markets...</p>
            </div>
        </div>
    );
}